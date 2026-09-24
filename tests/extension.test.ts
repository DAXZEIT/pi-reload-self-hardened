import assert from "node:assert/strict";
import test from "node:test";

import extension from "../index.ts";

// Patterns de test empruntés à clankercode/pi-reload-self (PR #1, MIT) —
// adaptés au module mono-fichier et aux durcissements 0.87.1 :
//   1. sendUserMessage → undefined ne crashe pas (comportement réel 0.87.1)
//   2. sendUserMessage → promise rejetée est absorbée (monde futur)
//   3. exception interne du handler agent_settled ne propage pas au host
//   4. balayage ABI du slot de continuation (renommage en vol) + notification
//      si un reload revient sans continuation.

const COMMAND_NAME = "pi-reload-self-hardened-run";
const TOOL_NAME = "pi_extension_dev_reload_self";
const CURRENT_SLOT = "__piReloadSelfHardenedContinuationPrompt";
const PENDING_SLOT = "__piReloadSelfHardenedPendingCommand";
const LEGACY_SLOT = "__piReloadSelfLocalContinuationPrompt";

function encode(payload: { continuationPrompt: string }): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

// Réplique fidèle du shape réel des args du handler : sur Pi 0.87.1,
// _tryExecuteExtensionCommand (agent-session.js:1336-1348) coupe au premier
// espace et passe `args = text.slice(spaceIndex + 1)` — le handler ne voit
// JAMAIS le préfixe `/<nom>`. Les tests de commande doivent passer ce shape
// (token nu), sinon ils masquent des défauts de re-dispatch (F1).
function realRuntimeArgs(fullText: string): string {
  const spaceIndex = fullText.indexOf(" ");
  return spaceIndex === -1 ? "" : fullText.slice(spaceIndex + 1);
}

interface RegisteredCommand {
  description: string;
  handler: (args: string, ctx: FakeCommandContext) => Promise<void> | void;
}

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: { continuation_prompt: string; confirm_state_loss: boolean },
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

interface FakeCommandContext {
  isIdle: () => boolean;
  reload: () => Promise<void>;
  ui?: { notify: (message: string, level: string) => void };
}

type SettledHandler = (event: unknown, ctx: { isIdle?: () => boolean; ui?: { notify: (message: string, level: string) => void } }) => unknown;
type SessionStartHandler = (event: unknown, ctx: { ui?: { notify: (message: string, level: string) => void } }) => unknown;

async function loadExtension(
  sendUserMessageImpl?: (content: string, options?: { deliverAs?: string; expandPromptTemplates?: boolean }) => unknown,
  opts?: { keepSlots?: boolean },
) {
  // keepSlots : ne pas effacer globalThis — utilisé pour simuler le runtime
  // SUIVANT qui reprend un état restauré dans globalThis (survit au reload).
  if (!opts?.keepSlots) clearSlots();

  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, RegisteredTool>();
  const sentUserMessages: Array<{
    content: string;
    options?: { deliverAs?: string; expandPromptTemplates?: boolean };
  }> = [];
  const handlers = new Map<string, Array<(...args: never[]) => unknown>>();

  const fakePi = {
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    sendUserMessage(content: string, options?: { deliverAs?: string; expandPromptTemplates?: boolean }) {
      sentUserMessages.push({ content, options });
      // Par défaut : retourne undefined, comme le binding d'extension réel de
      // Pi 0.87.1 (wrapper interne sans return) — tous les tests de dispatch
      // exercent donc ce chemin.
      return sendUserMessageImpl ? sendUserMessageImpl(content, options) : undefined;
    },
    on(name: string, handler: (...args: never[]) => unknown) {
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
    },
  };

  await extension(fakePi as never);

  return { commands, tools, sentUserMessages, handlers };
}

function clearSlots(): void {
  for (const key of Object.keys(globalThis)) {
    if (key.startsWith("__piReloadSelf")) delete (globalThis as Record<string, unknown>)[key];
  }
}

test("registers the tool and the internal command", async () => {
  const { commands, tools } = await loadExtension();
  assert.ok(commands.has(COMMAND_NAME));
  assert.ok(tools.has(TOOL_NAME));
});

test("tool refuses to queue without confirm_state_loss", async () => {
  const { tools, sentUserMessages } = await loadExtension();
  const tool = tools.get(TOOL_NAME);
  assert.ok(tool);

  const result = await tool.execute("tool-1", { continuation_prompt: "continue after reload", confirm_state_loss: false });

  assert.equal(sentUserMessages.length, 0);
  assert.match(result.content[0]?.text ?? "", /confirm_state_loss/);
  assert.deepEqual(result.details, { queued: false, reason: "missing-confirmation" });
});

