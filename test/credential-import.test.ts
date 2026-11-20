/**
 * One-time hermes bootstrap (fork addition).
 *
 * `importHermesBootstrap` imports a retired hermes install's bot token into
 * the Host credential service and seeds the single-user allowlists when they
 * are still empty. It must be idempotent (never overwrite a configured token
 * or a non-empty allowlist), best-effort (a missing env file is not an
 * error), and it must never write the allowlists it could not resolve.
 * Everything here is exercised through injected deps: no real home directory,
 * no network, no settings service.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  importHermesBootstrap,
  parseEnvAssignments,
  parseIdList,
  type HermesBootstrapDeps,
} from '../src/credential-import.js'

const GUILD = '333333333333333333'
const MEMBER_A = '222222222222222222'
const MEMBER_B = '222222222222222223'
const HOME_CHANNEL = '444444444444444444'
const ENV_PATH = '/tmp/hermes/.env'

interface Settings {
  allowedGuildIds: string[]
  memberUserIds: string[]
  revision: number
}

interface DepsOptions {
  envText?: string | undefined
  configured?: boolean
  /** Absent → an empty settings projection; explicit undefined → none at all. */
  settings?: Settings | undefined
  /** Absent → GUILD resolves; explicit undefined → unresolvable. */
  guildId?: string | undefined
}

function createDeps(options: DepsOptions = {}) {
  const envText = options.envText
  const configured = options.configured ?? false
  const settings: Settings | undefined = 'settings' in options
    ? options.settings
    : { allowedGuildIds: [], memberUserIds: [], revision: 3 }
  const guildId = 'guildId' in options ? options.guildId : GUILD

  const readEnvFile = vi.fn((_path: string) => Promise.resolve(envText))
  const describeToken = vi.fn(() => Promise.resolve({ configured }))
  const storeToken = vi.fn((_value: string) => Promise.resolve())
  const readSettings = vi.fn(() => settings)
  const writeSettings = vi.fn((_patch: { allowedGuildIds: string[]; memberUserIds: string[] }, _revision: number) => Promise.resolve())
  const resolveGuildForChannel = vi.fn((_channelId: string) => Promise.resolve(guildId))
  const log = vi.fn((_event: string, _detail?: unknown) => {})

  const deps: HermesBootstrapDeps = {
    envPath: ENV_PATH,
    readEnvFile,
    describeToken,
    storeToken,
    readSettings,
    writeSettings,
    resolveGuildForChannel,
    log,
  }
  return { deps, readEnvFile, describeToken, storeToken, readSettings, writeSettings, resolveGuildForChannel, log }
}

/** A hermes env file carrying a token, one guild home channel, and members. */
function envWithToken(): string {
  return [
    'DISCORD_BOT_TOKEN=imported-token',
    `DISCORD_ALLOWED_USERS=${MEMBER_A},${MEMBER_B}`,
    `DISCORD_HOME_CHANNEL=${HOME_CHANNEL}`,
  ].join('\n')
}

describe('parseEnvAssignments', () => {
  it('parses dotenv lines, skipping comments and blanks', () => {
    const env = parseEnvAssignments([
      '# a comment',
      '   # an indented comment',
      '',
      '   ',
      'DISCORD_BOT_TOKEN="tok-abc"',
      "DISCORD_HOME_CHANNEL='444444444444444444'",
      '  SPACED  =  v  ',
      'NO_EQUALS',
      '=no-key',
    ].join('\n'))
    expect(env).toEqual(new Map([
      ['DISCORD_BOT_TOKEN', 'tok-abc'],
      ['DISCORD_HOME_CHANNEL', '444444444444444444'],
      ['SPACED', 'v'],
    ]))
  })

  it('splits on the first = only and keeps a mismatched quote as-is', () => {
    const env = parseEnvAssignments('BASE=a=b=c\nMISMATCH="x\'\nEMPTY=')
    expect(env.get('BASE')).toBe('a=b=c')
    expect(env.get('MISMATCH')).toBe('"x\'')
    expect(env.get('EMPTY')).toBe('')
    expect(env.has('EMPTY')).toBe(true)
  })

  it('accepts CRLF line endings', () => {
    const env = parseEnvAssignments('A=1\r\nB="two"\r\n\r\n# c\r\n')
    expect(env).toEqual(new Map([['A', '1'], ['B', 'two']]))
  })
})

describe('parseIdList', () => {
  it('returns [] for an absent value', () => {
    expect(parseIdList(undefined)).toEqual([])
    expect(parseIdList('')).toEqual([])
  })

  it('splits on commas and whitespace and drops non-snowflakes', () => {
    expect(parseIdList(
      `${MEMBER_A}, ${MEMBER_B} 12345 not-an-id 1234567890123456 123456789012345678901\n${GUILD}`,
    )).toEqual([MEMBER_A, MEMBER_B, GUILD])
  })
})

