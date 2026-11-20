#!/usr/bin/env node
/**
 * verify-live.mjs — read-only Discord REST v10 verification for the hermes bot.
 *
 * Every call is a GET. No POST/PATCH/PUT/DELETE reaches Discord, so this script
 * cannot create threads, send messages, register commands, or rename anything.
 *
 * Checks (each printed PASS/FAIL with evidence):
 *   1. GET /users/@me                                identity + bot flag
 *   2. GET /users/@me/guilds                         target guild membership
 *   3. GET /guilds/{guild}                           guild name
 *   4. GET /guilds/{guild}/channels                  categories / text / forums
 *   5. GET /applications/{appId}/guilds/{guild}/commands  registered commands
 *   6. GET /channels/{home}                          home channel exists + type
 *   7. GET /channels/{home}/messages?limit=5         recent messages (60-char preview)
 *   8. optional --watch-thread <id>                  poll new messages until timeout
 *
 * Token resolution order (first hit wins):
 *   --token-file <path>  (file with `DISCORD_BOT_TOKEN=...` or a raw token)
 *   DISCORD_BOT_TOKEN environment variable
 *   ~/.hermes/.env
 * The token is never printed; only its source and length are reported.
 *
 * Usage:
 *   node scripts/verify-live.mjs [--guild <id>] [--home-channel <id>]
 *                                [--expect-commands a,b,c]
 *                                [--watch-thread <id> [--interval 2000] [--timeout 30000]]
 *                                [--token-file <path>] [--json]
 *
 * Exit codes: 0 = every check PASS, 1 = at least one FAIL, 2 = usage/token error.
 * Node 22 ESM, built-in fetch only.
 */
import process from 'node:process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const API = 'https://discord.com/api/v10'
const DEFAULT_GUILD = process.env['DSH_VERIFY_GUILD'] ?? ''
const DEFAULT_HOME_CHANNEL = process.env['DSH_VERIFY_HOME_CHANNEL'] ?? ''
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), '.hermes', '.env')
const REQUEST_TIMEOUT_MS = 15000

const CHANNEL_TYPES = {
  0: 'text',
  1: 'dm',
  2: 'voice',
  3: 'group-dm',
  4: 'category',
  5: 'announcement',
  10: 'announcement-thread',
  11: 'public-thread',
  12: 'private-thread',
  13: 'stage',
  14: 'directory',
  15: 'forum',
  16: 'media',
}

function channelTypeLabel(type) {
  return `${type} (${CHANNEL_TYPES[type] ?? 'unknown'})`
}

function usage() {
  return [
    'Usage: node scripts/verify-live.mjs [options]',
    '',
    '  --guild <id>            guild to verify (or set DSH_VERIFY_GUILD)',
    '  --home-channel <id>     home thread/channel to inspect (default: 1508647078342037645)',
    '  --expect-commands a,b,c fail when any listed guild command is missing',
    '  --watch-thread <id>     poll a thread for new messages (read-only)',
    '  --interval <ms>         poll interval for --watch-thread (default: 2000)',
    '  --timeout <ms>          total watch duration (default: 30000)',
    '  --token-file <path>     file with DISCORD_BOT_TOKEN=... or a raw token',
    '  --json                  machine-readable output (token never included)',
    '  -h, --help              show this help',
    '',
    'Token order: --token-file, DISCORD_BOT_TOKEN env, ~/.hermes/.env',
    'Exit codes: 0 = all PASS, 1 = any FAIL, 2 = usage/token error.',
  ].join('\n')
}

