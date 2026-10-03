import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, unlinkSync } from "node:fs";

import extension from "../index.ts";

const COMMAND_NAME = "pi-reload-self-hardened-run";
const TOOL_NAME = "pi_extension_dev_reload_self";
const RELOAD_COMMAND = `/${COMMAND_NAME}`;
const RELOAD_SUCCESS_MESSAGE = "reload successful";
const PENDING_SLOT = "__piReloadSelfHardenedPendingCommand";
const LEGACY_PENDING_SLOT = "__piReloadSelfLocalPendingCommand";

interface RegisteredCommand {
  description: string;
  handler: (args: string, ctx: FakeCommandContext) => Promise<void> | void;
}

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: { confirm_state_loss: boolean },
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

interface FakeCommandContext {
  isIdle: () => boolean;
  reload: () => Promise<void>;
  ui?: { notify: (message: string, level: string) => void };
}

type SettledHandler = (
  event: unknown,
  ctx: { isIdle?: () => boolean; ui?: { notify: (message: string, level: string) => void } },
) => unknown;

type SessionStartHandler = (
  event: unknown,
  ctx: { ui?: { notify: (message: string, level: string) => void } },
) => unknown;

async function loadExtension(
  sendUserMessageImpl?: (
    content: string,
    options?: { deliverAs?: string; expandPromptTemplates?: boolean },
  ) => unknown,
  opts?: { keepSlots?: boolean },
) {
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
    sendUserMessage(
      content: string,
      options?: { deliverAs?: string; expandPromptTemplates?: boolean },
    ) {
      sentUserMessages.push({ content, options });
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
    if (key.startsWith("__piReloadSelf")) {
      delete (globalThis as Record<string, unknown>)[key];
    }
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

  const result = await tool.execute("tool-1", { confirm_state_loss: false });

  assert.equal(sentUserMessages.length, 0);
  assert.match(result.content[0]?.text ?? "", /confirm_state_loss/);
  assert.deepEqual(result.details, { queued: false, reason: "missing-confirmation" });
});

test("tool queues once and deduplicates while a reload is pending", async () => {
  const { tools } = await loadExtension();
  const tool = tools.get(TOOL_NAME);
  assert.ok(tool);

  const first = await tool.execute("tool-1", { confirm_state_loss: true });
  const second = await tool.execute("tool-2", { confirm_state_loss: true });

  assert.deepEqual(first.details, { queued: true, reason: "pending-agent-settled" });
  assert.deepEqual(second.details, { queued: false, reason: "already-queued" });
  assert.equal((globalThis as Record<string, unknown>)[PENDING_SLOT], RELOAD_COMMAND);
});

test("agent_settled waits for idle and dispatches exactly once", async () => {
  const { tools, sentUserMessages, handlers } = await loadExtension();
  const settled = handlers.get("agent_settled")?.[0] as SettledHandler;
  assert.ok(settled);
  await tools.get(TOOL_NAME)?.execute("tool-1", { confirm_state_loss: true });

  await settled({}, { isIdle: () => false });
  assert.equal(sentUserMessages.length, 0);

  await settled({}, { isIdle: () => true });
  assert.deepEqual(sentUserMessages, [
    { content: RELOAD_COMMAND, options: { deliverAs: "followUp", expandPromptTemplates: true } },
  ]);

  await settled({}, { isIdle: () => true });
  assert.equal(sentUserMessages.length, 1);
});

test("agent_settled survives an undefined sendUserMessage return", async () => {
  const { tools, handlers } = await loadExtension();
  const settled = handlers.get("agent_settled")?.[0] as SettledHandler;
  assert.ok(settled);
  await tools.get(TOOL_NAME)?.execute("tool-1", { confirm_state_loss: true });

  await assert.doesNotReject(async () => {
    await Promise.resolve(settled({}, { isIdle: () => true }));
  });
});

