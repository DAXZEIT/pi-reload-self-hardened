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
const LEGACY_SLOT = "__piReloadSelfLocalContinuationPrompt";

function encode(payload: { continuationPrompt: string }): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
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

type SettledHandler = (event: unknown, ctx: { isIdle?: () => boolean }) => unknown;
type SessionStartHandler = (event: unknown, ctx: { ui?: { notify: (message: string, level: string) => void } }) => unknown;

async function loadExtension(
  sendUserMessageImpl?: (content: string, options?: { deliverAs?: string; expandPromptTemplates?: boolean }) => unknown,
) {
  clearSlots();

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
  await command.handler(sentUserMessages[0].content, {
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
