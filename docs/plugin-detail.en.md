# DSH Discord — a Discord bridge for DeepSeek Harness 0.2.2 desktop

Mention the bot, pick a DSH conversation (or start a new one), and follow it live in a Discord
thread. The thread name tracks the conversation title, messages typed in the thread go back to the
conversation, and answers stream in place. Approvals and questions arrive as Discord buttons and
selects, mirrored with the desktop panel.

This is a fork of [addozhang/dsh-discord](https://github.com/addozhang/dsh-discord) (MIT) that
targets the DeepSeek Harness **0.2.2-rc.1** desktop host and a single-user workflow. It is not
affiliated with addozhang, DeepSeek, or Discord.

## What this fork adds

- **Conversation picker.** A mention in an unbound channel opens a thread and asks for a workspace,
  then offers that workspace's recent conversations plus **New conversation**. The chosen
  conversation is bound to the thread and followed live.
- **Attach to existing.** Bound channels follow their workspace's newest conversation; `/session
  pick` opens the picker anywhere.
- **Thread titles.** The Discord thread renames itself to the conversation title, immediately on
  attach and whenever the title changes.
- **Live deltas on 0.2.2-rc.1.** That host emits no durable `assistant/chunk` events; the fork
  renders text deltas from `assistant-stream` follow frames.
- **Visible turn failures.** A failed turn posts one system line instead of leaving the thread
  silent.
- **One-time bootstrap.** The bot token is imported from a legacy env file
  (`DSH_DISCORD_BOOTSTRAP_ENV`, default `~/.hermes/.env`) into the DSH credential service, and the
  guild/member allowlists are seeded from `DISCORD_HOME_CHANNEL` / `DISCORD_ALLOWED_USERS`.

Everything else — approval and question buttons, slash commands, model and permission switching,
attachments, restart catch-up — is the upstream adapter, covered by upstream tests but not
re-verified in this fork. The README's "Verified vs inherited" table is the source of truth.

## Compatibility

- DeepSeek Harness desktop **0.2.2-rc.1** host line.
- Node.js `^22.19.0 || >=24`.
- Discord bot with the **MESSAGE CONTENT** privileged intent; Manage Channels, Send Messages, Create
  Public Threads, Send Messages in Threads, Attach Files, Read Message History.
- Plugin row id and settings namespace remain `dsh-discord`.

## Links

- Source: <https://github.com/aporb/dsh-discord>
- Upstream: <https://github.com/addozhang/dsh-discord>