test("agent_settled survives a rejecting sendUserMessage promise", async () => {
  const { tools, handlers } = await loadExtension(() => Promise.reject(new Error("send failed")));
  const settled = handlers.get("agent_settled")?.[0] as SettledHandler;
  assert.ok(settled);
  await tools.get(TOOL_NAME)?.execute("tool-1", { confirm_state_loss: true });

  await assert.doesNotReject(async () => {
    await Promise.resolve(settled({}, { isIdle: () => true }));
  });
});

test("agent_settled re-stores after a synchronous send failure", async () => {
  const { tools, handlers } = await loadExtension(() => {
    throw new Error("stale runtime");
  });
  const settled = handlers.get("agent_settled")?.[0] as SettledHandler;
  assert.ok(settled);
  await tools.get(TOOL_NAME)?.execute("tool-1", { confirm_state_loss: true });

  const notifications: Array<{ message: string; level: string }> = [];
  await settled({}, {
    isIdle: () => true,
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  });

  assert.equal((globalThis as Record<string, unknown>)[PENDING_SLOT], RELOAD_COMMAND);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
});

test("agent_settled caps synchronous-send retries", async () => {
  const { tools, handlers } = await loadExtension(() => {
    throw new Error("send unavailable");
  });
  const settled = handlers.get("agent_settled")?.[0] as SettledHandler;
  assert.ok(settled);
  await tools.get(TOOL_NAME)?.execute("tool-1", { confirm_state_loss: true });

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    isIdle: () => true,
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
  };

  for (let i = 0; i < 3; i++) {
    await settled({}, ctx);
    assert.equal((globalThis as Record<string, unknown>)[PENDING_SLOT], RELOAD_COMMAND);
  }

  await settled({}, ctx);
  assert.equal((globalThis as Record<string, unknown>)[PENDING_SLOT], undefined);
  assert.equal(notifications.filter((n) => n.level === "warning").length, 3);
  assert.equal(notifications.filter((n) => n.level === "error").length, 1);
});

test("agent_settled handler isolates internal exceptions", async () => {
  const { tools, handlers } = await loadExtension();
  const settled = handlers.get("agent_settled")?.[0] as SettledHandler;
  assert.ok(settled);
  await tools.get(TOOL_NAME)?.execute("tool-1", { confirm_state_loss: true });

  await assert.doesNotReject(async () => {
    await Promise.resolve(settled({}, { isIdle: () => { throw new Error("boom"); } }));
  });
});

test("command reloads successfully when idle", async () => {
  const { commands } = await loadExtension();
  const command = commands.get(COMMAND_NAME);
  assert.ok(command);

  let reloaded = false;
  await command.handler("", {
    isIdle: () => true,
    reload: async () => { reloaded = true; },
  });

  assert.equal(reloaded, true);
});

test("command re-queues when the agent is no longer idle", async () => {
  const { commands } = await loadExtension();
  const command = commands.get(COMMAND_NAME);
  assert.ok(command);

  await command.handler("", {
    isIdle: () => false,
    reload: async () => {},
  });

  assert.equal((globalThis as Record<string, unknown>)[PENDING_SLOT], RELOAD_COMMAND);
});

test("command idle-guard gives up after 3 refusals", async () => {
  const { commands } = await loadExtension();
  const command = commands.get(COMMAND_NAME);
  assert.ok(command);

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    isIdle: () => false,
    reload: async () => { throw new Error("must not reload"); },
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
  };

  for (let i = 0; i < 3; i++) {
    await command.handler("", ctx);
    assert.equal((globalThis as Record<string, unknown>)[PENDING_SLOT], RELOAD_COMMAND);
    delete (globalThis as Record<string, unknown>)[PENDING_SLOT];
  }

  await command.handler("", ctx);
  assert.equal((globalThis as Record<string, unknown>)[PENDING_SLOT], undefined);
  assert.equal(notifications.filter((n) => n.level === "error").length, 1);
});