test("tool queues once, dedups, and dispatches exactly once at agent_settled", async () => {
  const { commands, tools, sentUserMessages, handlers } = await loadExtension();
  const tool = tools.get(TOOL_NAME);
  const command = commands.get(COMMAND_NAME);
  const settled = handlers.get("agent_settled")?.[0] as SettledHandler | undefined;
  assert.ok(tool);
  assert.ok(command);
  assert.ok(settled);

  const result = await tool.execute("tool-1", { continuation_prompt: "  continue after reload  ", confirm_state_loss: true });
  assert.deepEqual(result.details, { queued: true, reason: "pending-agent-settled" });
  const duplicate = await tool.execute("tool-2", {
    continuation_prompt: "a second continuation must not replace the first",
    confirm_state_loss: true,
  });
  assert.deepEqual(duplicate.details, { queued: false, reason: "already-queued" });

  // Le run d'origine est encore actif : pas de dispatch.
  assert.equal(sentUserMessages.length, 0);
  await settled({}, { isIdle: () => false });
  assert.equal(sentUserMessages.length, 0);

  await settled({}, { isIdle: () => true });
  assert.equal(sentUserMessages.length, 1); // sendUserMessage → undefined : pas de crash
  assert.match(sentUserMessages[0].content, new RegExp(`^\\/${COMMAND_NAME} [A-Za-z0-9_-]+$`));
  assert.deepEqual(sentUserMessages[0].options, { deliverAs: "followUp", expandPromptTemplates: true });

  // One-shot pour cette commande en attente.
  await settled({}, { isIdle: () => true });
  assert.equal(sentUserMessages.length, 1);

  let reloaded = false;
  // Le runtime réel passerait le TOKEN NU (texte après le premier espace).
  await command.handler(realRuntimeArgs(sentUserMessages[0].content), {
    isIdle: () => true,
    reload: async () => {
      reloaded = true;
    },
  });
  assert.equal(reloaded, true);
  assert.match(result.content[0]?.text ?? "", /agent_settled/);
});

test("settled handler survives a rejecting sendUserMessage (future promise world)", async () => {
  const { tools, handlers } = await loadExtension(() => Promise.reject(new Error("send failed")));
  const settled = handlers.get("agent_settled")?.[0] as SettledHandler;
  assert.ok(settled);
  await tools.get(TOOL_NAME)?.execute("tool-1", { continuation_prompt: "continue", confirm_state_loss: true });

  await assert.doesNotReject(async () => {
    await Promise.resolve(settled({}, { isIdle: () => true }));
  });
});

test("settled handler isolates internal exceptions (no propagation to the host)", async () => {
  const { tools, handlers } = await loadExtension();
  const settled = handlers.get("agent_settled")?.[0] as SettledHandler;
  assert.ok(settled);
  await tools.get(TOOL_NAME)?.execute("tool-1", { continuation_prompt: "continue", confirm_state_loss: true });

  await assert.doesNotReject(async () => {
    await Promise.resolve(settled({}, { isIdle: () => { throw new Error("boom"); } }));
  });
});

test("command refuses to reload while the agent is not idle", async () => {
  const { commands } = await loadExtension();
  const command = commands.get(COMMAND_NAME);
  assert.ok(command);

  const notifications: Array<{ message: string; level: string }> = [];
  let reloaded = false;
  await command.handler(encode({ continuationPrompt: "continue" }), {
    isIdle: () => false,
    reload: async () => {
      reloaded = true;
    },
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  });

  assert.equal(reloaded, false);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
});

test("command reports an invalid payload without reloading", async () => {
  const { commands } = await loadExtension();
  const command = commands.get(COMMAND_NAME);
  assert.ok(command);

  const notifications: Array<{ message: string; level: string }> = [];
  let reloaded = false;
  await command.handler("not valid !!!", {
    isIdle: () => true,
    reload: async () => {
      reloaded = true;
    },
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  });

  assert.equal(reloaded, false);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "error");
});

test("command survives an invalid payload when ui is unavailable", async () => {
  const { commands } = await loadExtension();
  const command = commands.get(COMMAND_NAME);
  assert.ok(command);

  await assert.doesNotReject(async () => {
    await command.handler("not valid !!!", {
      isIdle: () => true,
      reload: async () => {
        throw new Error("reload should not run");
      },
    });
  });
});

