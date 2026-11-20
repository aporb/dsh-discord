# AGENTS.md

Guidance for coding agents working in this repository. This file records what is easy to get wrong.
User-facing documentation lives in `README.md`.

## Project

A DeepSeek Harness (DSH) Discord bridge, forked from
[addozhang/dsh-discord](https://github.com/addozhang/dsh-discord). It is a Cordis plugin that mounts
a Discord Gateway, a slash-command surface, a stream renderer, and a browser settings card onto a
DSH web/desktop profile. TypeScript, pnpm, vitest.

- Package: `@aporb/dsh-discord`
- Plugin row id and settings namespace: `dsh-discord` (unchanged from upstream; existing settings
  and threads keep working)
- Target host: DSH desktop **0.2.2-rc.1**

## Commands

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build        # lib/ plus the browser card bundle
pnpm pack --pack-destination /tmp
```

`pnpm build` is required before installing. The package ships `lib/`, and a fresh checkout has no
`lib/` directory.

Install (preferred): call the DSH `plugin_manager` tool with `action: "install_bundle"` and the
package directory or a packed tarball. Restart the App afterwards; the host reads the plugin tree,
credentials, and package metadata at start.

## Architecture map

- `src/index.ts` — composition root: settings, storage domain, runtime, router wiring.
- `src/compose.ts` — runtime: gateway → ingress → authorization → routing → Discord REST.
- `src/dsh/host-face.ts` — the typed host face (session/workspace controllers).
- `src/dsh/host-events.ts` — follow/control fan-in, watermarking, rc.1 frame translations.
- `src/features/*` — one module per concern. Fork additions: `session-picker.ts` and the picker
  branches in `interaction-router.ts`; the rest is upstream.
- `src/discord/*` — Discord wire layer (REST, components registry, commands).
- `src/stream/*` — event → per-thread rendering (head message, activity rows, finalize, titles).
- `src/client/*` — browser settings card (separate bundle).
- `src/state/*` — durable storage-domain tables: channel bindings, thread bindings, intents.

## Host facts for 0.2.2-rc.1 (verified)

- `sessionController.list(request, signal)` takes two arguments; the reference upstream called it
  with the signal first. The request object is unused, but pass `({}, signal)`.
- `permissionPresets.catalog()` is synchronous on this host; wrap it in `Promise.resolve`.
- Durable `assistant/chunk` events do not exist. Text deltas arrive only as follow frames
  `{type:'assistant-stream', frame}` with `frame.type` `start`/`chunk`/`end`; the router re-shapes
  `chunk` text into `assistant/chunk` events and replays the snapshot's `assistantStream` baseline.
- Title changes arrive as the durable `session/title` event (`data.title`) and as control projection
  frames (`changes[{key:'title', val}]`, where `val` is a string or a `{title}` snapshot). Both feed
  thread renaming.
- Discord thread renames are rate-limited to roughly two per ten minutes; always dedupe against the
  thread's current wire name before PATCHing.
- The host logger is not readable from inside a session. Boot milestones go to
  `$TMPDIR/dsh-discord-diag.log` (`DSH_DISCORD_DIAG=0` silences it); `DSH_DISCORD_TRACE=1` prints
  wire frames to stderr when starting a CLI host.

## Invariants

- **At-most-once delivery.** An `unknown` Discord POST is never blindly resent; reconcile by nonce.
  Prompt submission uses `requestId = discord:<messageId>` plus an intent claim.
- **Opaque custom ids.** DSH identifiers never reach the Discord wire; picker select values are
  positional indices stored in the component registry.
- **Deny-first authorization.** The guild allowlist is the outer boundary; member, workspace
  administrator, and Host operator levels tighten from there.
- **No `@deepseek-ai/dsh-*` in `dependencies`.** The host's exact-version gate disables plugin rows
  that carry a host-internal copy. Host packages belong in `devDependencies`, and source imports of
  them must be type-only. `test/packaging.test.ts` guards this.
- **English only.** One locale file (`locale/en.json`) and English copy in `src/i18n.ts`. Tests may
  contain non-English fixture data.
- **Volatile config.** Every `Config` field uses `.volatile()`; the settings namespace equals the
  patch row id (`dsh-discord`).

## Testing

Behavior changes start with a failing test (RED → GREEN). Pure logic gets module tests; wire shapes
get the `discord-digital-twin` end-to-end tests. The twin does not model Discord form validation, so
wire payload constraints (component nesting, nonce length, modal titles) need a real-machine check.
`scripts/verify-install.mjs` and `scripts/verify-live.mjs` are the local gates; the latter is
read-only and requires `--guild` or `DSH_VERIFY_GUILD`.

## License and attribution

MIT, inherited from upstream. Keep `LICENSE` unchanged and `NOTICE` accurate. This fork is not
affiliated with addozhang, DeepSeek, or Discord.
