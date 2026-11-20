/**
 * One-time bootstrap from a retired hermes install (`~/.hermes/.env`).
 *
 * The fork is installed into a harness where the previous Discord gateway
 * (hermes-agent) is stopped but its bot application still owns the useful
 * identity: the bot token, the operator allowlist and the home channel. This
 * module imports those values exactly once, into the places the DSH host
 * already trusts:
 *
 * - the bot token goes into the Host credential service under
 *   `DSH_DISCORD_BOT_TOKEN` (never into settings, never into a log);
 * - the guild allowlist and the member allowlist are seeded from the same
 *   environment file when the adapter's settings are still empty, so a
 *   single-user install works without hand-editing `settings.yaml`.
 *
 * Everything is best-effort and idempotent: a configured credential is left
 * alone, a non-empty allowlist is left alone, and a missing file silently
 * skips the import (the settings card remains the fallback path).
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default location of the retired hermes environment file. */
export const HERMES_ENV_PATH = join(homedir(), '.hermes', '.env')

/** Environment variable that overrides the legacy env-file path. */
export const BOOTSTRAP_ENV_VAR = 'DSH_DISCORD_BOOTSTRAP_ENV'

/** Resolve the env file: explicit dep > env override > the personal default. */
export function bootstrapEnvPath(): string {
  const override = process.env[BOOTSTRAP_ENV_VAR]
  return override !== undefined && override.trim() !== '' ? override.trim() : HERMES_ENV_PATH
}

/** Parse `KEY=value` lines from a dotenv-style file (quotes stripped). */
export function parseEnvAssignments(text: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2) {
      const first = value.charAt(0)
      const last = value.charAt(value.length - 1)
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1)
    }
    if (key !== '') entries.set(key, value)
  }
  return entries
}

export interface HermesBootstrapResult {
  /** `imported` when a token was written, `present` when one already existed. */
  token: 'imported' | 'present' | 'absent'
  /** `seeded` when guild/member allowlists were written from the env file. */
  allowlist: 'seeded' | 'present' | 'skipped' | 'failed'
}

export interface HermesBootstrapDeps {
  envPath?: string
  /** Injectable reader so tests never touch the real home directory. */
  readEnvFile?: (path: string) => Promise<string | undefined>
  /** Whether the Host credential service already holds a token. */
  describeToken(): Promise<{ configured: boolean }>
  /** Durably store the token in the Host credential service. */
  storeToken(value: string): Promise<void>
  /** The adapter's live settings projection (empty lists = not configured). */
  readSettings(): { allowedGuildIds: string[]; memberUserIds: string[]; revision: number } | undefined | Promise<{ allowedGuildIds: string[]; memberUserIds: string[]; revision: number } | undefined>
  /** Merge the seeded allowlists through the Host settings service. */
  writeSettings(
    patch: { allowedGuildIds: string[]; memberUserIds: string[] },
    revision: number,
  ): Promise<void>
  /** Resolve a home channel id to its guild id (Discord REST, read-only). */
  resolveGuildForChannel(channelId: string): Promise<string | undefined>
  log(event: string, detail?: unknown): void
}

async function defaultReadEnvFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Split a comma/space separated Discord id list. */
export function parseIdList(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(/[,\s]+/u)
    .map(item => item.trim())
    .filter(item => item !== '' && /^\d{17,20}$/u.test(item))
}

/**
 * Import the hermes token (once) and seed the single-user allowlists (once).
 * Never throws for a missing or unreadable env file: the result reports what
 * happened so the caller can log it at debug level.
 */
export async function importHermesBootstrap(deps: HermesBootstrapDeps): Promise<HermesBootstrapResult> {
  const envPath = deps.envPath ?? bootstrapEnvPath()
  const readEnvFile = deps.readEnvFile ?? defaultReadEnvFile
  const text = await readEnvFile(envPath)
  if (text === undefined) {
    deps.log('discord_hermes_env_absent', { path: envPath })
    return { token: 'absent', allowlist: 'skipped' }
  }
  const env = parseEnvAssignments(text)

  let token: HermesBootstrapResult['token'] = 'present'
  const credential = await deps.describeToken().catch(() => ({ configured: false }))
  if (!credential.configured) {
    const value = env.get('DISCORD_BOT_TOKEN')?.trim()
    if (value === undefined || value === '') {
      deps.log('discord_hermes_token_absent')
      return { token: 'absent', allowlist: 'skipped' }
    }
    await deps.storeToken(value)
    token = 'imported'
  }

  const settings = await deps.readSettings()
  if (settings === undefined) return { token, allowlist: 'skipped' }
  if (settings.allowedGuildIds.length > 0 || settings.memberUserIds.length > 0) {
    return { token, allowlist: 'present' }
  }
  const members = parseIdList(env.get('DISCORD_ALLOWED_USERS'))
  const homeChannel = env.get('DISCORD_HOME_CHANNEL')?.trim()
  const guildId = homeChannel === undefined || homeChannel === ''
    ? undefined
    : await deps.resolveGuildForChannel(homeChannel).catch(() => undefined)
  if (guildId === undefined || members.length === 0) {
    deps.log('discord_hermes_allowlist_unresolved', {
      hasGuild: guildId !== undefined,
      members: members.length,
    })
    return { token, allowlist: 'failed' }
  }
  await deps.writeSettings({ allowedGuildIds: [guildId], memberUserIds: members }, settings.revision)
  return { token, allowlist: 'seeded' }
}