test("command reports reload failures without propagating", async () => {
  const { commands } = await loadExtension();
  const command = commands.get(COMMAND_NAME);
  assert.ok(command);

  const notifications: Array<{ message: string; level: string }> = [];
  await assert.doesNotReject(async () => {
    await command.handler("", {
      isIdle: () => true,
      reload: async () => { throw new Error("reload failed"); },
      ui: { notify: (message, level) => notifications.push({ message, level }) },
    });
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "error");
});

test("session_start(reload) sends only the minimal success signal", async () => {
  const { handlers, sentUserMessages } = await loadExtension();
  const sessionStart = handlers.get("session_start")?.[0] as SessionStartHandler;
  assert.ok(sessionStart);

  await sessionStart({ reason: "reload" }, {});

  assert.deepEqual(sentUserMessages, [
    { content: RELOAD_SUCCESS_MESSAGE, options: { deliverAs: "followUp" } },
  ]);
});

test("session_start(non-reload) does not send the success signal", async () => {
  const { handlers, sentUserMessages } = await loadExtension();
  const sessionStart = handlers.get("session_start")?.[0] as SessionStartHandler;
  assert.ok(sessionStart);

  await sessionStart({ reason: "startup" }, {});

  assert.deepEqual(sentUserMessages, []);
});

test("session_start warns and clears a pending command on non-reload session changes", async () => {
  const { tools, handlers } = await loadExtension();
  const sessionStart = handlers.get("session_start")?.[0] as SessionStartHandler;
  assert.ok(sessionStart);
  await tools.get(TOOL_NAME)?.execute("tool-1", { confirm_state_loss: true });

  const notifications: Array<{ message: string; level: string }> = [];
  await sessionStart(
    { reason: "fork" },
    { ui: { notify: (message, level) => notifications.push({ message, level }) } },
  );

  assert.equal((globalThis as Record<string, unknown>)[PENDING_SLOT], undefined);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
});

test("session_start handles a synchronous success-signal send failure", async () => {
  const { handlers } = await loadExtension(() => {
    throw new Error("stale runtime");
  });
  const sessionStart = handlers.get("session_start")?.[0] as SessionStartHandler;
  assert.ok(sessionStart);

  const notifications: Array<{ message: string; level: string }> = [];
  await sessionStart(
    { reason: "reload" },
    { ui: { notify: (message, level) => notifications.push({ message, level }) } },
  );

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
});

test("session_start handles an asynchronous success-signal rejection", async () => {
  const { handlers } = await loadExtension(() => Promise.reject(new Error("send failed")));
  const sessionStart = handlers.get("session_start")?.[0] as SessionStartHandler;
  assert.ok(sessionStart);

  const notifications: Array<{ message: string; level: string }> = [];
  await sessionStart(
    { reason: "reload" },
    { ui: { notify: (message, level) => notifications.push({ message, level }) } },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
});

test("agent_settled dispatches a legacy pending-command slot", async () => {
  const { handlers, sentUserMessages } = await loadExtension();
  const settled = handlers.get("agent_settled")?.[0] as SettledHandler;
  assert.ok(settled);

  (globalThis as Record<string, unknown>)[LEGACY_PENDING_SLOT] = RELOAD_COMMAND;
  await settled({}, { isIdle: () => true });

  assert.deepEqual(sentUserMessages, [
    { content: RELOAD_COMMAND, options: { deliverAs: "followUp", expandPromptTemplates: true } },
  ]);
  assert.equal((globalThis as Record<string, unknown>)[LEGACY_PENDING_SLOT], undefined);
});

test("non-string pending slots are cleared without dispatch", async () => {
  const { handlers, sentUserMessages } = await loadExtension();
  const settled = handlers.get("agent_settled")?.[0] as SettledHandler;
  assert.ok(settled);

  (globalThis as Record<string, unknown>)[LEGACY_PENDING_SLOT] = { bad: true };
  await settled({}, { isIdle: () => true });

  assert.deepEqual(sentUserMessages, []);
  assert.equal((globalThis as Record<string, unknown>)[LEGACY_PENDING_SLOT], undefined);
});

test("fresh-install logging creates the log file", async () => {
  const logFile = process.env.PI_RELOAD_SELF_HARDENED_LOG ?? "/tmp/pi-reload-self-hardened.log";
  try {
    unlinkSync(logFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  await loadExtension();
  assert.equal(existsSync(logFile), true);
});
