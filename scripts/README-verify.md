# Verification scripts — forked Discord adapter

Two Node 22 scripts, built-in modules only. Neither writes to the profile or to
Discord: verify-install.mjs reads files, verify-live.mjs issues Discord REST v10
GETs. Run both from the repo root.

## verify-install.mjs — post-install filesystem gate

    node scripts/verify-install.mjs [--profile <dir>] [--package <name>] [--json]

Defaults: profile `~/.dsh/profiles/desktop`, package `@aporb/dsh-discord`.
- (a) profile manifest declares the bundle: package in `dependencies` and in `dsh.profile.bundles`.
- (b) profile patch layer mounts it: `id: dsh-discord` row carries `name: <package>`.
- (c) installed copy has a valid manifest and version, and no `@deepseek-ai/*` runtime dependency (host version gates disable rows that ship internal copies).
- (d) payload is built: `lib/index.js`, `lib/client.js`, `cordis.patch.yml`, `locale/en.json`, plus `dsh.bundle.patch` and `dsh.client`; the patch target resolves.
- (e) old `@addozhang/dsh-discord` is neither installed nor referenced.
Exit: 0 all PASS, 1 any FAIL, 2 usage error. A failing run before install is expected.
Strict (c) rejects every `@deepseek-ai/*`; `--allow-shared-deepseek` accepts non-host libraries only.

## verify-live.mjs — read-only Discord REST gate

    node scripts/verify-live.mjs [--guild <id>] [--home-channel <id>] [--expect-commands a,b,c] [--watch-thread <id> [--interval 2000] [--timeout 30000]] [--json]

Defaults: guild from `--guild` or `DSH_VERIFY_GUILD`; home channel from `--home-channel` (optional).
Token order: `--token-file <path>`, then `DISCORD_BOT_TOKEN`, then `~/.hermes/.env`.
The token is never printed, only its source and length. Checks identity and bot
flag, guild membership, guild name, channel list (categories/text/forums),
registered guild commands (use `--expect-commands` to assert names), home channel
type, five recent messages, and an optional read-only watch. Exit: 0 PASS, 1 FAIL,
2 usage/token error.

## After install

    node scripts/verify-install.mjs            # expect 5 PASS / 0 FAIL
    node scripts/verify-live.mjs               # identity, guild, channels, messages
    node scripts/verify-live.mjs --expect-commands guild,info,session

Restart the host after install, then re-run both. verify-live proves the token and
REST path only, not that the plugin mounted; verify-install covers the mount.
