import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, unlinkSync } from "node:fs";

import extension from "../index.ts";

const COMMAND_NAME = "pi-reload-self-hardened-run";
const TOOL_NAME = "pi_extension_dev_reload_self";
const RELOAD_COMMAND = `/${COMMAND_NAME}`;
const RELOAD_SUCCESS_MESSAGE = "reload successful";
const LIMIT_COMMAND_NAME = "reload-self-limit";
const LIMIT_ENTRY_TYPE = "pi-reload-self-hardened-limit";
const PENDING_SLOT = "__piReloadSelfHardenedPendingCommand";
const LEGACY_PENDING_SLOT = "__piReloadSelfLocalPendingCommand";
const RELOAD_EXPECTED_SLOT = "__piReloadSelfHardenedReloadExpected";

interface RegisteredCommand {
  description: string;
  handler: (args: string, ctx: FakeCommandContext) => Promise<void> | void;
}

interface FakeEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

interface FakeUsageContext {
  sessionManager: { getBranch: () => FakeEntry[] };
  getContextUsage: () => { tokens?: number | null } | undefined;
  model?: unknown;
}

interface RegisteredTool {
  name: string;
  parameters: { properties: Record<string, unknown> };
  execute: (
    toolCallId: string,
    params: { confirm_state_loss: boolean },
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: FakeUsageContext,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }>;
}

interface FakeCommandContext extends Partial<FakeUsageContext> {
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
  opts?: { keepSlots?: boolean; entries?: FakeEntry[] },
) {
  if (!opts?.keepSlots) clearSlots();

  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, RegisteredTool>();
  const sentUserMessages: Array<{
    content: string;
    options?: { deliverAs?: string; expandPromptTemplates?: boolean };
  }> = [];
  const handlers = new Map<string, Array<(...args: never[]) => unknown>>();

  const entries = opts?.entries ?? [];
  const defaultContext: FakeUsageContext = {
    sessionManager: { getBranch: () => entries },
    getContextUsage: () => ({ tokens: 0 }),
  };
  const sentMessages: unknown[] = [];
  const fakePi = {
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, {
        ...command,
        handler: (args, ctx) => command.handler(args, { ...defaultContext, ...ctx }),
      });
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, {
        ...tool,
        execute: (id, params, signal, onUpdate, ctx = defaultContext) =>
          tool.execute(id, params, signal, onUpdate, ctx),
      });
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
  return { commands, tools, sentUserMessages, handlers, entries, sentMessages };
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

test("session_start(reload) sends the success signal for a tool-initiated reload", async () => {
  const { commands, handlers, sentUserMessages } = await loadExtension();
  const command = commands.get(COMMAND_NAME);
  const sessionStart = handlers.get("session_start")?.[0] as SessionStartHandler;
  assert.ok(command);
  assert.ok(sessionStart);

  // Le handler de commande pose le marqueur one-shot avant ctx.reload().
  await command.handler("", {
    isIdle: () => true,
    reload: async () => {},
  });

  await sessionStart({ reason: "reload" }, {});

  assert.deepEqual(sentUserMessages, [
    { content: RELOAD_SUCCESS_MESSAGE, options: { deliverAs: "followUp" } },
  ]);
  assert.equal((globalThis as Record<string, unknown>)[RELOAD_EXPECTED_SLOT], undefined);
});

test("a manual session_start(reload) without the tool sends no signal", async () => {
  const { handlers, sentUserMessages } = await loadExtension();
  const sessionStart = handlers.get("session_start")?.[0] as SessionStartHandler;
  assert.ok(sessionStart);

  await sessionStart({ reason: "reload" }, {});

  assert.deepEqual(sentUserMessages, []);
});

test("a stale reload-expected marker is discarded on a non-reload session_start", async () => {
  const { handlers, sentUserMessages } = await loadExtension();
  const sessionStart = handlers.get("session_start")?.[0] as SessionStartHandler;
  assert.ok(sessionStart);
  (globalThis as Record<string, unknown>)[RELOAD_EXPECTED_SLOT] = true;

  await sessionStart({ reason: "new" }, {});

  assert.deepEqual(sentUserMessages, []);
  assert.equal((globalThis as Record<string, unknown>)[RELOAD_EXPECTED_SLOT], undefined);
});