test("command reloads and session_start delivers the continuation", async () => {
  const { commands, sentUserMessages, handlers } = await loadExtension();
  const command = commands.get(COMMAND_NAME);
  const sessionStart = handlers.get("session_start")?.[0] as SessionStartHandler | undefined;
  assert.ok(command);
  assert.ok(sessionStart);

  let reloaded = false;
  await command.handler(encode({ continuationPrompt: "continue after reload" }), {
    isIdle: () => true,
    reload: async () => {
      reloaded = true;
    },
  });
  assert.equal(reloaded, true);
  assert.equal(sentUserMessages.length, 0);

  await sessionStart({ reason: "reload" }, {});
  assert.deepEqual(sentUserMessages, [
    { content: "continue after reload", options: { deliverAs: "followUp" } },
  ]);
});

test("continuation slot scan picks up a legacy variant (in-flight rename)", async () => {
  const { sentUserMessages, handlers } = await loadExtension();
  const sessionStart = handlers.get("session_start")?.[0] as SessionStartHandler;
  assert.ok(sessionStart);

  (globalThis as Record<string, unknown>)[LEGACY_SLOT] = "continuation written by the previous version";
  await sessionStart({ reason: "reload" }, {});

  assert.deepEqual(sentUserMessages, [
    { content: "continuation written by the previous version", options: { deliverAs: "followUp" } },
  ]);
  assert.equal((globalThis as Record<string, unknown>)[LEGACY_SLOT], undefined);
});

test("continuation slot scan prefers the most recently written slot and clears all", async () => {
  const { sentUserMessages, handlers } = await loadExtension();
  const sessionStart = handlers.get("session_start")?.[0] as SessionStartHandler;
  assert.ok(sessionStart);

  (globalThis as Record<string, unknown>)[LEGACY_SLOT] = "old";
  (globalThis as Record<string, unknown>)[CURRENT_SLOT] = "new";
  await sessionStart({ reason: "reload" }, {});

  assert.deepEqual(sentUserMessages, [{ content: "new", options: { deliverAs: "followUp" } }]);
  assert.equal((globalThis as Record<string, unknown>)[LEGACY_SLOT], undefined);
  assert.equal((globalThis as Record<string, unknown>)[CURRENT_SLOT], undefined);
});

test("session_start(reload) without continuation notifies the user", async () => {
  const { handlers } = await loadExtension();
  const sessionStart = handlers.get("session_start")?.[0] as SessionStartHandler;
  assert.ok(sessionStart);

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = { ui: { notify: (message: string, level: string) => notifications.push({ message, level }) } };

  await sessionStart({ reason: "reload" }, ctx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");

  // Un simple démarrage ne doit pas alerter.
  notifications.length = 0;
  await sessionStart({ reason: "startup" }, ctx);
  assert.deepEqual(notifications, []);
});

test("command discards the continuation and notifies when reload rejects (C1)", async () => {
  const { commands } = await loadExtension();
  const command = commands.get(COMMAND_NAME);
  assert.ok(command);

  const notifications: Array<{ message: string; level: string }> = [];
  await assert.doesNotReject(async () => {
    await command.handler(encode({ continuationPrompt: "continue" }), {
      isIdle: () => true,
      reload: async () => {
        throw new Error("settings reload failed");
      },
      ui: { notify: (message, level) => notifications.push({ message, level }) },
    });
  });

  // La continuation ne doit JAMAIS survivre à un reload échoué (C1).
  assert.equal((globalThis as Record<string, unknown>)[CURRENT_SLOT], undefined);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "error");
});

test("session_start(non-reload) drops a lingering continuation without delivering it (C3)", async () => {
  const { sentUserMessages, handlers } = await loadExtension();
  const sessionStart = handlers.get("session_start")?.[0] as SessionStartHandler;
  assert.ok(sessionStart);

  (globalThis as Record<string, unknown>)[CURRENT_SLOT] = "STALE-CONTINUATION";
  const notifications: Array<{ message: string; level: string }> = [];
  await sessionStart({ reason: "new", previousSessionFile: "/tmp/other.json" }, {
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
  });

  assert.deepEqual(sentUserMessages, []);
  assert.equal((globalThis as Record<string, unknown>)[CURRENT_SLOT], undefined);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
});