function parseArgs(argv) {
  const opts = {
    guild: DEFAULT_GUILD,
    homeChannel: DEFAULT_HOME_CHANNEL,
    expectCommands: [],
    watchThread: null,
    intervalMs: 2000,
    timeoutMs: 30000,
    tokenFile: null,
    json: false,
    help: false,
  }
  const strings = new Map([
    ['--guild', 'guild'],
    ['--home-channel', 'homeChannel'],
    ['--expect-commands', 'expectCommandsRaw'],
    ['--watch-thread', 'watchThread'],
    ['--token-file', 'tokenFile'],
  ])
  const numbers = new Map([
    ['--interval', 'intervalMs'],
    ['--timeout', 'timeoutMs'],
  ])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') {
      opts.json = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      opts.help = true
      continue
    }
    const match = (name) => {
      if (arg === name) {
        const value = argv[i + 1]
        if (value === undefined) throw new Error(`${name} requires a value`)
        i += 1
        return value
      }
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
      return null
    }
    let handled = false
    for (const [name, key] of strings) {
      const value = match(name)
      if (value !== null) {
        if (key === 'expectCommandsRaw') {
          opts.expectCommands = value.split(',').map((item) => item.trim()).filter((item) => item !== '')
        } else {
          opts[key] = value
        }
        handled = true
        break
      }
    }
    if (handled) continue
    for (const [name, key] of numbers) {
      const value = match(name)
      if (value !== null) {
        const parsed = Number.parseInt(value, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
        opts[key] = parsed
        handled = true
        break
      }
    }
    if (!handled) throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

/** Parse `DISCORD_BOT_TOKEN=...` or a raw token out of a dotenv-ish file. */
function extractToken(text) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = line.match(/^(?:export\s+)?DISCORD_BOT_TOKEN\s*=\s*(.*)$/)
    if (match === null) continue
    let value = match[1].trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    return value
  }
  const singleLine = text.trim()
  if (singleLine !== '' && !singleLine.includes('\n') && !/\s/.test(singleLine)) return singleLine
  return null
}

async function resolveToken(explicitFile) {
  if (explicitFile !== null) {
    const file = path.resolve(expandHome(explicitFile))
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      throw new Error(`cannot read --token-file ${file}: ${error.code ?? error.message}`)
    }
    const token = extractToken(text)
    if (token === null) throw new Error(`no DISCORD_BOT_TOKEN or raw token found in ${file}`)
    return { token, source: file, explicit: true }
  }
  const envToken = (process.env.DISCORD_BOT_TOKEN ?? '').trim()
  if (envToken !== '') return { token: envToken, source: 'env DISCORD_BOT_TOKEN', explicit: false }
  try {
    const text = await readFile(DEFAULT_TOKEN_FILE, 'utf8')
    const token = extractToken(text)
    if (token !== null) return { token, source: DEFAULT_TOKEN_FILE, explicit: false }
  } catch {
    // fall through to the explicit error below
  }
  throw new Error(
    `no Discord bot token found (--token-file, DISCORD_BOT_TOKEN, or ${DEFAULT_TOKEN_FILE})`,
  )
}

function makeState() {
  return { token: '', checks: [], identity: null, guilds: null, guild: null, channels: null, commands: null, home: null, messages: null, watch: null }
}

let STATE = makeState()
let TOKEN = ''

function redact(value) {
  let text = String(value ?? '')
  if (TOKEN.length >= 8 && text.includes(TOKEN)) text = text.split(TOKEN).join('[redacted-token]')
  return text
}