test("a failed ctx.reload() clears the reload-expected marker", async () => {
  const { commands } = await loadExtension();
  const command = commands.get(COMMAND_NAME);
  assert.ok(command);

  await command.handler("", {
    isIdle: () => true,
    reload: async () => { throw new Error("boom"); },
  });

  assert.equal((globalThis as Record<string, unknown>)[RELOAD_EXPECTED_SLOT], undefined);
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
  (globalThis as Record<string, unknown>)[RELOAD_EXPECTED_SLOT] = true; // reload déclenché par le tool

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
  (globalThis as Record<string, unknown>)[RELOAD_EXPECTED_SLOT] = true; // reload déclenché par le tool

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

// Simule le vrai chemin public (tool → settlement → commande), sans jamais
// appeler Pi ni un véritable reload. Les compteurs sont des oracles externes
// au code testé et chaque refus doit laisser reloadCalls à zéro.
async function limitHarness(entries: FakeEntry[] = []) {
  let reloadCalls = 0;
  let usage: { tokens?: number | null } | undefined = { tokens: 0 };
  let usageReads = 0;
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    sessionManager: { getBranch: () => entries },
    getContextUsage: () => { usageReads++; return usage; },
    isIdle: () => true,
    reload: async () => { reloadCalls++; },
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
  };
  const dispatched: Promise<void>[] = [];
  const runtime = await loadExtension((content) => {
    if (content === RELOAD_COMMAND) {
      const command = runtime.commands.get(COMMAND_NAME)!;
      const result = Promise.resolve(command.handler("", ctx));
      dispatched.push(result);
      return result;
    }
  }, { entries });
  return {
    ...runtime,
    ctx,
    notifications,
    get reloadCalls() { return reloadCalls; },
    get usageReads() { return usageReads; },
    setUsage(value: typeof usage) { usage = value; },
    async setLimit(value: string) {
      await runtime.commands.get(LIMIT_COMMAND_NAME)!.handler(value, ctx);
    },
    async call(confirmed = true) {
      return runtime.tools.get(TOOL_NAME)!.execute("limit-test", { confirm_state_loss: confirmed }, undefined, undefined, ctx);
    },
    async settle() {
      const settled = runtime.handlers.get("agent_settled")![0] as SettledHandler;
      await settled({}, ctx);
      await Promise.all(dispatched);
    },
  };
}

const ABOVE_LIMIT_TEXT = "You are currently above the reload-self limit (currently set at 100K tokens) — ask the user to compact before using this tool. Compaction commands: /pi-vcc or /compact.";

function assertNoReload(h: Awaited<ReturnType<typeof limitHarness>>) {
  assert.equal(h.reloadCalls, 0);
  assert.equal((globalThis as Record<string, unknown>)[PENDING_SLOT], undefined);
  assert.equal((globalThis as Record<string, unknown>)[RELOAD_EXPECTED_SLOT], undefined);
}

for (const tokens of [0, 99_999, 100_000, 100_001]) {
  test(`100K limit with ${tokens} tokens: only strictly above is refused`, async () => {
    const h = await limitHarness();
    await h.setLimit("100K");
    h.setUsage({ tokens });
    const result = await h.call();
    await h.settle();
    if (tokens === 100_001) {
      assert.deepEqual(result.details, { queued: false, reason: "context-limit-exceeded" });
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, ABOVE_LIMIT_TEXT);
      assertNoReload(h);
      assert.equal(h.sentUserMessages.length, 0);
    } else {
      assert.deepEqual(result.details, { queued: true, reason: "pending-agent-settled" });
      assert.equal(h.reloadCalls, 1);
      assert.equal(h.usageReads, 2);
      // Le nouveau runtime retrouve la préférence et consomme le marqueur.
      const next = await loadExtension(undefined, { keepSlots: true, entries: h.entries });
      const start = next.handlers.get("session_start")![0] as SessionStartHandler;
      await start({ reason: "reload" }, {});
      assert.deepEqual(next.sentUserMessages, [
        { content: RELOAD_SUCCESS_MESSAGE, options: { deliverAs: "followUp" } },
      ]);
    }
  });
}

for (const mode of ["unconfigured", "off"] as const) {
  test(`${mode}: no limit and no usage measurement required`, async () => {
    const h = await limitHarness();
    if (mode === "off") {
      await h.setLimit("1");
      await h.setLimit("off");
    }
    h.setUsage(undefined);
    assert.deepEqual((await h.call()).details, { queued: true, reason: "pending-agent-settled" });
    await h.settle();
    assert.equal(h.reloadCalls, 1);
    assert.equal(h.usageReads, 0);
  });
}