test("session_start(fork) warns and clears a pending reload command (C2a)", async () => {
  const { tools, handlers } = await loadExtension();
  const sessionStart = handlers.get("session_start")?.[0] as SessionStartHandler;
  assert.ok(sessionStart);
  await tools.get(TOOL_NAME)?.execute("tool-1", { continuation_prompt: "continue", confirm_state_loss: true });

  const notifications: Array<{ message: string; level: string }> = [];
  await sessionStart({ reason: "fork" }, {
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
  });

  assert.equal((globalThis as Record<string, unknown>)[PENDING_SLOT], undefined);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
});

test("command idle-guard refusal re-queues and retries at the next settle (N1)", async () => {
  const { commands, tools, sentUserMessages, handlers } = await loadExtension();
  const command = commands.get(COMMAND_NAME);
  const settled = handlers.get("agent_settled")?.[0] as SettledHandler;
  assert.ok(command);
  assert.ok(settled);
  await tools.get(TOOL_NAME)?.execute("tool-1", { continuation_prompt: "continue", confirm_state_loss: true });

  // Première tentative : settle idle → dispatch, mais le guard refuse et
  // remet la commande en file au lieu de la jeter. Le handler reçoit le
  // shape RÉEL des args (token nu après l'espace — agent-session.js:1336-1348).
  await settled({}, { isIdle: () => true });
  assert.equal(sentUserMessages.length, 1);
  const notifications: Array<{ message: string; level: string }> = [];
  let reloaded = false;
  await command.handler(realRuntimeArgs(sentUserMessages[0].content), {
    isIdle: () => false,
    reload: async () => {
      reloaded = true;
    },
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  });
  assert.equal(reloaded, false);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  // F1 : la commande remise en file est re-dispatchable — forme
  // `/pi-reload-self-hardened-run <token>`, PAS le token nu (qui échouerait à
  // la gate `text.startsWith("/")` du runtime réel).
  const reStored = (globalThis as Record<string, unknown>)[PENDING_SLOT];
  assert.match(String(reStored), new RegExp(`^\\/${COMMAND_NAME} [A-Za-z0-9_-]+$`));

  // Second settle idle → exactement UN dispatch supplémentaire, lui aussi
  // command-shaped (le vrai Pi ne dispatche que les textes commençant par "/").
  await settled({}, { isIdle: () => true });
  assert.equal(sentUserMessages.length, 2);
  assert.match(sentUserMessages[1].content, new RegExp(`^\\/${COMMAND_NAME} [A-Za-z0-9_-]+$`));
});

test("settled handler re-stores the command when sendUserMessage throws synchronously (C2c)", async () => {
  const first = await loadExtension(() => {
    throw new Error("Extension runtime stale after session replacement");
  });
  const settled = first.handlers.get("agent_settled")?.[0] as SettledHandler;
  assert.ok(settled);
  await first.tools.get(TOOL_NAME)?.execute("tool-1", { continuation_prompt: "continue", confirm_state_loss: true });

  const notifications: Array<{ message: string; level: string }> = [];
  await assert.doesNotReject(async () => {
    await Promise.resolve(settled({}, { isIdle: () => true, ui: { notify: (message: string, level: string) => notifications.push({ message, level }) } }));
  });

  // Commande restaurée (retry au prochain settlement) + avertissement.
  // (Le fake enregistre le message AVANT que le send ne throw — seuls le
  // re-store du slot et l'avertissement prouvent que le dispatch a échoué.)
  assert.notEqual((globalThis as Record<string, unknown>)[PENDING_SLOT], undefined);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");

  // Le runtime SUIVANT (envoi normal) reprend la commande restaurée :
  // exactement un dispatch.
  const second = await loadExtension(undefined, { keepSlots: true });
  const settled2 = second.handlers.get("agent_settled")?.[0] as SettledHandler;
  assert.ok(settled2);
  await settled2({}, { isIdle: () => true });
  assert.equal(second.sentUserMessages.length, 1);
  assert.match(second.sentUserMessages[0].content, new RegExp(`^\\/${COMMAND_NAME} [A-Za-z0-9_-]+$`));
});

test("non-string legacy continuation slot is logged and cleared, nothing delivered (N2a)", async () => {
  const { sentUserMessages, handlers } = await loadExtension();
  const sessionStart = handlers.get("session_start")?.[0] as SessionStartHandler;
  assert.ok(sessionStart);

  (globalThis as Record<string, unknown>)[LEGACY_SLOT] = { prompt: "structured payload from an old version" };
  const notifications: Array<{ message: string; level: string }> = [];
  await sessionStart({ reason: "reload" }, {
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
  });

  assert.deepEqual(sentUserMessages, []);
  assert.equal((globalThis as Record<string, unknown>)[LEGACY_SLOT], undefined);
  // L'avertissement « reload sans continuation » existant couvre le cas —
  // pas de seconde notification (décision N2a).
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
});

