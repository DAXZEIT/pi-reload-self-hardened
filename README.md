# pi-reload-self-hardened

Pi extension that lets the **agent reload Pi itself** from a tool call
(`pi_extension_dev_reload_self`) and continue the session autonomously — no
manual `/reload` needed.

Built on the public-dispatch design of
[clankercode/pi-reload-self PR #1](https://github.com/clankercode/pi-reload-self/pull/1)
(limitsurface, *"Use public settled dispatch"*), independently validated on
**Pi 0.87.1** and live-checked on **Pi 1.0.0**, with production hardening from
real failure modes.

## Why this fork exists

The npm package `pi-reload-self` (0.1.1) monkeypatches
`ExtensionRunner.prototype.createContext` to expose `reload()` to the tool
context. On Pi 0.87.x the runner builds the tool context as a **whitelisted
projection** without `reload`, so that patch is filtered out and the tool
falls back to the manual editor path.

PR #1 removes the monkeypatch in favor of the public API. This repository keeps
that dispatch architecture and hardens the failure paths.

## What it does

The tool queues a reload. The reload is dispatched only after
`agent_settled`, so Pi is not asked to replace its runtime while the current
turn is still active.

After `ctx.reload()` succeeds, Pi emits
`session_start(reason: "reload")`. When the reload was tool-initiated (the
command handler sets a one-shot marker right before `ctx.reload()`), the
extension sends one small follow-up message:

```text
reload successful
```

The conversation context is preserved by Pi, so there is **no continuation
prompt to serialize, carry through `globalThis`, or replay**. The post-reload
message is only an explicit success signal to the agent.

## How it works

```text
tool (confirm_state_loss: true)
  ↓
pending reload command stored in globalThis (dedup)
  ↓
agent_settled
  ↓
/pi-reload-self-hardened-run
  ↓
Pi dispatches the extension command
  ↓
idle guard
  ↓
one-shot reload-expected marker set in globalThis
  ↓
ctx.reload()
  ↓
session_start(reason: "reload") — marker consumed
  ↓
"reload successful" (tool-initiated reload only)
  ↓
new turn with the existing conversation context
```

No monkeypatching and no private API are used. The extension relies on
`registerTool`, `registerCommand`, `pi.sendUserMessage`, `ctx.reload()`,
and the public `session_start` / `agent_settled` events.

## Hardening

### Diagnostic logging

Logs go to:

```text
/tmp/pi-reload-self-hardened.log
```

The logger creates the file on a fresh installation and rotates it when it
reaches 1 MB. Prompt content is never written.

### Safe message dispatch

The extension binding on Pi 0.87.1 can return `undefined`, while a future
binding may return a real Promise. Calls are wrapped in `Promise.resolve()`
and event handlers are isolated with `try/catch`.

Both synchronous send failures and rejecting Promise sends are handled without
taking down the host process.

### Pending-command ABI recovery

`globalThis` survives the runtime replacement, so the pending command is
looked up across ABI variants of
`__piReloadSelf*PendingCommand`. Non-string leftovers are discarded and
logged rather than being allowed to silently poison the dispatch path.

### Retry and no-silent-failure guards

The idle guard re-queues a command when Pi is not actually idle, with a bounded
retry budget. Synchronous dispatch failures are also re-stored with a bounded
retry budget. State drops are surfaced to the user rather than disappearing
silently.

## Tests

```sh
npm run check   # tsc --noEmit + node:test suite (21 tests)
```

The test harness models the current `undefined` return value of
`sendUserMessage`, future rejecting-Promise behaviour, synchronous failures,
idle-guard retries, pending-slot ABI recovery, reload failures, and fresh-install
logging.

## Installation

```sh
pi install <path-or-url-to-this-repo>
```

Then run `/reload` **once, manually** — chicken-and-egg: the tool does not
exist until the extension is loaded. Every reload after that can be triggered
by the agent itself.

## Requirements

- Pi coding agent `>=0.87.1`
- Node.js >= 20
- `typebox` available in the Pi extension environment

## Notes

- **Do not install alongside upstream `pi-reload-self`**: the tool name
  intentionally collides (`pi_extension_dev_reload_self`).
- **A hung `ctx.reload()` is undetectable from the extension** (there is no
  timeout API). The pending state remains in `globalThis` until a later
  session transition handles it.
- The cycle was independently validated end-to-end on **Pi 0.87.1** and a full
  live cycle was subsequently observed on **Pi 1.0.0**.
- The post-reload message is deliberately fixed to `reload successful`; it
  is a state signal, not task content.
- A **manual `/reload` stays silent**: no signal, no turn. Only a
  tool-initiated reload sets the one-shot marker that triggers the message;
  a stale marker (failed reload, session change) is always discarded.

## Provenance

- Base package: [clankercode/pi-reload-self](https://github.com/clankercode/pi-reload-self)
  (MIT, © 2026 clankercode)
- Dispatch architecture: [PR #1](https://github.com/clankercode/pi-reload-self/pull/1)
  by limitsurface — `agent_settled` dispatch, in-command idle guard, pending
  command dedup
- Hardening + validation: DAXZEIT

Licensed under MIT — see [LICENSE](./LICENSE).
