/**
 * The Discord adapter's browser half. It binds the plugin's settings
 * namespace scope on its own fiber, owns the card controller, and registers
 * the settings card into the Plugins section's tab list until unload.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  DISCORD_RPC_CHANNEL,
  STATUS_ENDPOINT,
  type AdapterStatusView,
} from '../features/adapter-status.js'
import { DISCORD_SETTINGS_NAMESPACE } from '../settings-namespace.js'
import type { DiscordSettings } from '../settings.js'
import { DiscordCardController } from './card-controller.js'
import { installDiscordNavIcon } from './nav-icon.js'
import { DiscordSettingsCard } from './DiscordSettingsCard.js'
import type {} from './slot-contract.js'

/** Stable Cordis plugin name for diagnostics. */
export const name = 'dsh-discord-client'

/** Client services the card needs: settings transport, slot registry, plugin RPC channel, and locale. */
export const inject = ['configForms', 'slots', 'connection', 'locale']

/** The status poll cadence; the Host is the only authority on connection state. */
const STATUS_POLL_MS = 30_000

/** Accept only well-formed status views; anything else renders as "no status". */
function isStatusView(value: unknown): value is AdapterStatusView {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['token'] === 'string' && typeof candidate['connection'] === 'string'
}

interface PluginRpcFace {
  connection?: {
    rpc?: {
      call?: (channel: string, endpoint: string, payload: object, signal: AbortSignal | undefined) => Promise<unknown>
    }
  }
}

/** Mount the Discord settings card into the Plugins section. */
export function apply(ctx: Context): void {
  const form = ctx.configForms.get<DiscordSettings>(DISCORD_SETTINGS_NAMESPACE)
  const controller = new DiscordCardController(form)
  // Register the card's copy dictionary, then the card under the settings
  // UI's declared parent slot — a standalone slot name fails the loader's
  // children-table check at runtime.
  ctx.locale.register('dsh-discord', { en: DISCORD_CARD_LOCALE_EN })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'discord',
    order: 100,
    label: 'DSH Discord',
    locale: 'dsh-discord',
    registrant: name,
    inject: () => controller.face(),
  }, DiscordSettingsCard))
  ctx.effect(() => installDiscordNavIcon(), 'discord nav icon shim')

  const call = (ctx as Context & PluginRpcFace).connection?.rpc?.call
  if (typeof call !== 'function') return
  controller.setManagement({
    setToken: (value) => Promise.resolve(call(DISCORD_RPC_CHANNEL, 'credentials.set', { value }, undefined)).then((answer) => {
      if (typeof answer === 'object' && answer !== null && 'ok' in answer && (answer as { ok: boolean }).ok) return
      const message = typeof answer === 'object' && answer !== null && 'error' in answer
        ? ((answer as { error?: { message?: string } }).error?.message ?? 'The Host rejected the token.')
        : 'The Host rejected the token.'
      throw new TypeError(message)
    }),
    connect: () => { void call(DISCORD_RPC_CHANNEL, 'adapter.connect', {}, undefined) },
    disconnect: () => { void call(DISCORD_RPC_CHANNEL, 'adapter.disconnect', {}, undefined) },
    // Immediate feedback for connect/disconnect clicks: the handshake takes
    // a moment, so poll twice — once for the offline/starting state and once
    // after the gateway should have landed on READY or a terminal close.
    refresh: () => { setTimeout(poll, 600); setTimeout(poll, 2500) },
  })
  const poll = (): void => {
    void call(DISCORD_RPC_CHANNEL, STATUS_ENDPOINT, {}, undefined)
      .then((answer) => {
        if (typeof answer !== 'object' || answer === null || !('ok' in answer)) return
        const envelope = answer as { ok: boolean; value?: unknown }
        controller.setStatus(envelope.ok && isStatusView(envelope.value) ? envelope.value : undefined)
      })
      .catch(() => {
        // An unreachable Host is itself the status: render nothing invented.
        controller.setStatus(undefined)
      })
  }
  poll()
  const timer = setInterval(poll, STATUS_POLL_MS)
  ctx.effect(() => () => { clearInterval(timer) }, 'discord status poll')
}

/** Card copy: every key the slot contract declares (English-only build). */
const DISCORD_CARD_LOCALE_EN = {
  discordTitle: 'DSH Discord',
  discordDescription: 'Bind channels to Workspaces and authorize who may use the bot.',
  discordAllowedGuildIds: 'Allowed servers',
  discordGuildIdHelp: 'How to get it: enable Developer Mode in Discord (User Settings → Advanced), then right-click the target server and choose "Copy Server ID". One ID per line.',

  discordTokenLabel: 'Bot Token', discordTokenPlaceholder: 'Paste the bot token', discordTokenConnect: 'Connect', discordTokenConnecting: 'Connecting…',
  discordTokenHelp: 'From the Discord Developer Portal → your application → Bot → Reset Token. Stored in the Host credential service; never written to settings or logs.', discordDisconnect: 'Disconnect', discordTokenSaved: 'Saved token — leave empty to reconnect', discordTokenReconnectHint: 'The token is stored in the Host credential service. Leave empty to reconnect, or paste a new one to replace it.',
  discordThreadAutoArchive: 'Task Thread Auto-archive', discordThreadAutoArchiveHint: 'Idle task threads archive automatically',

  discordInvalidIds: 'IDs must be 17–20 digit snowflakes, one per line',
  discordInvalidArchive: 'Unsupported archive duration',
  discordStatusConnected: 'Connected', discordStatusConnecting: 'Connecting…',
  discordStatusDisconnected: 'Disconnected', discordStatusInvalidToken: 'Token rejected',
  discordStatusIntentsBlocked: 'Gateway intents blocked', discordStatusPermissionsBlocked: 'Missing channel permissions',
  discordHintConfigureToken: 'Configure the bot token in credentials',
  discordHintTokenRejected: 'Discord rejected the token — update it',
  discordHintEnableIntents: 'Enable privileged intents in the Developer Portal',
  discordHintGatewayClosed: 'Gateway closed unexpectedly',
  discordHintChannelPermissions: 'The bot lacks permissions in this channel',
  reset: 'Reset', expand: 'Expand', collapse: 'Collapse', unsaved: 'Unsaved changes',
  readOnly: 'Read-only', saveFailed: 'Save failed', discard: 'Discard', save: 'Save', saving: 'Saving…',
  overridden: 'Overridden',
}