test("confirm_state_loss remains the first guard, even with a configured limit", async () => {
  const h = await limitHarness();
  await h.setLimit("100K");
  h.ctx.sessionManager.getBranch = () => { throw new Error("must not read preference"); };
  h.ctx.getContextUsage = () => { throw new Error("must not measure usage"); };
  const result = await h.call(false);
  assert.deepEqual(result.details, { queued: false, reason: "missing-confirmation" });
  await h.settle();
  assertNoReload(h);
});

for (const [name, usage] of [
  ["post-compaction null", { tokens: null }],
  ["absent usage", undefined],
  ["absent tokens", {}],
  ["NaN", { tokens: NaN }],
  ["infinite", { tokens: Infinity }],
  ["negative", { tokens: -1 }],
] as const) {
  test(`configured limit refuses ${name} without reload`, async () => {
    const h = await limitHarness();
    await h.setLimit("100K");
    h.setUsage(usage);
    const result = await h.call();
    assert.deepEqual(result.details, { queued: false, reason: "context-usage-unavailable" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unavailable — retry after an assistant response/);
    await h.settle();
    assertNoReload(h);
  });
}

for (const [name, usage, reason] of [
  ["growth above limit", { tokens: 100_001 }, "context-limit-exceeded"],
  ["compaction invalidation", { tokens: null }, "context-usage-unavailable"],
  ["usage disappears", undefined, "context-usage-unavailable"],
] as const) {
  test(`deferred reload rechecks ${name} and never retries a refusal`, async () => {
    const h = await limitHarness();
    await h.setLimit("100K");
    h.setUsage({ tokens: 99_999 });
    assert.deepEqual((await h.call()).details, { queued: true, reason: "pending-agent-settled" });
    h.setUsage(usage);
    await h.settle();
    assertNoReload(h);
    assert.equal(h.usageReads, 2);
    const text = reason === "context-limit-exceeded" ? ABOVE_LIMIT_TEXT :
      "Reload-self context usage estimate is unavailable — retry after an assistant response. This can happen just after compaction (/pi-vcc or /compact).";
    assert.deepEqual(h.notifications.at(-1), { message: text, level: "warning" });
    assert.deepEqual(h.sentMessages, [{
      message: { customType: "pi-reload-self-hardened-refusal", content: text, display: true },
      options: { triggerTurn: false },
    }]);
    const sends = h.sentUserMessages.length;
    h.setUsage({ tokens: 1 });
    await h.settle();
    assertNoReload(h);
    assert.equal(h.sentUserMessages.length, sends);
    // Un nouvel appel explicite est permis, sans refus mémorisé.
    await h.call();
    await h.settle();
    assert.equal(h.reloadCalls, 1);
  });
}

test("compaction sequence never reuses a stale measurement or refusal", async () => {
  const h = await limitHarness();
  await h.setLimit("100K");
  h.setUsage({ tokens: 100_001 });
  assert.deepEqual((await h.call()).details, { queued: false, reason: "context-limit-exceeded" });
  await h.settle();
  assertNoReload(h);
  h.setUsage({ tokens: null });
  assert.deepEqual((await h.call()).details, { queued: false, reason: "context-usage-unavailable" });
  await h.settle();
  assertNoReload(h);
  h.setUsage({ tokens: 50_000 });
  await h.call();
  await h.settle();
  assert.equal(h.reloadCalls, 1);
});

test("command rechecks after dispatch, immediately before reload", async () => {
  const h = await limitHarness();
  await h.setLimit("100K");
  h.setUsage({ tokens: 1 });
  await h.call();
  // Pas idle : le handler interne remet la commande en file, sans reload.
  await h.commands.get(COMMAND_NAME)!.handler("", { ...h.ctx, isIdle: () => false });
  assert.equal(h.reloadCalls, 0);
  h.setUsage({ tokens: 100_001 });
  await h.settle();
  assertNoReload(h);
  assert.equal(h.notifications.at(-1)?.message, ABOVE_LIMIT_TEXT);
});

test("deferred guard uses the current preference rather than the queued one", async () => {
  const h = await limitHarness();
  await h.setLimit("100K");
  h.setUsage({ tokens: 50_000 });
  await h.call();
  await h.setLimit("1");
  await h.settle();
  assertNoReload(h);
  assert.match(h.notifications.at(-1)!.message, /currently set at 1 tokens/);
});

test("limit command syntax parses decimal K/M, persists only dedicated custom entries, and shows without writing", async () => {
  const h = await limitHarness();
  assert.ok(h.commands.has("reload-self-limit"));
  await h.setLimit("");
  assert.equal(h.notifications.at(-1)?.message, "Reload-self limit: off (no limit).");
  assert.equal(h.entries.length, 0);
  for (const [input, tokens] of [["1", 1], ["50000", 50_000], ["50K", 50_000], ["1M", 1_000_000], [" 2k ", 2_000], ["3m", 3_000_000], ["9007199254740991", Number.MAX_SAFE_INTEGER], ["off", null]] as const) {
    await h.setLimit(input);
    assert.deepEqual(h.entries.at(-1), {
      type: "custom", customType: LIMIT_ENTRY_TYPE, data: { version: 1, tokens },
    });
  }
  const count = h.entries.length;
  await h.setLimit("   ");
  assert.equal(h.entries.length, count);
  assert.equal(h.sentUserMessages.length, 0);
  assert.equal(h.sentMessages.length, 0);
});

test("invalid limits do not persist or replace an existing preference", async () => {
  const h = await limitHarness();
  await h.setLimit("100K");
  for (const value of ["0", "0K", "-1", "NaN", "Infinity", "1e5", "1.5", "1.5K", "1 K", "100KB", "100K extra", "9007199254740992", "9007199254741K", "9".repeat(400)]) {
    await h.setLimit(value);
    assert.equal(h.entries.length, 1, value);
    assert.equal(h.notifications.at(-1)?.level, "error", value);
  }
  await h.setLimit("");
  assert.equal(h.notifications.at(-1)?.message, "Reload-self limit: 100K tokens (estimated context usage).");
});

test("preference survives runtime reload/resume but follows only the active session branch", async () => {
  const first = await limitHarness();
  await first.setLimit("1M");
  await first.setLimit("100K");
  const persisted = structuredClone(first.entries);
  const resumed = await limitHarness(persisted);
  await resumed.setLimit("");
  assert.equal(resumed.notifications.at(-1)?.message, "Reload-self limit: 100K tokens (estimated context usage).");
  resumed.setUsage({ tokens: 100_001 });
  await resumed.call();
  await resumed.settle();
  assertNoReload(resumed);
  // Une branche antérieure avec 1M n'hérite pas du dernier 100K du fichier.
  resumed.ctx.sessionManager.getBranch = () => persisted.slice(0, 1);
  await resumed.call();
  await resumed.settle();
  assert.equal(resumed.reloadCalls, 1);
  const fresh = await limitHarness();
  fresh.setUsage({ tokens: 2_000_000 });
  await fresh.call();
  await fresh.settle();
  assert.equal(fresh.reloadCalls, 1);
});

test("off survives a fresh runtime and malformed or unrelated entries do not override valid preferences", async () => {
  const first = await limitHarness();
  await first.setLimit("1");
  await first.setLimit("off");
  const resumed = await limitHarness(structuredClone(first.entries));
  resumed.setUsage(undefined);
  await resumed.call();
  await resumed.settle();
  assert.equal(resumed.reloadCalls, 1);

  const malformed = await limitHarness([
    { type: "custom", customType: LIMIT_ENTRY_TYPE, data: { version: 1, tokens: 100_000 } },
    { type: "custom", customType: "unrelated", data: { version: 1, tokens: null } },
    ...[null, {}, { version: 2, tokens: null }, { version: 1, tokens: 0 }, { version: 1, tokens: "off" }].map((data) => ({ type: "custom", customType: LIMIT_ENTRY_TYPE, data })),
  ]);
  malformed.setUsage({ tokens: 100_001 });
  await malformed.call();
  await malformed.settle();
  assertNoReload(malformed);
});

for (const model of [undefined, { provider: "local", id: "free", cost: { input: 0 } }, { provider: "paid", id: "expensive", cost: { input: 100 } }]) {
  test(`limit applies to model ${model?.id ?? "absent"} with no tool bypass parameter`, async () => {
    const h = await limitHarness();
    await h.setLimit("100K");
    h.setUsage({ tokens: 100_001 });
    const tool = h.tools.get(TOOL_NAME)!;
    assert.deepEqual(Object.keys(tool.parameters.properties), ["confirm_state_loss"]);
    const result = await tool.execute("model-test", { confirm_state_loss: true }, undefined, undefined, { ...h.ctx, model });
    assert.deepEqual(result.details, { queued: false, reason: "context-limit-exceeded" });
    await h.settle();
    assertNoReload(h);
  });
}

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