test("idle-guard gives up after 3 refusals in the real dispatch/refusal cycle and discards the command (N1 cap)", async () => {
  const { commands, tools, sentUserMessages, handlers } = await loadExtension();
  const command = commands.get(COMMAND_NAME);
  const settled = handlers.get("agent_settled")?.[0] as SettledHandler;
  assert.ok(command);
  assert.ok(settled);
  await tools.get(TOOL_NAME)?.execute("tool-1", { continuation_prompt: "continue", confirm_state_loss: true });

  const notifications: Array<{ message: string; level: string }> = [];
  let reloaded = false;
  const ctx = {
    isIdle: () => false,
    reload: async () => {
      reloaded = true;
    },
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
  };

  // 3 cycles complets [settle → dispatch → refus] : le compteur grimpe (il
  // n'est plus remis à zéro au dispatch — F2) et la commande est remise en
  // file à chaque refus.
  for (let i = 0; i < 3; i++) {
    await settled({}, { isIdle: () => true });
    await command.handler(realRuntimeArgs(sentUserMessages[sentUserMessages.length - 1].content), ctx);
    assert.notEqual((globalThis as Record<string, unknown>)[PENDING_SLOT], undefined);
  }
  assert.equal(notifications.filter((n) => n.level === "warning").length, 3);
  assert.equal(notifications.filter((n) => n.level === "error").length, 0);

  // 4e cycle : dispatch + refus → plafond atteint — la commande est jetée
  // (error), plus de retry, jamais de 5e dispatch.
  await settled({}, { isIdle: () => true });
  assert.equal(sentUserMessages.length, 4);
  await command.handler(realRuntimeArgs(sentUserMessages[3].content), ctx);
  assert.equal(reloaded, false);
  assert.equal((globalThis as Record<string, unknown>)[PENDING_SLOT], undefined);
  assert.equal(notifications.filter((n) => n.level === "error").length, 1);

  await settled({}, { isIdle: () => true });
  assert.equal(sentUserMessages.length, 4);
});

test("settled handler caps synchronous-send re-stores and discards after 3 (F3)", async () => {
  const first = await loadExtension(() => {
    throw new Error("Extension runtime stale after session replacement");
  });
  const settled = first.handlers.get("agent_settled")?.[0] as SettledHandler;
  assert.ok(settled);
  await first.tools.get(TOOL_NAME)?.execute("tool-1", { continuation_prompt: "continue", confirm_state_loss: true });

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = { isIdle: () => true, ui: { notify: (message: string, level: string) => notifications.push({ message, level }) } };

  // 3 premiers échecs d'envoi synchrone : commande restaurée + warning.
  // (Le fake enregistre le message AVANT que le send ne throw — seuls le
  // re-store du slot et les notifications prouvent le comportement.)
  for (let i = 0; i < 3; i++) {
    await Promise.resolve(settled({}, ctx));
    assert.notEqual((globalThis as Record<string, unknown>)[PENDING_SLOT], undefined);
  }
  assert.equal(notifications.filter((n) => n.level === "warning").length, 3);
  assert.equal(notifications.filter((n) => n.level === "error").length, 0);

  // 4e échec : plafond — la commande est jetée (error), plus de retry.
  await Promise.resolve(settled({}, ctx));
  assert.equal((globalThis as Record<string, unknown>)[PENDING_SLOT], undefined);
  assert.equal(notifications.filter((n) => n.level === "error").length, 1);

  // 5e settle : rien à dispatcher (le fake n'a enregistré que les 4 échecs).
  await Promise.resolve(settled({}, ctx));
  assert.equal(first.sentUserMessages.length, 4);
});

test("command accepts the full copied command text", async () => {
  const { commands } = await loadExtension();
  const command = commands.get(COMMAND_NAME);
  assert.ok(command);

  let reloaded = false;
  await command.handler(`/${COMMAND_NAME} ${encode({ continuationPrompt: "continue" })}`, {
    isIdle: () => true,
    reload: async () => {
      reloaded = true;
    },
  });

  assert.equal(reloaded, true);
});
