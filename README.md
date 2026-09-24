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
plus three hardenings that came from observed failures:

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
   The extension binding returns `undefined` at runtime (the internal
   wrapper catches errors itself but does *not* return the promise), despite
   the `Promise<void>` type. Chaining `.catch` directly crashes the process:
   `TypeError: Cannot read properties of undefined (reading 'catch')`
   (observed, 2026-09-24). `Promise.resolve(...)` is safe in both worlds —
   the current runtime and a future one that returns a real promise.

3. **`try/catch` isolation in the `agent_settled` handler**
   The handler sits on critical plumbing of a process that hosts the agent.
   An extension bug there must not become an `uncaughtException` that takes
   down Pi (observed with the pre-event polling design, 2026-09-24).

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

## Provenance

- Base package: [clankercode/pi-reload-self](https://github.com/clankercode/pi-reload-self)
  (MIT, © 2026 clankercode)
- Dispatch architecture: [PR #1](https://github.com/clankercode/pi-reload-self/pull/1)
  by limitsurface — `agent_settled` dispatch, in-command idle guard, pending
  command dedup
- Hardening + validation on Pi 0.87.1: DAXZEIT

Licensed under MIT — see [LICENSE](./LICENSE).