function clip(value, length) {
  const text = redact(value).replace(/\s+/g, ' ').trim()
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function record(letter, title, ok, evidence) {
  STATE.checks.push({ letter, title, ok: ok === true, evidence: evidence.map((item) => redact(item)) })
}

async function discordGet(route) {
  const url = `${API}${route}`
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bot ${TOKEN}`,
          'user-agent': 'dsh-discord-verify-live/1.0 (read-only)',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      return { status: 0, ok: false, body: null, networkError: redact(error.message) }
    }
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    let body = null
    if (text !== '') {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    if (response.status === 429 && attempt < 2) {
      const retryAfter = Number(body?.retry_after ?? 1)
      await sleep(Math.min(Math.max(retryAfter, 0.5), 5) * 1000)
      continue
    }
    return {
      status: response.status,
      ok: response.ok,
      body,
      message: response.status >= 400 ? redact(describeDiscordError(response.status, body)) : null,
    }
  }
  return { status: 0, ok: false, body: null, networkError: 'retry budget exhausted' }
}

function describeDiscordError(status, body) {
  const code = body?.code === undefined ? '' : ` code=${body.code}`
  const message = typeof body?.message === 'string' ? body.message : ''
  const hints = {
    401: 'invalid bot token (401)',
    403: 'missing access/permission (403): check View Channel, Read Message History, applications.commands',
    404: 'not found (404): wrong guild/channel id, or the bot cannot see it',
  }
  return `${hints[status] ?? `HTTP ${status}`}${code}${message === '' ? '' : ` — ${message}`}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function bigSnowflake(value) {
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}

function authorName(message) {
  const author = message?.author ?? {}
  return author.global_name || author.username || `user:${author.id ?? 'unknown'}`
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  if (opts.guild === '') throw new Error('missing --guild (or DSH_VERIFY_GUILD)')
  STATE = makeState()
  const resolved = await resolveToken(opts.tokenFile)
  TOKEN = resolved.token
  if (TOKEN.length < 20) throw new Error(`token from ${resolved.source} is implausibly short (${TOKEN.length} chars)`)
  STATE.tokenSource = resolved.source
  STATE.tokenLength = TOKEN.length

  if (!opts.json) {
    console.log('verify-live — Discord REST v10 (read-only)')
    console.log(`token: ${resolved.source} (bot token, ${TOKEN.length} chars, masked)`)
    console.log('')
  }

  // 1. identity -------------------------------------------------------------
  const me = await discordGet('/users/@me')
  const identityOk = me.ok && typeof me.body?.id === 'string' && me.body?.bot === true
  if (me.ok && me.body?.id !== undefined) {
    STATE.identity = {
      id: me.body.id,
      username: me.body.username ?? null,
      globalName: me.body.global_name ?? null,
      bot: me.body.bot === true,
      applicationId: me.body.id,
    }
  }
  record(
    '1',
    'GET /users/@me — bot identity resolves',
    identityOk,
    me.ok && me.body?.id !== undefined
      ? [
          `id=${me.body.id} username=${me.body.username ?? '?'} bot=${me.body.bot === true}`,
          me.body.bot === true ? 'bot flag: true (Bot auth scheme accepted)' : 'bot flag: FALSE — this is not a bot token',
        ]
      : [me.networkError ?? me.message ?? `HTTP ${me.status}`],
  )

  const appId = STATE.identity?.id ?? null
  if (identityOk) STATE.identity.applicationId = appId
  let appIdsOk = false

  // 2. guild membership -----------------------------------------------------
  const guilds = await discordGet('/users/@me/guilds')
  const guildRows = Array.isArray(guilds.body) ? guilds.body : []
  const targetGuild = guildRows.find((row) => row.id === opts.guild) ?? null
  record(
    '2',
    `GET /users/@me/guilds — target guild ${opts.guild} is present`,
    guilds.ok && targetGuild !== null,
    guilds.ok
      ? [
          `bot is in ${guildRows.length} guild(s)`,
          targetGuild === null
            ? `target ${opts.guild} MISSING; visible: ${guildRows.slice(0, 8).map((row) => `${row.name}(${row.id})`).join(', ') || '(none)'}`
            : `found ${targetGuild.name}(${targetGuild.id}) owner=${targetGuild.owner === true}`,
        ]
      : [guilds.networkError ?? guilds.message ?? `HTTP ${guilds.status}`],
  )

  // 3. guild detail ---------------------------------------------------------
  const guild = await discordGet(`/guilds/${opts.guild}`)
  if (guild.ok && guild.body?.id !== undefined) {
    STATE.guild = { id: guild.body.id, name: guild.body.name ?? null, ownerId: guild.body.owner_id ?? null }
  }
  record(
    '3',
    `GET /guilds/${opts.guild} — guild details readable`,
    guild.ok && guild.body?.id !== undefined,
    guild.ok && guild.body?.id !== undefined
      ? [`name=${guild.body.name ?? '?'} id=${guild.body.id} owner_id=${guild.body.owner_id ?? '?'}`]
      : [guild.networkError ?? guild.message ?? `HTTP ${guild.status}`],
  )

  // 4. channels -------------------------------------------------------------
  const channels = await discordGet(`/guilds/${opts.guild}/channels`)
  const channelRows = Array.isArray(channels.body) ? channels.body : []
  if (channels.ok) {
    STATE.channels = channelRows.map((row) => ({
      id: row.id,
      name: row.name ?? null,
      type: channelTypeLabel(row.type),
      parentId: row.parent_id ?? null,
    }))
  }
  const channelEvidence = []
  if (channels.ok) {
    const categories = channelRows.filter((row) => row.type === 4)
    const text = channelRows.filter((row) => row.type === 0 || row.type === 5)
    const forums = channelRows.filter((row) => row.type === 15)
    channelEvidence.push(`HTTP 200, ${channelRows.length} channel(s) returned`)
    channelEvidence.push(`categories: ${categories.map((row) => `${row.name}(${row.id})`).join(', ') || '(none)'}`)
    channelEvidence.push(`text: ${text.map((row) => `${row.name}(${row.id}, type ${row.type})`).join(', ') || '(none)'}`)
    channelEvidence.push(`forums: ${forums.map((row) => `${row.name}(${row.id})`).join(', ') || '(none)'}`)
  } else {
    channelEvidence.push(channels.networkError ?? channels.message ?? `HTTP ${channels.status}`)
  }
  record(
    '4',
    `GET /guilds/${opts.guild}/channels — channel list readable`,
    channels.ok && Array.isArray(channels.body),
    channelEvidence,
  )

  // 5. guild commands -------------------------------------------------------
  const commandEvidence = []
  let commandsOk = false
  if (identityOk && appId !== null) {
    const commands = await discordGet(`/applications/${appId}/guilds/${opts.guild}/commands`)
    const commandRows = Array.isArray(commands.body) ? commands.body : []
    const names = commandRows.map((row) => row.name).filter((name) => typeof name === 'string').sort()
    const missing = opts.expectCommands.filter((name) => !names.includes(name))
    commandsOk = commands.ok && Array.isArray(commands.body) && missing.length === 0
    if (commands.ok && Array.isArray(commands.body)) {
      STATE.commands = {
        applicationId: appId,
        names,
        expected: opts.expectCommands,
        missing,
      }
      commandEvidence.push(`HTTP 200, ${names.length} guild command(s): ${names.join(', ') || '(none)'}`)
      if (opts.expectCommands.length > 0) {
        commandEvidence.push(
          missing.length === 0
            ? `expected commands present: ${opts.expectCommands.join(', ')}`
            : `MISSING expected command(s): ${missing.join(', ')}`,
        )
      } else {
        commandEvidence.push('--expect-commands not given; registration is reported, not asserted')
      }
    } else {
      commandEvidence.push(commands.networkError ?? commands.message ?? `HTTP ${commands.status}`)
      if (commands.status === 403) commandEvidence.push('hint: token may lack the applications.commands scope')
    }
  } else {
    commandEvidence.push('skipped: identity/application id unavailable')
  }
  record('5', `GET /applications/{appId}/guilds/${opts.guild}/commands — guild commands readable`, commandsOk, commandEvidence)

  // 6. home channel (optional) ----------------------------------------------
  if (opts.homeChannel !== '') {
  const home = await discordGet(`/channels/${opts.homeChannel}`)
  if (home.ok && home.body?.id !== undefined) {
    STATE.home = {
      id: home.body.id,
      name: home.body.name ?? null,
      type: channelTypeLabel(home.body.type),
      guildId: home.body.guild_id ?? null,
      parentId: home.body.parent_id ?? null,
      threadArchived: home.body.thread_metadata?.archived ?? null,
    }
  }
  record(
    '6',
    `GET /channels/${opts.homeChannel} — home channel exists`,
    home.ok && home.body?.id !== undefined,
    home.ok && home.body?.id !== undefined
      ? [
          home.body.name === undefined ? 'name: (none; thread/DM)' : `name=${home.body.name}`,
          `type=${channelTypeLabel(home.body.type)} guild_id=${home.body.guild_id ?? '?'}${home.body.parent_id === undefined ? '' : ` parent_id=${home.body.parent_id}`}`,
          home.body.thread_metadata === undefined
            ? 'thread_metadata: not a thread'
            : `thread archived=${home.body.thread_metadata.archived === true}`,
        ]
      : [home.networkError ?? home.message ?? `HTTP ${home.status}`],
  )

  // 7. recent home-channel messages ----------------------------------------
  const messages = await discordGet(`/channels/${opts.homeChannel}/messages?limit=5`)
  const messageRows = Array.isArray(messages.body) ? messages.body : []
  let homeMessagesOk = messages.ok && Array.isArray(messages.body)
  if (homeMessagesOk) {
    STATE.messages = messageRows.map((message) => ({
      id: message.id,
      author: authorName(message),
      authorId: message.author?.id ?? null,
      preview60: clip(message.content ?? '', 60),
      timestamp: message.timestamp ?? null,
    }))
  }
  const messageEvidence = []
  if (homeMessagesOk) {
    messageEvidence.push(`HTTP 200, ${messageRows.length} recent message(s)`)
    for (const message of messageRows) {
      messageEvidence.push(`id=${message.id} author=${authorName(message)} content="${clip(message.content ?? '', 60)}"`)
    }
    if (messageRows.length === 0) messageEvidence.push('(channel has no messages)')
  } else {
    messageEvidence.push(messages.networkError ?? messages.message ?? `HTTP ${messages.status}`)
  }
  record(
    '7',
    `GET /channels/${opts.homeChannel}/messages?limit=5 — recent messages readable`,
    homeMessagesOk,
    messageEvidence,
  )

  }

  // 8. optional read-only thread watch -------------------------------------
  if (opts.watchThread !== null) {
    const watchEvidence = []
    let watchOk = true
    let lastId = '0'
    const seen = []
    const startedAt = Date.now()
    const baseline = await discordGet(`/channels/${opts.watchThread}/messages?limit=1`)
    if (baseline.ok && Array.isArray(baseline.body) && baseline.body.length > 0) {
      lastId = baseline.body[0].id
    } else if (!baseline.ok) {
      watchOk = false
      watchEvidence.push(`baseline GET failed: ${baseline.networkError ?? baseline.message ?? `HTTP ${baseline.status}`}`)
    }
    watchEvidence.push(`watching channel ${opts.watchThread} from message ${lastId} (interval ${opts.intervalMs}ms, timeout ${opts.timeoutMs}ms)`)
    while (watchOk && Date.now() - startedAt < opts.timeoutMs) {
      const remaining = opts.timeoutMs - (Date.now() - startedAt)
      if (remaining <= 0) break
      await sleep(Math.min(opts.intervalMs, remaining))
      if (Date.now() - startedAt >= opts.timeoutMs) break
      const polled = await discordGet(`/channels/${opts.watchThread}/messages?after=${lastId}&limit=50`)
      if (!polled.ok || !Array.isArray(polled.body)) {
        watchOk = false
        watchEvidence.push(`poll failed: ${polled.networkError ?? polled.message ?? `HTTP ${polled.status}`}`)
        break
      }
      const fresh = polled.body
        .slice()
        .sort((a, b) => (bigSnowflake(a.id) < bigSnowflake(b.id) ? -1 : bigSnowflake(a.id) > bigSnowflake(b.id) ? 1 : 0))
      for (const message of fresh) {
        if (bigSnowflake(message.id) <= bigSnowflake(lastId)) continue
        lastId = message.id
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
        const item = {
          id: message.id,
          author: authorName(message),
          authorId: message.author?.id ?? null,
          preview80: clip(message.content ?? '', 80),
          observedAfterSeconds: Number(elapsed),
        }
        seen.push(item)
        watchEvidence.push(`+${elapsed}s id=${message.id} author=${authorName(message)} content="${clip(message.content ?? '', 80)}"`)
      }
    }
    if (watchOk && seen.length === 0) watchEvidence.push('no new messages observed within the timeout window')
    if (watchOk && seen.length > 0) watchEvidence.push(`${seen.length} new message(s) observed`)
    STATE.watch = {
      threadId: opts.watchThread,
      observationSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      messages: seen,
      ok: watchOk,
    }
    record('8', `GET /channels/${opts.watchThread}/messages?after=... — read-only thread watch`, watchOk, watchEvidence)
  }

  // Report -----------------------------------------------------------------
  const passed = STATE.checks.filter((check) => check.ok).length
  const failed = STATE.checks.length - passed
  const ok = failed === 0
  const summary = { ok, tokenSource: STATE.tokenSource, tokenLength: STATE.tokenLength, ...STATE, checks: STATE.checks, passed, failed }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } else {
    for (const check of STATE.checks) {
      console.log(`[${check.ok ? 'PASS' : 'FAIL'}] (${check.letter}) ${check.title}`)
      for (const item of check.evidence) console.log(`       ${item}`)
    }
    console.log('')
    console.log(`${passed} passed, ${failed} failed`)
    console.log(ok ? 'RESULT: PASS (exit 0)' : 'RESULT: FAIL (exit 1)')
  }
  return ok ? 0 : 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`verify-live: ${redact(error.message)}\n\n${usage()}\n`)
    process.exitCode = 2
  })
