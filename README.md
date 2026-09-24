# pi-reload-self-hardened

Pi extension that lets the **agent reload Pi itself** from a tool call
(`pi_extension_dev_reload_self`) and continue the session autonomously — no
manual `/reload` needed.

Built on the public-dispatch design of
[clankercode/pi-reload-self PR #1](https://github.com/clankercode/pi-reload-self/pull/1)
(limitsurface, *"Use public settled dispatch"*), independently validated on
**Pi 0.87.1**, plus production hardening from a real deployment.

## Why this fork exists

The npm package `pi-reload-self` (0.1.1) is dead on Pi 0.87.x: it monkeypatches
`ExtensionRunner.prototype.createContext` to expose `reload()` to the tool
context, but the runner now builds the tool context as a **whitelisted
projection** (~20 keys, no `reload`) — the patch applies, then gets filtered
out immediately, so the tool always falls back to the manual editor path.

PR #1 removes the monkeypatch in favor of the public API. This repository is
that design, validated end-to-end on 0.87.1 (2026-09-24: full cycles,
tool → reload in ~300–700 ms → continuation turn, zero manual intervention),
plus four hardenings that came from observed failures:

## Production hardening (beyond PR #1)

1. **Diagnostic logging** → `/tmp/pi-reload-self-hardened.log`
   The reload cycle is intrinsically async (tool → pending state →
   `agent_settled` → command dispatch → guard → `ctx.reload()` →
   `session_start` → continuation). Without instrumentation, a failure between
   two steps is indistinguishable from "it didn't reload". The log records
   every step and every guard decision. It is what made the 0.87.x behavior
   debuggable in the first place. **The continuation prompt content is never
   written** — only its length.

2. **`Promise.resolve()` around `pi.sendUserMessage()`**
   The extension binding returns `undefined` at runtime — the internal
   wrapper (`agent-session.js`, `bindCore`) catches errors itself but has no
   `return`, and the shipped 0.87.1 `types.d.ts` declares the call as `void`
   (not `Promise<void>`). Chaining `.catch` directly then throws
   `TypeError: Cannot read properties of undefined (reading 'catch')`. Inside
   an event handler that TypeError is silently swallowed by the runner's
   per-handler isolation (`runner.emit`), but the same call *outside* a
   handler — a timer, which this project's earlier polling design used —
   crashes the process (observed, 2026-09-24). `Promise.resolve(...)` is safe
   in both worlds — the current runtime and a future one that returns a real,
   possibly rejecting, promise.

3. **`try/catch` isolation in the event handlers**
   The handlers sit on critical plumbing of a process that hosts the agent,
   and an extension bug there must not become an `uncaughtException` that
   takes down Pi (observed with the pre-event polling design, 2026-09-24).
   Note: Pi 0.87.1's `runner.emit` already isolates each event handler, so
   this is belt-and-braces against *future* runners without per-handler
   isolation — applied consistently to both the `agent_settled` and the
   `session_start` handler.

4. **Slot ABI scans + no-silent-failure**
   `globalThis` survives the runtime replacement, so a slot renamed across a
   reload (in-flight code change) would be written by the old version and
   missed by the new one — the continuation would be dropped **silently** and
   control would just return to the user (observed 2026-09-24: the
   local→hardened rename crossed a reload). Both state slots are now scanned
   across all ABI variants — `__piReloadSelf*ContinuationPrompt` for the
   continuation and `__piReloadSelf*PendingCommand` for the pending command
   (same in-flight-rename hazard, one step earlier in the cycle) — most
   recently written wins, all variants cleared, non-string leftovers logged
   and dropped. And residual state is never discarded silently: a reload that
   comes back without a continuation, a pending command abandoned by a
   session change, a synchronously-failed dispatch, or a leftover
   continuation on a non-reload `session_start` each notify the user.

## Tests

```sh
npm run check   # tsc --noEmit + node:test suite (21 tests)
```

The fake `pi.sendUserMessage` returns `undefined` by default — exactly the
real 0.87.1 runtime behavior — so every dispatch test exercises the
undefined-return path; the harness also models rejecting and
synchronously-throwing sends. Command-handler tests pass the **real-shape
args** (the bare post-space token, as `_tryExecuteExtensionCommand`,
agent-session.js:1336-1348, produces) — only the copied-full-command-text
test uses the full shape, which is a genuine user scenario. Covered:
registration, confirmation gate,
queue/dedup/one-shot dispatch, `agent_settled` timing, rejecting
`sendUserMessage`, handler exception isolation, in-command idle guard,
invalid payload (with/without ui), reload + continuation delivery, legacy
slot recovery, most-recent-slot preference, continuation-less reload
notification, copied command text, failed-`ctx.reload()` continuation
discard (C1), non-reload `session_start` residual drop (C3), pending-drop
warning (C2a), idle-guard re-queue and retry with re-dispatchable
command-shaped re-store (N1/F1), synchronous-send failure
re-store (C2c), non-string legacy slot (N2a), idle-guard retry cap in the
real dispatch/refusal cycle (N1/F2), synchronous-send re-store cap (F3).

## How it works

```
tool (confirm_state_loss: true)
  → pending reload command stored in globalThis (dedup: a second call while
    one is pending is refused, not re-queued)
  → `agent_settled` event (agent run "fully settled" — documented public event)
  → pi.sendUserMessage("/pi-reload-self-hardened-run <token>",
        { deliverAs: "followUp", expandPromptTemplates: true })
  → Pi dispatches slash commands before queueing → extension command handler
  → idle guard (if the response is not fully finished: warn and refuse —
    Pi would otherwise consume the command without reloading)
  → continuation prompt → globalThis + await ctx.reload()
  → session_start(reason: "reload") → pending command cleared,
    continuation sent as a follow-up user message
  → new turn, zero manual intervention
```

No monkeypatching, no internal API — only `registerTool`, `registerCommand`,
`pi.sendUserMessage`, `ctx.reload()` and the `session_start` /
`agent_settled` events.

## Install

```sh
pi install <path-or-url-to-this-repo>
```

Then run `/reload` **once, manually** — chicken-and-egg: the tool does not
exist until the extension is loaded. Every reload after that can be triggered
by the agent itself.

## Notes

- **Peer floor**: `peerDependencies: >=0.87.1` is what this fork was actually
  validated against. An upstream version of this work would re-derive the
  floor from PR #1's `>=0.84.2` before claiming wider compatibility.
- **Do not install alongside upstream `pi-reload-self`**: the tool name
  intentionally collides (`pi_extension_dev_reload_self` is the same tool) —
  two copies registering the same tool name produce registration-order-
  dependent behavior. Keep exactly one of the two.
- **A hung `ctx.reload()` is undetectable from the extension** (no timeout
  API): if the reload never settles, no notify fires and the continuation
  sits in `globalThis` until the next `session_start` (any reason) drops it
  with a warning — that gate is the backstop.
- **A leftover pre-rename pending slot blocks new queues**: the tool's dedup
  scans all ABI variants of the pending slot, so a pending command written
  by an older version makes new tool calls return "already-queued" until the
  next `session_start` clears it (with a warning). The legacy command is
  dispatched first — deliberate, but a behavior change vs pre-fix.

## Provenance

- Base package: [clankercode/pi-reload-self](https://github.com/clankercode/pi-reload-self)
  (MIT, © 2026 clankercode)
- Dispatch architecture: [PR #1](https://github.com/clankercode/pi-reload-self/pull/1)
  by limitsurface — `agent_settled` dispatch, in-command idle guard, pending
  command dedup
- Hardening + validation on Pi 0.87.1: DAXZEIT

Licensed under MIT — see [LICENSE](./LICENSE).