describe('importHermesBootstrap: env file', () => {
  it('reports absent/skipped when the env file is missing and writes nothing', async () => {
    const h = createDeps({ envText: undefined })
    const result = await importHermesBootstrap(h.deps)

    expect(result).toEqual({ token: 'absent', allowlist: 'skipped' })
    expect(h.readEnvFile).toHaveBeenCalledWith(ENV_PATH)
    expect(h.log).toHaveBeenCalledWith('discord_hermes_env_absent', { path: ENV_PATH })
    expect(h.describeToken).not.toHaveBeenCalled()
    expect(h.storeToken).not.toHaveBeenCalled()
    expect(h.writeSettings).not.toHaveBeenCalled()
  })
})

describe('importHermesBootstrap: token', () => {
  it('leaves a configured token alone and seeds the empty allowlist from the env', async () => {
    const h = createDeps({ envText: envWithToken(), configured: true })
    const result = await importHermesBootstrap(h.deps)

    expect(result).toEqual({ token: 'present', allowlist: 'seeded' })
    expect(h.storeToken).not.toHaveBeenCalled()
    expect(h.resolveGuildForChannel).toHaveBeenCalledWith(HOME_CHANNEL)
    expect(h.writeSettings).toHaveBeenCalledWith(
      { allowedGuildIds: [GUILD], memberUserIds: [MEMBER_A, MEMBER_B] },
      3,
    )
  })

  it('imports a token that is absent from the credential service', async () => {
    const h = createDeps({ envText: envWithToken(), configured: false })
    const result = await importHermesBootstrap(h.deps)

    expect(result).toEqual({ token: 'imported', allowlist: 'seeded' })
    expect(h.storeToken).toHaveBeenCalledTimes(1)
    expect(h.storeToken).toHaveBeenCalledWith('imported-token')
    expect(h.writeSettings).toHaveBeenCalledWith(
      { allowedGuildIds: [GUILD], memberUserIds: [MEMBER_A, MEMBER_B] },
      3,
    )
  })

  it('reports absent/skipped when neither the credential nor the env carries a token', async () => {
    const h = createDeps({
      envText: `DISCORD_ALLOWED_USERS=${MEMBER_A}\nDISCORD_HOME_CHANNEL=${HOME_CHANNEL}`,
      configured: false,
    })
    const result = await importHermesBootstrap(h.deps)

    expect(result).toEqual({ token: 'absent', allowlist: 'skipped' })
    expect(h.storeToken).not.toHaveBeenCalled()
    expect(h.log).toHaveBeenCalledWith('discord_hermes_token_absent')
    expect(h.writeSettings).not.toHaveBeenCalled()
  })
})

describe('importHermesBootstrap: allowlist', () => {
  it('leaves a non-empty allowlist alone and never writes', async () => {
    const h = createDeps({
      envText: envWithToken(),
      configured: true,
      settings: { allowedGuildIds: ['123456789012345678'], memberUserIds: [], revision: 9 },
    })
    const result = await importHermesBootstrap(h.deps)

    expect(result).toEqual({ token: 'present', allowlist: 'present' })
    expect(h.resolveGuildForChannel).not.toHaveBeenCalled()
    expect(h.writeSettings).not.toHaveBeenCalled()
  })

  it('fails without writing when the home channel does not resolve to a guild', async () => {
    const h = createDeps({ envText: envWithToken(), configured: true, guildId: undefined })
    const result = await importHermesBootstrap(h.deps)

    expect(result).toEqual({ token: 'present', allowlist: 'failed' })
    expect(h.log).toHaveBeenCalledWith('discord_hermes_allowlist_unresolved', {
      hasGuild: false,
      members: 2,
    })
    expect(h.writeSettings).not.toHaveBeenCalled()
  })

  it('fails without writing when the env carries no home channel', async () => {
    const h = createDeps({
      envText: `DISCORD_ALLOWED_USERS=${MEMBER_A}`,
      configured: true,
    })
    const result = await importHermesBootstrap(h.deps)

    expect(result).toEqual({ token: 'present', allowlist: 'failed' })
    expect(h.resolveGuildForChannel).not.toHaveBeenCalled()
    expect(h.log).toHaveBeenCalledWith('discord_hermes_allowlist_unresolved', {
      hasGuild: false,
      members: 1,
    })
    expect(h.writeSettings).not.toHaveBeenCalled()
  })

  it('fails without writing when the env carries no member ids', async () => {
    const h = createDeps({
      envText: `DISCORD_BOT_TOKEN=imported-token\nDISCORD_HOME_CHANNEL=${HOME_CHANNEL}`,
      configured: true,
    })
    const result = await importHermesBootstrap(h.deps)

    expect(result).toEqual({ token: 'present', allowlist: 'failed' })
    expect(h.log).toHaveBeenCalledWith('discord_hermes_allowlist_unresolved', {
      hasGuild: true,
      members: 0,
    })
    expect(h.writeSettings).not.toHaveBeenCalled()
  })

  it('skips the allowlist when there is no settings projection', async () => {
    const h = createDeps({ envText: envWithToken(), configured: true, settings: undefined })
    const result = await importHermesBootstrap(h.deps)

    expect(result).toEqual({ token: 'present', allowlist: 'skipped' })
    expect(h.writeSettings).not.toHaveBeenCalled()
  })
})
