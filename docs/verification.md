# Verification record

Project: `@aporb/dsh-discord` (DSH Discord) 0.2.2 — fork of
[addozhang/dsh-discord](https://github.com/addozhang/dsh-discord).

This record lists what was actually exercised, on which host line, and what the result was. IDs,
paths, and message contents are generic; no real guild, user, bot, or token values are included.

## Environment

- DeepSeek Harness desktop **0.2.2-rc.1** (Cordis 4.1.0, zod 4.4.3, schemastery 3.19.0).
- A throwaway DSH profile booted from the App's bundled 0.2.2-rc.1 CLI core, sharing the real
  credential store and session home, against a private Discord test guild.
- Bot application and guild are the operator's own; they are not identified here.

## Automated gates

| Gate | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | pass |
| Lint | `pnpm lint` | pass (0 warnings) |
| Tests | `pnpm test` | 98 files, 930 tests passed |
| Build | `pnpm build` | `lib/` plus `lib/client.js` (loader id `@aporb/dsh-discord`) |
| Install gate | `node scripts/verify-install.mjs --allow-shared-deepseek` | 5/5 pass, exit 0 |

`--allow-shared-deepseek` is required because the package depends on
`@deepseek-ai/schemastery`, a shared runtime library rather than a host-internal `dsh-*` package.
The gate still hard-fails any `@deepseek-ai/dsh-*` runtime dependency.

## Real-guild verification

Passed on the private test guild:

- One-time bootstrap: token imported into the DSH credential service; guild id and member
  allowlist seeded from `DISCORD_HOME_CHANNEL` / `DISCORD_ALLOWED_USERS`; second boot reported
  `token: present, allowlist: present`.
- Gateway READY; nine guild commands registered
  (`guild, info, model, permission, project, queue, session, steer, stop`); adapter category and
  control channel provisioned; reconcile sweep clean.
- Mention → anchored thread → two-step picker (workspace → conversation) → selection of an
  existing conversation → thread binding written, recent turns rendered, follow subscription live.
- Picker **New conversation** → session created, thread bound, first prompt submitted, turn ran.
- A follow-up typed in the thread reached the same conversation and its answer rendered in the
  thread (render watermark advanced; durable `thread_bindings` and `inbound_intents` rows written
  to the storage domain).
- Turn failure visibility: a turn with a missing provider key posted one `This turn failed: …`
  system line.
- Thread title sync: attach renamed the thread to the conversation title; a title change renamed it
  again; repeated identical titles produced no extra rename (dedupe against the last applied title
  and the current wire name).
- `scripts/verify-live.mjs` read-only Discord gate: 7/7 pass.

Known test-rig limitation only: when two DSH hosts share one session home, a session held by the
desktop host rejects prompts from the second host with `session/writer-held`. That cannot occur when
the plugin runs inside the single desktop host. The throwaway profile was removed afterwards.

## Desktop-profile acceptance

- Installed into the desktop profile, listed in `dsh.profile.bundles`, dependency spec points at a
  local packed tarball under `~/.dsh/plugin-packages/`.
- Cold boot: `bootstrap-result { token: present, allowlist: present }` → nine commands registered →
  gateway READY.
- Live acceptance in the desktop instance: mention opened a thread, the picker reached **New
  conversation**, the mention text ran as the first turn, and a follow-up typed in the thread was
  answered there.
- The settings card registers as a `settings.section` page (title **DSH Discord**).

If the card reports a token problem, re-paste the token in the card and press Connect. The credential
lives in the DSH credential service under `DSH_DISCORD_BOT_TOKEN`; it is never printed by the plugin
or by these scripts.
