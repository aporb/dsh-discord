import type { Context } from '@deepseek-ai/cordis'

import {
  DEFAULT_DISCORD_SETTINGS,
  DiscordSettingsSchema,
  bindDiscordSettings,
  type DiscordSettings,
  } from './settings.js'
import { installCancellationRoot } from './lifecycle.js'
import { ALLOWED_MENTIONS_NONE, DISCORD_SUPPRESS_NOTIFICATIONS_FLAG, OUTBOUND_EPHEMERAL_FLAGS, discordChannelNameKey, safeTitle } from './policy/disclosure.js'
import { validateHostCapabilities } from './startup.js'
import {
  createAdapterStatusTracker,
  installAdapterStatusRpc,
} from './features/adapter-status.js'
import { DISCORD_BOT_TOKEN_REF, describeDiscordCredential, resolveDiscordBotToken, type DiscordCredentialProvider } from './credential.js'
import { importHermesBootstrap } from './credential-import.js'
import { diag } from './diag.js'
import { createSharedRestClient, newNonce, type SharedRestClient } from './discord/rest.js'
import { createRestThreadPort } from './discord/thread-port.js'
import { createComponentRegistry } from './discord/components.js'
import { buildCommandRegistrations } from './discord/commands.js'
import { startDiscordAdapter, type BindingsProbe, type DiscordAdapterRuntime } from './compose.js'
import { createModelPort, createPermissionPort, createWorkspaceCatalogPort, createWorkspaceResolver, readWorkspaceDetail, promptSession, createSessionViaProxy, cancelSessionViaProxy, steerSession, removeQueueItemViaProxy, resolveHostFace } from './dsh/host-face.js'
import { createApprovalStore, type ApprovalRecord } from './features/approval-store.js'
import { createAskWiring, questionItemsOf } from './features/ask-wiring.js'
import { sweepExpiredApprovals } from './features/approval-expiry.js'
import { sweepExpiredQuestions, type DshTurnCancelPort } from './features/question-expiry.js'
import { createQuestionStore, questionBoundsError } from './features/question-store.js'
import { createTrailingSingleFlight } from './features/single-flight.js'
import { ADAPTER_VERSION } from './version.js'
import { handleSelectInput, handleModalSubmit, type QuestionRoutingDeps } from './features/question-routing.js'
import { attachmentRejectionCopy, createCopy, permissionPresetLabel, type CopyTable } from './i18n.js'
import type { DshApprovalRespondPort } from './features/approval-routing.js'
import { createInteractionRouter } from './features/interaction-router.js'
import { channelBindingKey, parseChannelBindingKey, threadBindingKey, parseThreadBindingKey, discordDomainSpec, CHANNEL_BINDINGS_TABLE, THREAD_BINDINGS_TABLE, INTENTS_TABLE } from './state/domain.js'
import { planBindingReconciliation, refineUnlistedThreadFacts } from './features/reconcile-bindings.js'
import { guildKeysToForget, sweepExpired } from './state/retention.js'
import { staleUncertainIntents } from './features/reconcile-intents.js'
import { createHostEventRouter, type TrackSeedOptions } from './dsh/host-events.js'
import { listSessionIds, listSessionSummaries, type SessionResumeRow } from './dsh/host-face.js'
import { installAskServicePatches } from './dsh/host-asks.js'
import { createBindingStore, renderWatermarkSeed } from './state/bindings.js'
import { createIntentStore, type InboundIntentRecord, type IntentTable } from './state/intents.js'
import type { BindingTable } from './state/bindings.js'
import { createTurnTracker } from './features/turn-ownership.js'
import { createThreadCreationFlow, type DiscordThreadPort } from './features/thread-creation.js'
import { createSessionCreationFlow, type DshSessionPort } from './features/session-creation.js'
import { createResumeCandidatesPort } from './features/session-resume.js'
import { createPromptSubmissionFlow, type DshPromptPort } from './features/prompt-submission.js'
import { createSessionMainline, requestIdFor, type MainlineFileCollector, type MainlineImageCollector } from './features/session-mainline.js'
import { isPickerSession, shortId, workspaceChoices, type PickerSessionRow } from './features/session-picker.js'
import { collectImages, createSafeImageDownloadPort } from './features/image-collection.js'
import { collectFiles, stripAttachedFileBlocks } from './features/file-collection.js'
import { createHttpFetchPort } from './features/image-download.js'
import { startLiveRender } from './stream/live.js'
import type { ChannelBinding, ThreadBinding } from './state/records.js'
import type { PolicyTable } from './policy/authorization.js'
import { planWorkspaceChannel, workspaceChannelName, type ChannelBindingState } from './features/workspace-channel.js'
import type { GatewaySocket } from './gateway/gateway.js'

/** Stable Cordis plugin name for diagnostics. */
export const name = 'dsh-discord'

/** Host services required by the complete embedded adapter. */
export const inject = ['sessionController', 'workspaceController', 'sessionQuery', 'webServer', 'credentials', 'settings', 'storageDomain', 'connection']

export type Config = DiscordSettings

/**
 * The plugin's static Config (0.1.7 profile-backed forms): every field is
 * volatile, so the Host delivers each as a stable live reference instead of
 * remounting the fiber on writes. The annotation is deliberately absent —
 * schemastery's volatile mode types field defaults as `Volatile<T>`, which a
 * `z<DiscordSettings>` annotation cannot express.
 */
export const Config = DiscordSettingsSchema

/**
 * Fixed Milestone 1 Gateway intents: guilds, messages, content. Member data
 * rides MESSAGE_CREATE/INTERACTION_CREATE payloads, so the privileged
 * GUILD_MEMBERS bit (1 << 1) is not requested — without the Dev Portal
 * toggle Discord rejects identify with 4014, which is terminal for us.
 */
const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15)

/**
 * Emit through the Host's logger service only when it is actually wired:
 * bare or fake Cordis contexts must not turn an error path into an
 * unhandled rejection.
 */
function emitLog(ctx: Context, level: 'debug' | 'warn', message: unknown): void {
  const logger = ctx.logger as Partial<Record<'debug' | 'warn', unknown>> | undefined
  const emit = logger?.[level]
  if (typeof emit === 'function') (emit as (message: unknown) => void).call(logger, message)
}

/**
 * Mount the embedded Discord adapter. Composition of the runtime path
 * (Gateway → ingress → command/mention dispatch → Discord REST, plus the
 * reconciliation sweeps) lives in `src/compose.ts` and is started from here.
 */
export function apply(ctx: Context, config: Config = DEFAULT_DISCORD_SETTINGS): void {
  diag('apply-enter')
  validateHostCapabilities(name => ctx.get(name))
  installCancellationRoot(ctx)
  /** Discord-visible copy (this fork ships English only). */
  const copy: CopyTable = createCopy()
  // Reassigned once the async composition has built the real registrar.
  let registerCommands: () => void = () => {}
  const onGuildsChanged = (): void => { registerCommands() }
  const settingsSource = bindDiscordSettings(ctx, config as unknown as Readonly<Record<string, unknown>>, (next) => {
    const guildsChanged = next.allowedGuildIds.join(',') !== current.allowedGuildIds.join(',')
    current = next
    if (guildsChanged) onGuildsChanged()
    emitLog(ctx, 'debug', {
      event: 'discord_settings_applied',
      enabled: current.enabled,
      allowedGuildCount: current.allowedGuildIds.length,
    })
  })
  let current = settingsSource.get()

  // The settings card's status surface: credential presence seeded now, the
  // Gateway observation fed by the adapter composition as it starts.
  // Services resolve through the same accessor the startup boundary probes.
  const statusTracker = createAdapterStatusTracker()
  // Late-bound so the management channel can reach the runtime built inside
  // the composition IIFE below (the card's Connect button).
  const runtimeRef: { current: DiscordAdapterRuntime | undefined } = { current: undefined }
  // Channel registration mounts a prefix route through our OWN context
  // effect (see installAdapterStatusRpc: the host's connection.rpc.handle
  // is owner-scoped and unusable from an external plugin).
  {
    installAdapterStatusRpc(ctx, statusTracker, {
      tracker: statusTracker,
      setToken: async (value: string) => {
        await (ctx.get('credentials') as DiscordCredentialProvider).set(DISCORD_BOT_TOKEN_REF, value)
        statusTracker.setCredential({ configured: true })
      },
      connect: () => { runtimeRef.current?.connect() },
      disconnect: () => { runtimeRef.current?.disconnect() },
    })
  }
  void describeDiscordCredential(ctx.get('credentials') as DiscordCredentialProvider)
    .then((view) => { statusTracker.setCredential(view) })
    .catch((cause: unknown) => {
      emitLog(ctx, 'warn', { event: 'discord_credential_probe_failed', cause: String(cause) })
      statusTracker.setCredential({ configured: false })
    })

  const credentials = ctx.get('credentials') as DiscordCredentialProvider
  // The in-process 0.1.6 controller face: plain requests in, plain values
  // out, business rejections as thrown RemoteErrors; boundedness and outcome
  // logging live in src/dsh/host-face.ts.
  const dsh = resolveHostFace(ctx)
  // Default-quiet logging (16.33): flow records ride the Host's debug level
  // only — the adapter prints nothing into the DSH process at the default
  // level. Failure-shaped events (…failed/…threw/…blocked/…unknown) escalate
  // to warn so a default-level Host still surfaces them.
  const rpcLog = (event: string, detail?: unknown): void => {
    const serialized = typeof detail === 'string' ? detail : JSON.stringify(detail ?? null)
    if (process.env['DSH_DISCORD_TRACE'] === '1') {
      console.error(`[dsh-discord:trace] ${event}:`, serialized)
    }
    emitLog(ctx, /(?:failed|threw|blocked|unknown)/.test(event) ? 'warn' : 'debug', { event, detail: serialized })
  }
  // The 0.1.6 event bridge (declared early: every session-acquisition site
  // below tracks into it; the live renderer consumes its fan-in stream).
  const hostEvents = createHostEventRouter(dsh.session, { log: rpcLog })
  void (async () => {
    diag('composition-start')
    // The durable domain gates the whole composition: no adapter starts
    // without its bindings/intents tables, and close() drains queued writes
    // on teardown (fail-closed across restarts, design §10).
    const domain = await ctx.storageDomain.open(discordDomainSpec)
    diag('domain-open')
    ctx.effect(() => () => { void domain.close() }, 'discord durable domain')

    const catalogPort = createWorkspaceCatalogPort(dsh, { log: rpcLog })

    // ── Fork addition: one-time bootstrap from the retired hermes install ──
    // The stopped hermes gateway still owns the bot identity, the operator
    // allowlist and the home channel. Import them once into the Host
    // credential service and the settings document, then connect. All of it
    // is best-effort: the settings card remains the manual fallback.
    const settingsService = ctx.get('settings') as {
      describe?: (options?: { redactSecrets?: boolean }) => Array<{ ns: unknown; value: unknown; revision: number }>
      update?: (ns: string, patch: object, expectedRevision?: number) => Promise<void>
    } | undefined
    try {
      const bootstrap = await importHermesBootstrap({
        describeToken: () => describeDiscordCredential(credentials),
        storeToken: value => credentials.set(DISCORD_BOT_TOKEN_REF, value),
        readSettings: async () => {
          const ids = (input: unknown): string[] => Array.isArray(input)
            ? input.filter((item): item is string => typeof item === 'string')
            : []
          // The settings catalog only lists ACTIVE fibers and throws before
          // the Loader settles; a plugin activated early in boot must wait
          // for its own row instead of reading a half-built projection.
          for (let attempt = 0; attempt < 10; attempt += 1) {
            try {
              const rows = settingsService?.describe?.({ redactSecrets: true })
              if (Array.isArray(rows)) {
                const row = rows.find(entry => entry.ns === 'dsh-discord')
                if (row !== undefined) {
                  const value = (row.value ?? {}) as { allowedGuildIds?: unknown; memberUserIds?: unknown }
                  return {
                    allowedGuildIds: ids(value.allowedGuildIds),
                    memberUserIds: ids(value.memberUserIds),
                    revision: row.revision,
                  }
                }
              }
            } catch {
              // Loader not settled yet; retry below.
            }
            await new Promise<void>(resolve => { setTimeout(resolve, 200) })
          }
          diag('settings-projection-unavailable')
          return undefined
        },
        writeSettings: async (patch, revision) => {
          if (settingsService?.update === undefined) throw new TypeError('the Host settings service cannot be reached')
          let currentRevision = revision
          let lastError: unknown
          // A plugin mounted by the plugin manager applies INSIDE an HMR
          // transaction; the settings document write is refused there
          // ("HMR transactions cannot be nested"). Wait for the transaction
          // to settle and retry, so a hot install self-heals without a
          // host restart.
          for (let attempt = 0; attempt < 8; attempt += 1) {
            try {
              await settingsService.update('dsh-discord', patch, currentRevision)
              return
            } catch (cause) {
              lastError = cause
              if (!(cause instanceof Error) || !/HMR transactions cannot be nested/u.test(cause.message)) throw cause
              await new Promise<void>(resolve => {
                const timer = setTimeout(resolve, 750)
                timer.unref()
              })
              // Reading the revision again can hit the same transaction
              // guard; that failure must not escape the retry loop.
              try {
                const rows = settingsService.describe?.({ redactSecrets: true })
                const row = Array.isArray(rows) ? rows.find(entry => entry.ns === 'dsh-discord') : undefined
                if (row !== undefined) currentRevision = row.revision
              } catch {
                // Keep the last known revision; the next attempt reports.
              }
            }
          }
          throw lastError instanceof Error ? lastError : new Error(String(lastError))
        },
        resolveGuildForChannel: async channelId => {
          const token = await resolveDiscordBotToken(credentials)
          if (token === undefined) return undefined
          const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`, {
            headers: { Authorization: `Bot ${token}` },
          })
          if (!response.ok) return undefined
          const body = (await response.json()) as { guild_id?: unknown }
          return typeof body.guild_id === 'string' ? body.guild_id : undefined
        },
        log: (event, detail) => { rpcLog(event, detail) },
      })
      diag('bootstrap-result', bootstrap)
      rpcLog('discord_hermes_bootstrap', bootstrap)
      if (bootstrap.token === 'imported' || bootstrap.allowlist === 'seeded') {
        void describeDiscordCredential(credentials)
          .then(view => { statusTracker.setCredential(view) })
          .catch(() => {})
      }
    } catch (cause: unknown) {
      diag('bootstrap-failed', String(cause))
      emitLog(ctx, 'warn', { event: 'discord_hermes_bootstrap_failed', cause: String(cause) })
    }
    const policy = (): PolicyTable => ({
      allowedGuildIds: [...current.allowedGuildIds],
      memberUserIds: [...current.memberUserIds],
      memberRoleIds: [...current.memberRoleIds],
      administratorUserIds: [...current.administratorUserIds],
      administratorRoleIds: [...current.administratorRoleIds],
      deniedUserIds: [...current.deniedUserIds],
      deniedRoleIds: [...current.deniedRoleIds],
      hostOperatorUserIds: [...current.hostOperatorUserIds],
    })

    // Channel→Workspace and Thread→Session bindings, inbound-intent records,
    // and the adapter-owned turn tracker. The first three are DURABLE through
    // the storage-domain tables opened above (design §10); reads are
    // synchronous from the domain's in-memory projection, writes queue on
    // its durable chain. queueSnapshots stays process-local by design. The
    // Discord application id equals the bot user id, resolved at start.
    const applicationIdRef: { current: string } = { current: 'dsh-discord' }
    // Durable tables carry the store contracts PLUS snapshot iteration
    // (reconciliation sweeps and guild-forget scan by parsed key parts).
    type DurableBindingTable<V> = BindingTable<V> & {
      entries(): IterableIterator<[string, V]>
      keys(): IterableIterator<string>
    }
    type DurableIntentTable = IntentTable & {
      entries(): IterableIterator<[string, InboundIntentRecord]>
      delete(key: string): Promise<boolean>
    }
    const channelTable = domain.table(CHANNEL_BINDINGS_TABLE) as unknown as DurableBindingTable<ChannelBinding>
    const threadTable = domain.table(THREAD_BINDINGS_TABLE) as unknown as DurableBindingTable<ThreadBinding>
    const intentTable = domain.table(INTENTS_TABLE) as unknown as DurableIntentTable
    const bindingStore = createBindingStore<ChannelBinding>(channelTable)
    const threadBindingStore = createBindingStore<ThreadBinding>(threadTable)
    const intents = createIntentStore(intentTable)
    const turnTracker = createTurnTracker()
    // Replay-fence (replay-fence-and-user-input D1/D2): the process start
    // mark separates "binding created in-process" (fresh thread, render full
    // history) from "binding from an earlier process" (its thread already
    // shows that history; catch-up must not re-deliver it).
    const processStartMs = Date.now()
    /**
     * The full reverse lookup the watermark paths need: binding key, parsed
     * scope, and record for one session's owning thread (bindings are 1:1).
     */
    const threadBindingForSession = (sessionId: string): { key: string; scope: { threadId: string }; record: ThreadBinding } | undefined => {
      for (const [key, record] of threadTable.entries()) {
        if (record.sessionId !== sessionId) continue
        const scope = parseThreadBindingKey(key)
        if (scope !== undefined) return { key, scope, record }
      }
      return undefined
    }
    /**
     * Durable catch-up seeding (D2), derived per record by
     * `renderWatermarkSeed` — see state/bindings.ts.
     */
    const trackSeedForRecord = (record: ThreadBinding): TrackSeedOptions | undefined =>
      renderWatermarkSeed(record, processStartMs)
    const trackSeedFor = (sessionId: string): TrackSeedOptions | undefined => {
      const found = threadBindingForSession(sessionId)
      return found === undefined ? undefined : trackSeedForRecord(found.record)
    }
    /**
     * Advance the owning thread's durable render watermark (D5): one
     * revision-fenced write per turn boundary. A lost fence race is
     * abandoned and retried at the next boundary — the watermark is a
     * monotonic upper bound, so one lost write only widens the crash
     * window's bounded re-render suffix.
     */
    const persistRenderedSeq = (sessionId: string, renderedSeq: number): Promise<void> => {
      const found = threadBindingForSession(sessionId)
      if (found === undefined) return Promise.resolve()
      const { key, record } = found
      if (renderedSeq <= (record.renderedSeq ?? 0)) return Promise.resolve()
      return threadBindingStore.bind(key, {
        sessionId: record.sessionId,
        workspaceId: record.workspaceId,
        createdBy: record.createdBy,
        createdAtMs: record.createdAtMs,
        renderedSeq,
      }, { expectedRevision: record.revision }).then(outcome => {
        if (!outcome.ok) rpcLog('discord_render_watermark_skipped', { sessionId, error: outcome.error })
      }).catch((cause: unknown) => {
        rpcLog('discord_render_watermark_threw', { sessionId, cause: String(cause) })
      })
    }
    // Approvals: process-local backing (minutes-lived; DSH replays pending
    // asks on mux reopen). turnActors maps submitted request ids to their
    // Discord authors — the ownership fact for approval/question clicks.
    const approvalRows = new Map<string, ApprovalRecord>()
    const approvalsStore = createApprovalStore({
      get: key => approvalRows.get(key),
      put: (key, record) => {
        approvalRows.set(key, record)
        return Promise.resolve()
      },
    })
    const questionsStore = createQuestionStore()
    const turnActors = new Map<string, string>()
    const sharedRegistry = createComponentRegistry()
    const questionCancelPort: DshTurnCancelPort = {
      cancel: async ({ sessionId }) => {
        const cancelled = await cancelSessionViaProxy(dsh, { sessionId }, { log: rpcLog })
        const turn = turnTracker.active(sessionId)
        if (turn !== undefined) turnTracker.complete(turn.requestId)
        return cancelled.outcome === 'accepted'
          ? { outcome: 'accepted' as const }
          : cancelled.outcome === 'rejected'
            ? { outcome: 'rejected' as const, reason: cancelled.reason }
            : { outcome: 'unknown' as const }
      },
    }
    const askWiring = createAskWiring({
      registry: sharedRegistry,
      approvals: approvalsStore,
      questions: questionsStore,
      cancelPort: questionCancelPort,
      copy,
      nowMs: () => Date.now(),
      log: rpcLog,
      activeTurnRequestId: sessionId => turnTracker.active(sessionId)?.requestId,
      turnActor: requestId => turnActors.get(requestId),
      threadOwner: threadId => {
        for (const key of threadTable.keys()) {
          if (!key.endsWith(`:${threadId}`)) continue
          const createdBy = threadTable.get(key)?.createdBy
          if (typeof createdBy === 'string' && createdBy !== '') return createdBy
        }
        return undefined
      },
      postMessage: async (threadId, payload) => {
        const rest = await sharedRest()
        if (rest === undefined) return { stored: false, reason: 'rest unavailable' }
        const sent = await rest.request<{ id?: string } | undefined>('POST', `/channels/${threadId}/messages`, payload)
        if (sent.outcome !== 'completed') {
          return {
            stored: false,
            reason: sent.outcome === 'rejected'
              ? `HTTP ${String(sent.status)} ${sent.error.message}`
              : sent.reason,
          }
        }
        if (typeof sent.body?.id !== 'string') return { stored: false, reason: `HTTP ${String(sent.status)}: response missing message id` }
        return { stored: true, messageId: sent.body.id }
      },
      editMessage: async (channelId, messageId, payload) => {
        const rest = await sharedRest()
        if (rest === undefined) return { stored: false, reason: 'rest unavailable' }
        const patched = await rest.request('PATCH', `/channels/${channelId}/messages/${messageId}`, payload)
        if (patched.outcome !== 'completed') {
          return {
            stored: false,
            reason: patched.outcome === 'rejected'
              ? `HTTP ${String(patched.status)} ${patched.error.message}`
              : patched.reason,
          }
        }
        return { stored: true }
      },
    })
    const componentFollowUp = async (_interactionId: string, interactionToken: string, content: string): Promise<void> => {
      const rest = await sharedRest()
      if (rest === undefined) return
      const posted = await rest.request('POST', `/webhooks/${applicationIdRef.current}/${interactionToken}`, { content, flags: OUTBOUND_EPHEMERAL_FLAGS })
      if (posted.outcome !== 'completed') {
        rpcLog('discord_followup_failed', posted.outcome === 'rejected' ? `HTTP ${String(posted.status)}` : posted.reason)
      }
    }
    const bindings: BindingsProbe = {
      workspaceForChannel: (guildId, channelId) =>
        bindingStore.get(channelBindingKey({
          applicationId: applicationIdRef.current, guildId, channelId,
        }))?.workspaceId,
      sessionForThread: (guildId, threadId) =>
        threadBindingStore.get(threadBindingKey({
          applicationId: applicationIdRef.current, guildId, threadId,
        }))?.sessionId,
    }

    // ── Session mainline: mention → thread → session → prompt → turn ──────
    const restThreadPort: DiscordThreadPort = (() => {
      const port = createRestThreadPort({
        request: async (method, path, body) => {
          const rest = await sharedRest()
          if (rest === undefined) return { outcome: 'unknown', reason: 'network-unreachable' }
          return rest.request(method, path, body)
        },
      }, { autoArchiveMinutes: () => current.threadAutoArchiveMinutes })
      return {
        ...port,
        // The join only affects sidebar visibility, but a silent refusal is
        // still indistinguishable from a working one — log it (runbook rule).
        joinThread: async (request) => {
          const joined = await port.joinThread(request)
          if (joined.outcome !== 'completed') {
            rpcLog('discord_thread_join_failed', request)
          }
          return joined
        },
      }
    })()
    const dshSessionPort: DshSessionPort = {
      createSession: async request => {
        const created = await createSessionViaProxy(dsh, request, { log: rpcLog })
        if (created.outcome === 'completed') hostEvents.track(created.sessionId)
        return created
      },
    }
    const dshPromptPort: DshPromptPort = {
      submit: async request => {
        const submitted = await promptSession(
          dsh,
          {
            sessionId: request.sessionId,
            prompt: request.prompt,
            ...(request.images === undefined ? {} : { images: request.images }),
            ...(request.textParts === undefined ? {} : { textParts: request.textParts }),
          },
          { log: rpcLog, rpcId: request.requestId },
        )
        if (submitted.outcome === 'accepted') hostEvents.track(request.sessionId, trackSeedFor(request.sessionId))
        return submitted
      },
    }
    /**
     * The bounded image collection boundary (16.50): downloads ride the
     * safe-download port (allowlisted CDN hosts, capped sizes, timeout) and
     * come back base64-encoded for the prompt parts.
     */
    const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000
    const imageCollector: MainlineImageCollector = {
      collect: async ({ attachments }) => {
        const result = await collectImages(createSafeImageDownloadPort(), {
          nowMs: Date.now(),
          timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
          attachments,
        })
        if (result.outcome !== 'collected') {
          const reason = result.outcome === 'too-large' ? `too-large:${result.reason}` : result.outcome
          return { outcome: 'failed', reason }
        }
        return {
          outcome: 'collected',
          images: result.downloaded.map(image => ({
            mediaType: image.mediaType,
            base64: Buffer.from(image.body).toString('base64'),
          })),
        }
      },
    }
    /**
     * Bounded text-file collection (16.114): the same CDN allowlist as
     * images, stricter byte caps, strict UTF-8 decoding, and labelled text
     * parts that the echo redactor strips back out.
     */
    const FILE_DOWNLOAD_TIMEOUT_MS = 10_000
    const fileCollector: MainlineFileCollector = {
      collect: async ({ attachments }) => {
        const result = await collectFiles(createHttpFetchPort(), {
          nowMs: Date.now(),
          timeoutMs: FILE_DOWNLOAD_TIMEOUT_MS,
          attachments,
        })
        if (result.outcome !== 'collected') {
          const reason = result.outcome === 'too-large' ? `too-large:${result.reason}` : result.outcome
          return { outcome: 'failed', reason }
        }
        return { outcome: 'collected', texts: result.texts }
      },
    }
    const threadFlow = createThreadCreationFlow({
      intents,
      discord: restThreadPort,
      nowMs: () => Date.now(),
    })
    const sessionFlow = createSessionCreationFlow({
      sessions: dshSessionPort,
      threadBindings: threadBindingStore,
      newSessionId: () => crypto.randomUUID(),
    })
    const composedMainline = createSessionMainline({
      threads: threadFlow,
      sessions: sessionFlow,
      prompts: createPromptSubmissionFlow({
        prompts: dshPromptPort,
        intents,
        nowMs: () => Date.now(),
      }),
      turns: turnTracker,
      images: imageCollector,
      files: fileCollector,
    })
    /** Mainline outcome → copy key; the string resolves live per language. */
    const MAINLINE_FAILURE_KEYS = {
      'thread-conflict': 'mainlineThreadConflict',
      'thread-failed': 'mainlineThreadFailed',
      'session-rejected': 'mainlineSessionRejected',
      'session-unknown': 'mainlineSessionUnknown',
      'prompt-rejected': 'mainlinePromptRejected',
      'prompt-unknown': 'mainlinePromptUnknown',
      'image-failed': 'mainlineImageFailed',
      'file-failed': 'mainlineFileFailed',
    } as const satisfies Record<string, keyof CopyTable>
    const mainline = {
      admitMention: async (request: Parameters<typeof composedMainline.admitMention>[0]) => {
        const result = await composedMainline.admitMention(request)
        if (result.outcome === 'admitted') {
          // Ownership fact: this request id's turn belongs to this author —
          // approval/question clicks authorize against it.
          turnActors.set(requestIdFor(request.messageId), request.authorId)
          rpcLog('discord_mention_admitted', { messageId: request.messageId, threadId: result.threadId, sessionId: result.sessionId })
        } else {
          rpcLog('discord_mention_not_admitted', { messageId: request.messageId, outcome: result.outcome })
          const notice = result.outcome === 'prompt-rejected'
            ? (attachmentRejectionCopy(result.code, result.detail, copy) ?? copy[MAINLINE_FAILURE_KEYS[result.outcome]])
            : copy[MAINLINE_FAILURE_KEYS[result.outcome]]
          void withRest(rest => rest.request('POST', `/channels/${request.channelId}/messages`, { content: notice, flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG, allowed_mentions: ALLOWED_MENTIONS_NONE }))
            .catch((cause: unknown) => { rpcLog('discord_mainline_notice_failed', String(cause)) })
        }
        return result
      },
      continueInThread: async (request: Parameters<typeof composedMainline.continueInThread>[0]) => {
        const result = await composedMainline.continueInThread(request)
        if (result.outcome === 'rejected' || result.outcome === 'unknown' || result.outcome === 'image-failed' || result.outcome === 'file-failed') {
          rpcLog('discord_continuation_not_queued', { messageId: request.messageId, outcome: result.outcome })
          const notice = result.outcome === 'rejected'
            ? (attachmentRejectionCopy(result.code, result.detail, copy) ?? copy.continuationRejected)
            : result.outcome === 'image-failed'
              ? copy.mainlineImageFailed
              : result.outcome === 'file-failed'
                ? copy.mainlineFileFailed
                : copy.continuationUnknown
          void withRest(rest => rest.request('POST', `/channels/${request.threadId}/messages`, { content: notice, flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG, allowed_mentions: ALLOWED_MENTIONS_NONE }))
            .catch((cause: unknown) => { rpcLog('discord_mainline_notice_failed', String(cause)) })
        }
        return result
      },
    }

    // Bind provision resolves the selection against the live catalog; the
    // Discord confirm button carries only opaque registry ids between the
    // command and the write.
    const resolver = createWorkspaceResolver(dsh, { log: rpcLog })

    // Adapter-owned guild surfaces: the "DeepSeek Harness" category, the
    // general control channel (both provisioned on READY), and — on bind —
    // one channel per Workspace, named after its display title. Nothing
    // outside the category is ever touched.
    const CATEGORY_NAME = 'DeepSeek Harness'
    type GuildChannel = { id: string; name: string; type: number; parent_id?: string }
    const ensureCategory = async (
      rest: SharedRestClient,
      guildId: string,
    ): Promise<{ channels: GuildChannel[]; categoryId: string } | undefined> => {
      const listed = await rest.request<GuildChannel[]>('GET', `/guilds/${guildId}/channels`)
      if (listed.outcome !== 'completed') return undefined
      const channels = listed.body
      let category = channels.find((c) => c.type === 4 && c.name.toLowerCase() === CATEGORY_NAME.toLowerCase())
      if (category === undefined) {
        const made = await rest.request<GuildChannel>('POST', `/guilds/${guildId}/channels`, { name: CATEGORY_NAME, type: 4 })
        if (made.outcome !== 'completed') return undefined
        category = made.body
      }
      return { channels, categoryId: category.id }
    }
    /**
     * ONE process-wide REST client, rebuilt only when the resolved token
     * changes. Per-route serialization lives inside the client, so concurrent
     * sends/edits/typing into one channel queue behind each other instead of
     * racing the bucket; every composition path goes through here.
     */
    let sharedRestCache: { token: string; client: SharedRestClient } | undefined
    const sharedRest = async (): Promise<SharedRestClient | undefined> => {
      const token = (await resolveDiscordBotToken(credentials)) ?? ''
      if (token === '') return undefined
      if (sharedRestCache?.token !== token) {
        const apiBase = process.env['DSH_DISCORD_REST_BASE']
        sharedRestCache = {
          token,
          client: createSharedRestClient({ token, ...(apiBase === undefined ? {} : { apiBase }) }),
        }
      }
      return sharedRestCache.client
    }
    const withRest = async <T>(
      run: (rest: SharedRestClient) => Promise<T>,
    ): Promise<T | undefined> => {
      const rest = await sharedRest()
      if (rest === undefined) return undefined
      return run(rest)
    }
    /**
     * Reconcile an unobservable message send (rest.ts contract): the send
     * carried a nonce, so a message that actually landed is findable among
     * the channel's recent messages — authored by this bot. `undefined`
     * means the outcome stays unobservable (no evidence either way).
     */
    const findSentMessageByNonce = async (
      rest: SharedRestClient,
      channelId: string,
      nonce: string,
    ): Promise<string | undefined> => {
      // The list body is untrusted wire data: narrow every row by shape.
      const listed = await rest.request<unknown>('GET', `/channels/${channelId}/messages?limit=50`)
      if (listed.outcome !== 'completed' || !Array.isArray(listed.body)) return undefined
      for (const row of listed.body) {
        if (typeof row !== 'object' || row === null) continue
        const record = row as Record<string, unknown>
        if (record['nonce'] !== nonce) continue
        const author = record['author']
        if (typeof author !== 'object' || author === null) continue
        if ((author as Record<string, unknown>)['id'] !== applicationIdRef.current) continue
        if (typeof record['id'] === 'string') return record['id']
      }
      return undefined
    }
    const bindChannelKey = (guildId: string, channelId: string): string =>
      channelBindingKey({ applicationId: applicationIdRef.current, guildId, channelId })
    /** The guild channel already serving this Workspace, if any (one-project-one-channel lookup). */
    const findBoundChannelFor = (guildId: string, workspaceId: string): string | undefined => {
      for (const [key, binding] of channelTable.entries()) {
        if (binding.workspaceId !== workspaceId) continue
        const scope = parseChannelBindingKey(key)
        if (scope?.guildId === guildId) return scope.channelId
      }
      return undefined
    }
    /**
     * Ensure the Workspace's home channel exists under the adapter category
     * and serves this Workspace (one-project-one-channel: the
     * Workspace's existing bound channel wins outright). A same-name channel
     * is reused only when unbound; a channel serving another Workspace is
     * never stolen — a `-2` sibling is created instead.
     */
    const ensureWorkspaceChannel = async (options: {
      guildId: string
      workspaceId: string
      title: string
      actorId: string
    }): Promise<{ channelId: string; created: boolean } | undefined> => {
      return withRest(async (rest) => {
        const ensured = await ensureCategory(rest, options.guildId)
        if (ensured === undefined) return undefined
        // The control channel (general, the control-channel analog) is
        // the command surface — it must never become a Workspace home.
        const controlChannelId = ensured.channels.find((c) => c.type === 0 && c.name.toLowerCase() === 'general' && c.parent_id === ensured.categoryId)?.id
        const bindingOf = (channelId: string): ChannelBindingState => {
          if (channelId === controlChannelId) return 'other-workspace'
          const bound = bindingStore.get(bindChannelKey(options.guildId, channelId))
          if (bound === undefined) return 'unbound'
          return bound.workspaceId === options.workspaceId ? 'this-workspace' : 'other-workspace'
        }
        const existing = findBoundChannelFor(options.guildId, options.workspaceId)
        const record = { workspaceId: options.workspaceId, boundBy: options.actorId, boundAtMs: Date.now() }
        const placement = planWorkspaceChannel({
          channels: ensured.channels.map((c) => ({ id: c.id, name: c.name, parentId: c.parent_id })),
          categoryId: ensured.categoryId,
          desiredName: workspaceChannelName(options.title),
          bindingOf,
          existingForWorkspace: existing,
        })
        if (placement.outcome === 'reuse') {
          if (placement.needsBind) {
            await bindingStore.bind(bindChannelKey(options.guildId, placement.channelId), record)
          }
          return { channelId: placement.channelId, created: false }
        }
        const made = await rest.request<GuildChannel>('POST', `/guilds/${options.guildId}/channels`, {
          name: placement.name,
          type: 0,
          parent_id: ensured.categoryId,
        })
        if (made.outcome !== 'completed') {
          rpcLog('discord_workspace_channel_create_failed', made.outcome === 'rejected' ? `HTTP ${String(made.status)}` : made.reason)
          return undefined
        }
        await bindingStore.bind(bindChannelKey(options.guildId, made.body.id), record)
        return { channelId: made.body.id, created: true }
      })
    }

    // ── Reconciliation (reconciliation spec): on READY, verify every
    // persisted mapping against the DSH baseline and Discord's live
    // surface. Retirement ever deletes only adapter records; unverifiable
    // mappings stay blocked (logged) rather than guessed away.
    let reconciling = false
    const reconcileOnReady = async (): Promise<void> => {
      if (reconciling) return
      reconciling = true
      try {
        const rest = await sharedRest()
        if (rest === undefined) return
        const catalog = await catalogPort.listWorkspaces()
        if (catalog.outcome !== 'completed') {
          rpcLog('discord_reconcile_blocked', 'workspace-catalog-unavailable')
          return
        }
        const sessionIds = await listSessionIds(dsh, { log: rpcLog })
        if (sessionIds.outcome !== 'completed') {
          rpcLog('discord_reconcile_blocked', 'session-list-unavailable')
          return
        }
        for (const guildId of current.allowedGuildIds) {
          const facts: Record<string, 'ok' | 'missing' | 'unknown'> = {}
          const channelRows: GuildChannel[] = []
          const channels = await rest.request<GuildChannel[]>('GET', `/guilds/${guildId}/channels`)
          const listed = channels.outcome === 'completed'
          if (listed) {
            channelRows.push(...channels.body)
            for (const channel of channels.body) facts[channel.id] = 'ok'
            const threads = await rest.request<{ threads?: Array<{ id: string }> } | undefined>('GET', `/guilds/${guildId}/threads/active`)
            if (threads.outcome === 'completed' && Array.isArray(threads.body?.threads)) {
              for (const thread of threads.body.threads) facts[thread.id] = 'ok'
            }
          }
          // This guild's bindings only: another guild's pass must never
          // judge (or retire) this guild's mappings against its own facts.
          const channelKeyById = new Map<string, string>()
          const threadKeyById = new Map<string, string>()
          for (const key of channelTable.keys()) {
            const scope = parseChannelBindingKey(key)
            if (scope?.guildId !== guildId || scope.channelId === '') continue
            channelKeyById.set(scope.channelId, key)
          }
          for (const key of threadTable.keys()) {
            const scope = parseThreadBindingKey(key)
            if (scope?.guildId !== guildId || scope.threadId === '') continue
            threadKeyById.set(scope.threadId, key)
          }
          // Verified absence: the listing succeeded and the channel is gone.
          if (listed) {
            for (const channelId of channelKeyById.keys()) {
              if (facts[channelId] === undefined) facts[channelId] = 'missing'
            }
            // The active-thread listing drops Discord-archived threads too,
            // so an unlisted thread binding is *absent evidence*, not
            // deletion — one direct channel probe each settles it (16.104):
            // 404 retires the orphan (deleting a bound channel kills every
            // thread under it), 200 keeps it (archived threads are still the
            // binding's live surface), anything else stays unverified.
            const unlistedThreads = [...threadKeyById.keys()].filter(threadId => facts[threadId] === undefined)
            if (unlistedThreads.length > 0) {
              const refined = await refineUnlistedThreadFacts(unlistedThreads, async threadId => {
                const probed = await rest.request<unknown>('GET', `/channels/${threadId}`)
                rpcLog('discord_reconcile_thread_probe', {
                  threadId,
                  outcome: probed.outcome === 'rejected' ? `http-${String(probed.status)}` : probed.outcome,
                })
                if (probed.outcome === 'completed') return { outcome: 'completed' as const }
                if (probed.outcome === 'rejected') return { outcome: 'rejected' as const, status: probed.status }
                return { outcome: 'unknown' as const }
              })
              Object.assign(facts, refined)
            }
          }

          // Default surface (16.34/16.37): the adapter's category and the
          // general control channel are ensured on every READY. Bound home
          // channels are NOT recreated — a Discord-side deletion is user
          // intent, so the verified absence marked above retires the
          // mapping in the plan below instead.
          const category = channelRows.find(channel => channel.type === 4 && channel.name.toLowerCase() === CATEGORY_NAME.toLowerCase())
            ?? await (async () => {
              const made = await rest.request<GuildChannel>('POST', `/guilds/${guildId}/channels`, { name: CATEGORY_NAME, type: 4 })
              if (made.outcome !== 'completed') {
                // Usually HTTP 403: the bot's roles lack Manage Channels.
                rpcLog('discord_category_ensure_failed', { guildId, cause: made.outcome === 'rejected' ? `HTTP ${String(made.status)}` : made.reason })
                return undefined
              }
              return made.body
            })()
          if (category !== undefined && channelRows.find(channel => channel.type === 0 && channel.name.toLowerCase() === 'general' && channel.parent_id === category.id) === undefined) {
            const made = await rest.request('POST', `/guilds/${guildId}/channels`, { name: 'general', type: 0, parent_id: category.id })
            if (made.outcome === 'completed') rpcLog('discord_control_channel_created', { guildId })
            else rpcLog('discord_control_channel_create_failed', { guildId, cause: made.outcome === 'rejected' ? `HTTP ${String(made.status)}` : made.reason })
          }

          const plan = planBindingReconciliation({
            channelBindings: [...channelTable.entries()].map(([key, record]) => {
              const scope = parseChannelBindingKey(key)
              return { channelId: scope?.channelId ?? '', ...record }
            }).filter(binding => binding.channelId !== '' && channelKeyById.has(binding.channelId)),
            threadBindings: [...threadTable.entries()].map(([key, record]) => {
              const scope = parseThreadBindingKey(key)
              return { threadId: scope?.threadId ?? '', ...record }
            }).filter(binding => binding.threadId !== '' && threadKeyById.has(binding.threadId)),
            baseline: {
              workspaces: catalog.workspaces.map(workspace => ({ workspaceId: workspace.id, title: workspace.title, path: '' })),
              sessionIds: sessionIds.ids,
            },
            discord: { channels: facts },
          })
          for (const action of plan.channelActions) {
            if (action.action !== 'retire') continue
            const key = channelKeyById.get(action.channelId)
            if (key === undefined) continue
            await channelTable.delete(key)
            rpcLog('discord_reconcile_channel_retired', { channelId: action.channelId, reason: action.reason })
          }
          for (const action of plan.threadActions) {
            if (action.action !== 'retire') continue
            const key = threadKeyById.get(action.threadId)
            if (key === undefined) continue
            await threadTable.delete(key)
            // The durable binding is gone: drop the thread's render state
            // too, or a later rebind inherits the stale watermark (the
            // message-loss direction the fence exists to prevent).
            liveRef.current?.dropThread(action.threadId)
            rpcLog('discord_reconcile_thread_retired', { threadId: action.threadId, reason: action.reason })
          }
        }
        // Replay fence (16.70): re-arm follow subscriptions for every
        // binding that survived reconciliation. Without a Discord-side
        // acquisition event this process (create/prompt/steer/resume), a
        // web-origin turn on a bound session would render into nothing —
        // the seeded floor keeps the opening snapshot from re-delivering
        // history the thread already shows, so only the missed suffix
        // (bounded by the last persisted turn boundary) catches up.
        for (const [, record] of threadTable.entries()) {
          hostEvents.track(record.sessionId, trackSeedForRecord(record))
        }
        rpcLog('discord_reconcile_done', {})
      } finally {
        reconciling = false
      }
    }

    // ── Retention sweep: completed intents age out on the durable table;
    // interaction records are still process-local stubs and thus omitted.
    const retentionTimer = setInterval(() => {
      const plan = sweepExpired(
        { intents: [...intentTable.entries()].map(([key, record]) => [key, record]), resolvedInteractions: [] },
        { nowMs: Date.now() },
      )
      for (const key of plan.intentKeys) {
        void intentTable.delete(key).then(() => {
          rpcLog('discord_retention_intent_expired', { key })
        }).catch((cause: unknown) => {
          rpcLog('discord_retention_intent_delete_failed', { key, cause: String(cause) })
        })
      }
      // Crash-parked (claimed) or unconfirmed (unknown) intents never age
      // out by design — surface the ones past the submission window so a
      // silently dropped prompt is diagnosable at warn level.
      const stale = staleUncertainIntents([...intentTable.entries()], Date.now(), 10 * 60_000)
      if (stale.length > 0) {
        rpcLog('discord_intent_stale_unknown', {
          count: stale.length,
          oldest: stale.reduce((max, item) => Math.max(max, item.ageMs), 0),
          messages: stale.slice(0, 10).map(item => `${item.messageId}:${item.state}`),
        })
      }
    }, 6 * 60 * 60_000)
    ctx.effect(() => () => { clearInterval(retentionTimer) }, 'discord retention sweep')
    // Approval/question expiry: 30s sweep — approvals auto-reject before
    // their controls expire; question expiry cancels the owning turn.
    const expiryTimer = setInterval(() => {
      // Component-registry hygiene rides the same cadence: lazy expiry
      // only fires when a stale custom_id is re-resolved, so never-clicked
      // controls (one ask registers 2-6 entries) would otherwise stay in
      // the registry for the process lifetime.
      const purged = sharedRegistry.purgeExpired(Date.now())
      if (purged > 0) rpcLog('discord_registry_purged', { purged })
      void sweepExpiredApprovals({
        store: approvalsStore,
        port: approvalRespondPort,
        controls: { disable: key => askWiring.disableControl(key) },
        nowMs: () => Date.now(),
      }).catch((cause: unknown) => { rpcLog('discord_approval_expiry_threw', String(cause)) })
      void sweepExpiredQuestions({
        store: questionsStore,
        cancelPort: questionCancelPort,
        controls: { disable: key => askWiring.disableControl(key) },
        nowMs: () => Date.now(),
      }).catch((cause: unknown) => { rpcLog('discord_question_expiry_threw', String(cause)) })
      // Settled question batches age out of the in-memory store (mirrors
      // the approval store's retention); unresolved ones stay by design.
      const prunedQuestions = questionsStore.pruneSettled(Date.now(), 7 * 24 * 60 * 60_000)
      if (prunedQuestions > 0) rpcLog('discord_question_store_pruned', { pruned: prunedQuestions })
      // Terminal approval rows age out of the process-local table too
      // (review B4): the store's in-memory index prunes itself, but the
      // row map held every id for the process lifetime.
      const approvalCutoff = Date.now() - 7 * 24 * 60 * 60_000
      for (const [approvalId, record] of [...approvalRows.entries()]) {
        if (record.state === 'pending') continue
        if (record.expiresAtMs > approvalCutoff) continue
        approvalRows.delete(approvalId)
      }
    }, 30_000)
    ctx.effect(() => () => { clearInterval(expiryTimer) }, 'discord interaction expiry sweep')


    const threadForSession = (sessionId: string): string | undefined =>
      threadBindingForSession(sessionId)?.scope.threadId

    // ── Fork addition: conversation picker + attach flows ────────────────
    /**
     * The mention that opened a picker thread, replayed as the first prompt
     * once a conversation is chosen. Process-local by design: a restart
     * loses only the not-yet-submitted prompt, and the mention text still
     * lives in the thread's starter message.
     */
    interface PendingPickerPrompt {
      messageId: string
      prompt: string
      images: Array<{ url: string; filename: string; declaredSize: number; contentType: string }>
      files: Array<{ url: string; filename: string; declaredSize: number; contentType: string }>
    }
    const pickerPending = new Map<string, PendingPickerPrompt>()
    const PICKER_TTL_MS = 15 * 60_000
    /** Attach renders roughly the last 20 turns before going live. */
    const PICKER_HISTORY_WINDOW = { minMessages: 1, minTurns: 20 }

    const workspaceRows = async () => {
      const catalog = await catalogPort.listWorkspaces()
      if (catalog.outcome !== 'completed') return undefined
      return {
        workspaces: catalog.workspaces.map(workspace => ({
          workspaceId: workspace.id,
          title: workspace.title,
          ...(workspace.path === undefined ? {} : { path: workspace.path }),
        })),
        archivedSessionIds: new Set(catalog.archivedSessionIds),
        paths: new Map(catalog.workspaces.map(workspace => [workspace.id, workspace.path])),
      }
    }

    const boundSessionIdSet = (): ReadonlySet<string> => {
      const bound = new Set<string>()
      for (const [, record] of threadTable.entries()) bound.add(record.sessionId)
      return bound
    }

    const postChannelNotice = async (channelId: string, content: string): Promise<void> => {
      const rest = await sharedRest()
      if (rest === undefined) return
      const sent = await rest.request('POST', `/channels/${channelId}/messages`, {
        content,
        flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG,
        allowed_mentions: ALLOWED_MENTIONS_NONE,
      })
      if (sent.outcome !== 'completed') rpcLog('discord_picker_notice_failed', sent.outcome)
    }

    const joinThreadMember = async (threadId: string, userId: string): Promise<void> => {
      const joined = await restThreadPort.joinThread({ threadId, userId })
      if (joined.outcome !== 'completed') rpcLog('discord_picker_thread_join_failed', { threadId })
    }

    const createAnchoredThread = async (input: {
      channelId: string
      messageId: string
      name: string
      actorId: string
    }): Promise<string | undefined> => {
      const created = await restThreadPort.createThread({
        parentChannelId: input.channelId,
        name: safeTitle(input.name === '' ? copy.pickerThreadAnchor : input.name),
        sourceMessageId: input.messageId,
      })
      if (created.outcome !== 'completed') {
        rpcLog('discord_picker_thread_failed', created.outcome)
        return undefined
      }
      await joinThreadMember(created.threadId, input.actorId)
      return created.threadId
    }

    /** Post the step-1 Workspace select in a thread. */
    const postPicker = async (input: { guildId: string; threadId: string; actorId: string }): Promise<boolean> => {
      const rest = await sharedRest()
      if (rest === undefined) return false
      const rows = await workspaceRows()
      if (rows === undefined) {
        await postChannelNotice(input.threadId, copy.pickerUnavailable)
        return false
      }
      if (rows.workspaces.length === 0) {
        await postChannelNotice(input.threadId, copy.pickerNoWorkspaces)
        return false
      }
      const customId = sharedRegistry.register({
        kind: 'session-picker',
        step: 'workspace',
        guildId: input.guildId,
        threadId: input.threadId,
        actorId: input.actorId,
        candidates: rows.workspaces,
        expiresAtMs: Date.now() + PICKER_TTL_MS,
      })
      const posted = await rest.request('POST', `/channels/${input.threadId}/messages`, {
        content: copy.pickerHeader,
        components: [{
          type: 1,
          components: [{
            type: 3,
            custom_id: customId,
            placeholder: copy.pickerWorkspacePlaceholder,
            options: workspaceChoices(rows.workspaces),
            max_values: 1,
          }],
        }],
        allowed_mentions: ALLOWED_MENTIONS_NONE,
      })
      if (posted.outcome !== 'completed') {
        rpcLog('discord_picker_post_failed', posted.outcome === 'rejected' ? `HTTP ${String(posted.status)}` : posted.reason)
        return false
      }
      return true
    }

    const bindThreadToSession = async (input: {
      guildId: string
      threadId: string
      sessionId: string
      workspaceId: string
      actorId: string
    }): Promise<boolean> => {
      const key = threadBindingKey({ applicationId: applicationIdRef.current, guildId: input.guildId, threadId: input.threadId })
      const existing = threadBindingStore.get(key)
      if (existing !== undefined) return existing.sessionId === input.sessionId
      const bound = await threadBindingStore.bind(key, {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        createdBy: input.actorId,
        createdAtMs: Date.now(),
      })
      if (!bound.ok) {
        rpcLog('discord_picker_bind_failed', bound.error)
        return false
      }
      return true
    }

    /**
     * Rename a freshly bound thread to its conversation title (fork
     * addition: attach backfill). Discord stores names lowercased/dashed, so
     * both sides are slugified before deciding the PATCH is needed — a
     * rename costs one of Discord's ~2-per-10-minutes budget.
     */
    const renameThreadForTitle = async (threadId: string, title: string): Promise<void> => {
      const name = safeTitle(title)
      if (name === '') return
      const rest = await sharedRest()
      if (rest === undefined) return
      const current = await rest.request<{ name?: string }>('GET', `/channels/${threadId}`)
      const currentName = current.outcome === 'completed' && typeof current.body.name === 'string' ? current.body.name : undefined
      if (currentName !== undefined && discordChannelNameKey(currentName) === discordChannelNameKey(name)) return
      const renamed = await rest.request('PATCH', `/channels/${threadId}`, { name })
      if (renamed.outcome !== 'completed') rpcLog('discord_thread_title_rename_failed', { threadId })
    }

    /** Replay the mention that opened the picker thread as its first prompt. */
    const submitPendingPrompt = async (threadId: string, sessionId: string, guildId: string): Promise<void> => {
      const pending = pickerPending.get(threadId)
      pickerPending.delete(threadId)
      if (pending === undefined) return
      if (pending.prompt === '' && pending.images.length === 0 && pending.files.length === 0) return
      const submitted = await composedMainline.continueInThread({
        applicationId: applicationIdRef.current,
        guildId,
        threadId,
        sessionId,
        messageId: pending.messageId,
        prompt: pending.prompt,
        images: pending.images,
        files: pending.files,
      })
      if (submitted.outcome !== 'queued' && submitted.outcome !== 'already-submitted') {
        rpcLog('discord_picker_prompt_not_queued', submitted)
        await postChannelNotice(threadId, copy.pickerPromptRejected)
      }
    }

    /** Composition seam: a mention in an unbound channel opens the picker. */
    const startMentionPicker = (request: {
      guildId: string
      channelId: string
      messageId: string
      authorId: string
      prompt: string
      images: ReadonlyArray<{ url: string; filename: string; declaredSize: number; contentType: string }>
      files: ReadonlyArray<{ url: string; filename: string; declaredSize: number; contentType: string }>
    }): void => {
      void (async () => {
        const threadId = await createAnchoredThread({
          channelId: request.channelId,
          messageId: request.messageId,
          name: request.prompt,
          actorId: request.authorId,
        })
        if (threadId === undefined) {
          await postChannelNotice(request.channelId, copy.pickerFailed)
          return
        }
        pickerPending.set(threadId, {
          messageId: request.messageId,
          prompt: request.prompt,
          images: [...request.images],
          files: [...request.files],
        })
        await postPicker({ guildId: request.guildId, threadId, actorId: request.authorId })
      })().catch((cause: unknown) => { rpcLog('discord_picker_start_threw', String(cause)) })
    }

    /** Composition seam: a mention in a bound channel follows its newest conversation. */
    const attachMention = (request: {
      guildId: string
      channelId: string
      messageId: string
      authorId: string
      workspaceId: string
      prompt: string
      hasTask: boolean
      images: ReadonlyArray<{ url: string; filename: string; declaredSize: number; contentType: string }>
      files: ReadonlyArray<{ url: string; filename: string; declaredSize: number; contentType: string }>
    }): void => {
      void (async () => {
        const rows = await workspaceRows()
        const summaries = await listSessionSummaries(dsh, { log: rpcLog })
        let target: SessionResumeRow | undefined
        if (rows !== undefined && summaries.outcome === 'completed') {
          const bound = boundSessionIdSet()
          const path = rows.paths.get(request.workspaceId)
          target = summaries.sessions
            .filter(summary => isPickerSession(summary, path) && !bound.has(summary.sessionId) && !rows.archivedSessionIds.has(summary.sessionId))
            .sort((a, b) => b.updatedAt - a.updatedAt)[0]
        }
        if (target === undefined) {
          // No attachable conversation: the legacy path creates a new Session.
          // A mention with no task text never reaches it (nothing to prompt).
          if (!request.hasTask) return
          void mainline.admitMention({
            applicationId: applicationIdRef.current,
            guildId: request.guildId,
            channelId: request.channelId,
            messageId: request.messageId,
            authorId: request.authorId,
            workspaceId: request.workspaceId,
            prompt: request.prompt,
            images: [...request.images],
            files: [...request.files],
          })
          return
        }
        const title = target.title ?? `Conversation ${shortId(target.sessionId)}`
        const threadId = await createAnchoredThread({
          channelId: request.channelId,
          messageId: request.messageId,
          name: title,
          actorId: request.authorId,
        })
        if (threadId === undefined) return
        const boundOk = await bindThreadToSession({
          guildId: request.guildId,
          threadId,
          sessionId: target.sessionId,
          workspaceId: request.workspaceId,
          actorId: request.authorId,
        })
        if (!boundOk) {
          await postChannelNotice(threadId, copy.pickerFailed)
          return
        }
        hostEvents.track(target.sessionId, { turnWindow: PICKER_HISTORY_WINDOW })
        await renameThreadForTitle(threadId, title)
        await postChannelNotice(threadId, copy.pickerFollowed(title))
        if (request.hasTask) {
          const submitted = await composedMainline.continueInThread({
            applicationId: applicationIdRef.current,
            guildId: request.guildId,
            threadId,
            sessionId: target.sessionId,
            messageId: request.messageId,
            prompt: request.prompt,
            images: [...request.images],
            files: [...request.files],
          })
          if (submitted.outcome !== 'queued' && submitted.outcome !== 'already-submitted') {
            rpcLog('discord_attach_prompt_not_queued', submitted)
          }
        }
      })().catch((cause: unknown) => { rpcLog('discord_attach_mention_threw', String(cause)) })
    }

    /** Router port: bind (or already-bound) one picked conversation. */
    const pickerAttach = async (input: {
      guildId: string
      threadId: string
      actorId: string
      sessionId: string
      workspaceId: string
      title?: string | undefined
    }): Promise<{ outcome: 'followed'; threadId: string; title: string } | { outcome: 'already-bound'; threadId: string } | { outcome: 'failed' }> => {
      const existingThread = threadBindingForSession(input.sessionId)?.scope.threadId
      if (existingThread !== undefined && existingThread !== input.threadId) {
        return { outcome: 'already-bound', threadId: existingThread }
      }
      const title = input.title !== undefined && input.title !== '' ? input.title : `Conversation ${shortId(input.sessionId)}`
      if (existingThread === undefined) {
        const boundOk = await bindThreadToSession({
          guildId: input.guildId,
          threadId: input.threadId,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          actorId: input.actorId,
        })
        if (!boundOk) return { outcome: 'failed' }
        hostEvents.track(input.sessionId, { turnWindow: PICKER_HISTORY_WINDOW })
        await renameThreadForTitle(input.threadId, title)
      }
      await submitPendingPrompt(input.threadId, input.sessionId, input.guildId)
      return { outcome: 'followed', threadId: input.threadId, title }
    }

    /** Router port: create a fresh conversation in the chosen Workspace. */
    const pickerCreate = async (input: {
      guildId: string
      threadId: string
      actorId: string
      workspaceId: string
    }): Promise<{ outcome: 'followed'; threadId: string; title: string } | { outcome: 'already-bound'; threadId: string } | { outcome: 'failed' }> => {
      const created = await dshSessionPort.createSession({ sessionId: crypto.randomUUID(), workspaceId: input.workspaceId })
      if (created.outcome !== 'completed') return { outcome: 'failed' }
      const boundOk = await bindThreadToSession({
        guildId: input.guildId,
        threadId: input.threadId,
        sessionId: created.sessionId,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
      })
      if (!boundOk) return { outcome: 'failed' }
      await submitPendingPrompt(input.threadId, created.sessionId, input.guildId)
      return { outcome: 'followed', threadId: input.threadId, title: 'a new conversation' }
    }

    /** Router port: `/session pick` opens the picker in a thread. */
    const openPicker = async (input: {
      guildId: string
      channelId: string
      actorId: string
    }): Promise<{ outcome: 'opened'; threadId: string } | { outcome: 'unavailable' } | { outcome: 'failed' }> => {
      const rest = await sharedRest()
      if (rest === undefined) return { outcome: 'failed' }
      const channel = await rest.request<{ type?: number }>('GET', `/channels/${input.channelId}`)
      if (channel.outcome !== 'completed') return { outcome: 'failed' }
      const channelType = typeof channel.body.type === 'number' ? channel.body.type : 0
      // 10/11/12 = announcement/public/private thread: post there directly.
      if (channelType === 10 || channelType === 11 || channelType === 12) {
        pickerPending.delete(input.channelId)
        const posted = await postPicker({ guildId: input.guildId, threadId: input.channelId, actorId: input.actorId })
        return posted ? { outcome: 'opened', threadId: input.channelId } : { outcome: 'failed' }
      }
      const anchor = await rest.request<{ id?: string }>('POST', `/channels/${input.channelId}/messages`, {
        content: copy.pickerThreadAnchor,
        flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG,
        allowed_mentions: ALLOWED_MENTIONS_NONE,
      })
      if (anchor.outcome !== 'completed' || typeof anchor.body.id !== 'string') return { outcome: 'failed' }
      const threadId = await createAnchoredThread({
        channelId: input.channelId,
        messageId: anchor.body.id,
        name: copy.pickerThreadAnchor,
        actorId: input.actorId,
      })
      if (threadId === undefined) return { outcome: 'failed' }
      const posted = await postPicker({ guildId: input.guildId, threadId, actorId: input.actorId })
      return posted ? { outcome: 'opened', threadId } : { outcome: 'failed' }
    }

    // DSH ask answerers (0.1.6 composed-approval model): the waterfalls
    // dispatch on the BASE TREE's event bus (the profile composes one event
    // tree per bundle and a waterfall only enumerates its own registry), so
    // the listeners register there — resolved off a base service's context.
    // Ask carrier: wrap the base-tree ask services at the method boundary
    // (the composed-answerer waterfalls are not reachable from an external
    // plugin's registrations — see host-asks.ts).
    const approvalService = ctx.get('approval') as { request(req: unknown): Promise<unknown> } | undefined
    const questionsService = ctx.get('userQuestions') as { ask(req: unknown): Promise<unknown> } | undefined
    if (approvalService === undefined) throw new TypeError('dsh-discord cannot reach the approval service')
    const hostAsksRef: { current: ReturnType<typeof installAskServicePatches> | undefined } = { current: undefined }
    // Ask-claim steering for the turn progress line (turn-progress spec):
    // declared before the patches so the closure is stable; the live
    // renderer attaches later in startup (asks cannot fire before then).
    const liveProgressRef: { current: { setApprovalWait(threadId: string, waiting: boolean): void } | undefined } = { current: undefined }
    hostAsksRef.current = installAskServicePatches(
      approvalService as Parameters<typeof installAskServicePatches>[0],
      questionsService as Parameters<typeof installAskServicePatches>[1],
      {
        threadForSession,
        renderabilityOfQuestions: rows => questionBoundsError(questionItemsOf(rows)),
        askWiring,
        approvalTimeoutMs: () => current.approvalTimeoutMs,
        questionTimeoutMs: () => current.questionTimeoutMs,
        nowMs: () => Date.now(),
        log: rpcLog,
        onWaitState: (threadId, waiting) => { liveProgressRef.current?.setApprovalWait(threadId, waiting) },
      },
    )
    ctx.effect(() => () => { hostAsksRef.current?.dispose() }, 'dsh-discord host ask answerers')
    const approvalRespondPort: DshApprovalRespondPort = {
      respond: ({ approvalId, outcome }) => {
        const settled = hostAsksRef.current?.settleApproval(approvalId, outcome) ?? false
        rpcLog('discord_approval_settled', { approvalId, outcome, settled })
        // The settle promise IS the confirmation: an in-process resolution
        // has no wire receipt to doubt.
        return Promise.resolve(settled ? { outcome: 'confirmed' as const } : { outcome: 'rejected' as const, reason: 'not-pending' })
      },
    }
    const queueSnapshots: Map<string, Array<{ id: string; summary: string }>> = new Map()
    /** Delete every adapter-owned record for one guild (DSH untouched). */
    const forgetGuild = async (guildId: string): Promise<void> => {
      const plan = guildKeysToForget({
        guildId,
        channelBindingKeys: [...channelTable.keys()],
        threadBindingKeys: [...threadTable.keys()],
      })
      for (const key of plan.channelKeys) await channelTable.delete(key)
      for (const key of plan.threadKeys) {
        await threadTable.delete(key)
        // Same retire rule as reconcile: forgotten threads drop their
        // render state so a future rebind starts fresh.
        const scope = parseThreadBindingKey(key)
        if (scope !== undefined) liveRef.current?.dropThread(scope.threadId)
      }
      rpcLog('discord_guild_forget_deleted', { guildId, channels: plan.channelKeys.length, threads: plan.threadKeys.length })
    }

    const questionRespondPort = {
      respond: (input: { rpcId: string; sessionId: string; answer: { answers: Array<{ id: string; selected: string[]; custom?: string }> } }) => {
        const settled = hostAsksRef.current?.settleQuestion(input.rpcId, input.answer) ?? false
        rpcLog('discord_question_settled', { rpcId: input.rpcId, settled })
        return Promise.resolve(settled ? { outcome: 'confirmed' as const } : { outcome: 'rejected' as const, reason: 'not-pending' })
      },
    }
    const questionRoutingDeps: QuestionRoutingDeps = {
      registry: sharedRegistry,
      store: questionsStore,
      port: questionRespondPort,
      nowMs: () => Date.now(),
      controls: { disable: key => askWiring.disableControl(key) },
    }
    // Per-session resume serialization (review C-1): the flow is
    // check-then-create across seconds of REST round trips, so two
    // concurrent resumes of one session could both pass the pre-check
    // and bind two threads to one session — violating binding-equals-
    // ownership. The chain serializes them; the loser then sees the
    // winner's binding in the pre-check.
    const resumeChains = new Map<string, Promise<unknown>>()
    const interactionRouter = createInteractionRouter({
      policy,
      applicationId: () => applicationIdRef.current,
      registry: sharedRegistry,
      copy,
      approvals: approvalsStore,
      approvalRespondPort,
      turnTracker,
      queueSnapshots,
      forgetGuild,
      adapterVersion: () => ADAPTER_VERSION,
      adapterStatus: () => {
        const g = statusTracker.project().connection
        return g === 'connected' ? 'connected' : g === 'connecting' ? 'connecting' : 'disconnected'
      },
      componentFollowUp,
      disableControl: key => askWiring.disableControl(key),
      handleQuestionComponent: input => handleSelectInput(questionRoutingDeps, input),
      handleQuestionModal: input => handleModalSubmit(questionRoutingDeps, input),
      dsh: {
        cancel: sessionId => cancelSessionViaProxy(dsh, { sessionId }, { log: rpcLog }),
        steer: async (sessionId, prompt) => {
          const steered = await steerSession(dsh, { sessionId, prompt }, { log: rpcLog })
          if (steered.outcome === 'accepted') hostEvents.track(sessionId, trackSeedFor(sessionId))
          return steered
        },
        removeQueueItem: (sessionId, itemId) => removeQueueItemViaProxy(dsh, { sessionId, itemId }, { log: rpcLog }),
        readWorkspaceDetail: reference => readWorkspaceDetail(dsh, reference, { log: rpcLog }),
      },
      catalogPort,
      resolver,
      channelBinding: (guildId, channelId) => bindingStore.get(bindChannelKey(guildId, channelId)),
      findBoundChannelFor,
      sessionForThread: (guildId, threadId) => bindings.sessionForThread(guildId, threadId),
      ensureWorkspaceChannel,
      rest: sharedRest,
      purgeChannelBinding: async (guildId, channelId) => {
        await channelTable.delete(bindChannelKey(guildId, channelId))
        rpcLog('discord_reconcile_channel_retired', { channelId, reason: 'discord-deleted' })
      },
      model: createModelPort(dsh, { log: rpcLog }),
      permission: createPermissionPort(dsh, { log: rpcLog }),
      permissionSelectOperatorOnly: () => current.permissionSelectOperatorOnly,
      modelSelectOperatorOnly: () => current.modelSelectOperatorOnly,
      picker: {
        sessionChoices: async input => {
          const rows = await workspaceRows()
          const summaries = await listSessionSummaries(dsh, { log: rpcLog })
          if (rows === undefined || summaries.outcome !== 'completed') return { outcome: 'unavailable' as const }
          const bound = boundSessionIdSet()
          const sessions: PickerSessionRow[] = summaries.sessions
            .filter(summary =>
              isPickerSession(summary, input.path)
              && !bound.has(summary.sessionId)
              && !rows.archivedSessionIds.has(summary.sessionId))
            .map(row => ({
              sessionId: row.sessionId,
              updatedAt: row.updatedAt,
              running: row.running,
              ...(row.title === undefined ? {} : { title: row.title }),
              ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
            }))
          return { outcome: 'ok' as const, sessions }
        },
        boundSessionIds: boundSessionIdSet,
        attach: pickerAttach,
        create: pickerCreate,
      },
      openPicker,
      resumeCandidates: createResumeCandidatesPort({
        listSessions: () => listSessionSummaries(dsh, { log: rpcLog }),
        boundSessionIds: () => {
          const bound = new Set<string>()
          for (const [, record] of threadTable.entries()) bound.add(record.sessionId)
          return bound
        },
        copy,
      }),
      resumeSession: ({ sessionId, workspaceId, guildId, parentChannelId, actorId }) => {
        const run = async (): Promise<
          | { outcome: 'started'; threadId: string }
          | { outcome: 'already-bound'; threadId: string }
          | { outcome: 'refused-control-channel' }
          | { outcome: 'refused-subagent' }
          | { outcome: 'refused-archived' }
          | { outcome: 'failed' }
        > => {
        const rest = await sharedRest()
        if (rest === undefined) return { outcome: 'failed' }
        // threadBindings is the Discord-ownership record: a session with a
        // binding already lives in a thread (16.44; the owners-store wiring
        // stays deferred per 16.28).
        const existingThread = threadForSession(sessionId)
        if (existingThread !== undefined) return { outcome: 'already-bound', threadId: existingThread }
        // The control channel never carries sessions: refuse explicitly so
        // the user is pointed at the workspace channel (16.44 rev).
        const listedChannels = await rest.request<Array<{ id: string; name: string; type: number; parent_id?: string }>>('GET', `/guilds/${guildId}/channels`)
        if (listedChannels.outcome === 'completed') {
          const category = listedChannels.body.find(channel => channel.type === 4 && channel.name.toLowerCase() === CATEGORY_NAME.toLowerCase())
          const control = category !== undefined
            ? listedChannels.body.find(channel => channel.type === 0 && channel.parent_id === category.id && channel.name.toLowerCase() === 'general')
            : undefined
          if (control !== undefined && control.id === parentChannelId) {
            return { outcome: 'refused-control-channel' }
          }
        }
        const summaries = await listSessionSummaries(dsh, { log: rpcLog })
        if (summaries.outcome !== 'completed') return { outcome: 'failed' }
        const summary = summaries.sessions.find(candidate => candidate.sessionId === sessionId)
        if (summary === undefined || summary.blank) return { outcome: 'failed' }
        // Spec scenario "Subagent Session selected": a subagent spawn is
        // never a top-level writable thread, even if handed in directly
        // (the candidates already hide it — 16.48).
        if (summary.origin === 'subagent') return { outcome: 'refused-subagent' }
        // Same defense for archived sessions (16.49): adoption would
        // succeed and the thread would never see a turn.
        const catalog = await catalogPort.listWorkspaces()
        if (catalog.outcome === 'completed'
          && catalog.archivedSessionIds.includes(sessionId)) {
          return { outcome: 'refused-archived' }
        }
        const title = summary.title ?? `Resume ${sessionId.slice(0, 8)}`
        // Anchor post: a durable marker the resume thread hangs off.
        const anchor = await rest.request<{ id?: string }>('POST', `/channels/${parentChannelId}/messages`, {
          content: copy.sessionResumeAnchor(safeTitle(title)),
          flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG,
          allowed_mentions: ALLOWED_MENTIONS_NONE,
        })
        if (anchor.outcome === 'rejected') {
          rpcLog('discord_session_resume_anchor_failed', { sessionId, status: `HTTP ${String(anchor.status)}` })
          return { outcome: 'failed' }
        }
        if (anchor.outcome === 'unknown' || typeof anchor.body.id !== 'string') {
          rpcLog('discord_session_resume_anchor_unknown', { sessionId })
          return { outcome: 'failed' }
        }
        const thread = await rest.request<{ id?: string }>('POST', `/channels/${parentChannelId}/messages/${anchor.body.id}/threads`, {
          name: safeTitle(title),
        })
        if (thread.outcome === 'rejected') {
          rpcLog('discord_session_resume_thread_failed', { sessionId, status: `HTTP ${String(thread.status)}` })
          return { outcome: 'failed' }
        }
        if (thread.outcome === 'unknown' || typeof thread.body.id !== 'string') {
          rpcLog('discord_session_resume_thread_unknown', { sessionId })
          return { outcome: 'failed' }
        }
        const bound = await threadBindingStore.bind(threadBindingKey({ applicationId: applicationIdRef.current, guildId, threadId: thread.body.id }), {
          sessionId,
          workspaceId,
          createdBy: actorId,
          createdAtMs: Date.now(),
        })
        // The bind is the ownership claim — a lost race (session bound by a
        // concurrent resume) surfaces here instead of silently double-
        // binding; the losing thread is left unbound for reconcile to judge.
        if (!bound.ok) {
          rpcLog('discord_session_resume_bind_failed', { sessionId, threadId: thread.body.id, error: bound.error })
          return { outcome: 'failed' }
        }
        rpcLog('discord_session_resumed', { sessionId, threadId: thread.body.id, title })
        hostEvents.track(sessionId)
        return { outcome: 'started', threadId: thread.body.id }
        }
        const tail = resumeChains.get(sessionId) ?? Promise.resolve()
        const next = tail.then(run, run)
        // Identity-guarded self-clean (PR review): an earlier resume's
        // cleanup must never delete a LATER resume's queued chain — that
        // re-opened the race this map exists to close. The settled marker
        // also absorbs rejections so nothing escapes unhandled.
        const marker = next.then(() => undefined, () => undefined)
        resumeChains.set(sessionId, marker)
        void marker.then(() => {
          if (resumeChains.get(sessionId) === marker) resumeChains.delete(sessionId)
        })
        return next
      },
      log: rpcLog,
      warn: (event, detail) => {
        emitLog(ctx, 'warn', { event, detail: typeof detail === 'string' ? detail : JSON.stringify(detail ?? null) })
      },
    })
    diag('runtime-creating')
    runtimeRef.current = startDiscordAdapter({
      tokenProvider: async () => {
        const token = (await resolveDiscordBotToken(credentials)) ?? undefined
        diag('token-resolved', { present: token !== undefined })
        return token
      },
      socketFactory: (url): GatewaySocket => {
        const ws = new WebSocket(url)
        // Translate the browser-style WebSocket event API (undici) into the
        // adapter's plain-callback contract. onclose MUST pass the numeric
        // close code: terminal codes drive the fail-closed status surface.
        const socket: GatewaySocket = {
          url,
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          close: (code?: number) => { ws.close(code ?? 1000) },
          terminate: () => { ws.close(1000) },
          send: (data: string) => { ws.send(data) },
        }
        ws.onopen = () => { socket.onopen?.() }
        ws.onmessage = (ev) => { socket.onmessage?.(typeof ev.data === 'string' ? ev.data : String(ev.data)) }
        ws.onclose = (ev) => { socket.onclose?.(ev.code) }
        ws.onerror = () => { socket.onerror?.(new Error('socket error')) }
        return socket
      },
      policy,
      selfUserIdProvider: async () => {
        const rest = await sharedRest()
        if (rest === undefined) throw new TypeError('discord bot token unavailable')
        const me = await rest.request<{ id: string }>('GET', '/users/@me')
        if (me.outcome !== 'completed') throw new TypeError('cannot resolve bot identity')
        // Backfill the application id here too: gateway dispatches can
        // arrive before the REST command registration resolves its
        // identity, and every binding-key lookup before then would use
        // the placeholder and misroute bound-channel mentions.
        applicationIdRef.current = me.body.id
        return me.body.id
      },
      intents: GATEWAY_INTENTS,
      // Twin-E2E seams: both overrides default to the production surfaces and
      // exist only so a local Discord API twin can host the real protocol.
      ...(process.env['DSH_DISCORD_GATEWAY_URL'] === undefined
        ? {}
        : { gatewayUrl: process.env['DSH_DISCORD_GATEWAY_URL'] }),
      applicationId: () => applicationIdRef.current,
      mainline,
      bindings,
      mentionPicker: startMentionPicker,
      attachMention,
      unboundNotice: (request) => {
        const content = request.audience === 'administrator'
          ? copy.unboundNoticeAdministrator
          : copy.unboundNoticeMember
        void withRest(async (rest) => {
          const sent = await rest.request('POST', `/channels/${request.channelId}/messages`, { content, flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG, allowed_mentions: ALLOWED_MENTIONS_NONE })
          if (sent.outcome !== 'completed') {
            rpcLog('discord_unbound_notice_send_failed', sent.outcome === 'rejected' ? `HTTP ${String(sent.status)}` : sent.reason)
          }
        }).catch((cause: unknown) => {
          rpcLog('discord_unbound_notice_threw', String(cause))
        })
      },
      // 16.114: a binary-only attachment used to vanish with zero logs and
      // zero replies. Filenames come off the untrusted wire, so strip mention
      // syntax before echoing them into a channel.
      attachmentNotice: (request) => {
        const names = request.filenames
          .map(name => name.replace(/[<>@]/g, '').slice(0, 80))
          .slice(0, 10)
          .join(', ')
        const content = `${copy.attachmentUnsupported} ${names}`
        void withRest(async (rest) => {
          const sent = await rest.request('POST', `/channels/${request.channelId}/messages`, { content, flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG, allowed_mentions: ALLOWED_MENTIONS_NONE })
          if (sent.outcome !== 'completed') {
            rpcLog('discord_attachment_notice_send_failed', sent.outcome === 'rejected' ? `HTTP ${String(sent.status)}` : sent.reason)
          }
        }).catch((cause: unknown) => {
          rpcLog('discord_attachment_notice_threw', String(cause))
        })
      },
      approvals: approvalsStore,
      questions: questionsStore,
      status: statusTracker,
      registry: sharedRegistry,
      onReady: () => { diag('gateway-ready'); return reconcileOnReady() },
      routeInteraction: (event, token) => {
        // The router speaks the interaction dialect only (compose forwards
        // interactions exclusively).
        if (event.kind !== 'interaction') return
        return interactionRouter.route(event, token)
      },
      logger: {
        warn: (event, detail) => {
          emitLog(ctx, 'warn', { event, detail: typeof detail === 'string' ? detail : JSON.stringify(detail ?? null) })
        },
      },
    })
    // Register the Milestone 1 command set per allowed Guild (instant
    // propagation, unlike global commands) once the bot identity is known.
    // Re-runs whenever the allowlist changes — apply-time settings may still
    // be loading, so the first non-empty list wins. Trailing-edge single
    // flight (review C-2): a trigger landing mid-pass carries NEW guild
    // state — dropping it silently skipped registering an added guild (or
    // left a removed guild's stale commands until reload); the flight
    // re-runs once after the pass, concurrent triggers coalesce.
    registerCommands = createTrailingSingleFlight(async (): Promise<void> => {
      diag('register-commands', { guilds: current.allowedGuildIds.length })
      if (current.allowedGuildIds.length === 0) return
      const rest = await sharedRest()
      if (rest === undefined) return
      const me = await rest.request<{ id: string }>('GET', '/users/@me')
      if (me.outcome !== 'completed') return
      applicationIdRef.current = me.body.id
      const registrations = buildCommandRegistrations()
      for (const guildId of current.allowedGuildIds) {
        const result = await rest.request('PUT', `/applications/${me.body.id}/guilds/${guildId}/commands`, registrations)
        if (result.outcome !== 'completed') {
          diag('register-commands-failed', { guildId, outcome: result.outcome })
          emitLog(ctx, 'warn', { event: 'discord_command_register_failed', guildId })
        } else {
          diag('register-commands-ok', { guildId, count: registrations.length })
        }
      }
    }, { onThrew: cause => { emitLog(ctx, 'warn', { event: 'discord_command_register_failed', cause: String(cause) }) } })
    registerCommands()
    // ── Live streaming: host follow/control fan-in → per-thread rendering ──
    // The queue snapshot cache (declared with the interaction router) is the
    // /queue surface's data source: the 0.1.6 `session/control` stream owns
    // the authoritative whole-snapshot queue frames.
    // The 0.1.6 event bridge: every session the adapter tracks (create,
    // adopt, resume, prompt) joins one fan-in stream of live frames.
    const liveRef: { current: ReturnType<typeof startLiveRender> | undefined } = { current: undefined }
    liveRef.current = startLiveRender({
      frames: signal => hostEvents.stream(signal),
      threadForSession,
      delivery: {
        send: async (request) => {
          const rest = await sharedRest()
          if (rest === undefined) return { outcome: 'failed' }
          // The nonce lets an unobservable send be reconciled instead of
          // blindly retried (rest.ts contract): a message that actually
          // landed is found by its nonce and reported completed.
          const nonce = newNonce()
          const sent = await rest.request<{ id?: string } | undefined>('POST', `/channels/${request.channelId}/messages`, {
            content: request.content,
            flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG,
            allowed_mentions: ALLOWED_MENTIONS_NONE,
            nonce,
          })
          if (sent.outcome === 'completed' && typeof sent.body?.id === 'string') {
            return { outcome: 'completed', messageId: sent.body.id }
          }
          if (sent.outcome === 'unknown') {
            const reconciled = await findSentMessageByNonce(rest, request.channelId, nonce)
            if (reconciled !== undefined) return { outcome: 'completed', messageId: reconciled }
            rpcLog('discord_live_send_unknown', { channelId: request.channelId })
            return { outcome: 'unknown' }
          }
          if (sent.outcome === 'rejected') {
            rpcLog('discord_live_send_failed', { channelId: request.channelId, status: sent.status, error: sent.error })
          } else {
            rpcLog('discord_live_send_failed', { channelId: request.channelId, outcome: sent.outcome })
          }
          return { outcome: 'failed' }
        },
        edit: async (request) => {
          const rest = await sharedRest()
          if (rest === undefined) return { outcome: 'failed' }
          const edited = await rest.request('PATCH', `/channels/${request.channelId}/messages/${request.messageId}`, {
            content: request.content,
            flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG,
            allowed_mentions: ALLOWED_MENTIONS_NONE,
          })
          if (edited.outcome === 'rejected') {
            rpcLog('discord_live_edit_failed', { channelId: request.channelId, status: edited.status, error: edited.error })
          }
          return edited.outcome === 'completed' ? { outcome: 'completed' } : { outcome: 'failed' }
        },
        typing: async (channelId) => {
          const rest = await sharedRest()
          if (rest === undefined) return
          await rest.request('POST', `/channels/${channelId}/typing`)
        },
        delete: async (request) => {
          const rest = await sharedRest()
          if (rest === undefined) return { outcome: 'failed' }
          const deleted = await rest.request('DELETE', `/channels/${request.channelId}/messages/${request.messageId}`)
          return deleted.outcome === 'completed' ? { outcome: 'completed' } : { outcome: 'failed' }
        },
        renameThread: async (request) => {
          const rest = await sharedRest()
          if (rest === undefined) return { outcome: 'failed' }
          const renamed = await rest.request('PATCH', `/channels/${request.channelId}`, { name: request.name })
          return renamed.outcome === 'completed' ? { outcome: 'completed' } : { outcome: 'failed' }
        },
      },
      threadName: async (channelId) => {
        const rest = await sharedRest()
        if (rest === undefined) return undefined
        const got = await rest.request<{ name?: string } | undefined>('GET', `/channels/${channelId}`)
        return got.outcome === 'completed' && typeof got.body?.name === 'string' ? got.body.name : undefined
      },
      updateIntervalMs: current.streamUpdateIntervalMs,
      typingIntervalMs: current.typingIntervalMs,
      verbosity: current.defaultVerbosity,
      log: rpcLog,
      interruptedMarker: () => copy.interruptedMarker,
      progressCopy: () => ({
        thinking: copy.progressThinking,
        thinkingStep: copy.progressThinkingStep,
        writing: copy.progressWriting,
        approvalWait: copy.progressApprovalWait,
        turnSummary: copy.progressTurnSummary,
      }),
      userEchoCopy: () => ({
        label: copy.userInputLabel,
        nonText: copy.userInputNonText,
        truncated: copy.userInputTruncated,
      }),
      // Echo-redaction seam (review D4, decision A): attached-file blocks
      // are model input, not user prose — never mirror their contents back
      // into the Discord thread on top of the user's own upload.
      echoRedact: text => stripAttachedFileBlocks(text),
      permissionLineCopy: () => ({ line: presetKey => copy.permissionSystemLine(permissionPresetLabel(presetKey, copy)) }),
      onQueueSnapshot: (sessionId, items) => {
        // An empty snapshot means the queue drained: drop the cache entry
        // instead of holding one map slot per session ever seen.
        if (items.length === 0) queueSnapshots.delete(sessionId)
        else queueSnapshots.set(sessionId, items)
      },
      turnErrorCopy: () => copy.turnFailed,
      onTurnEnded: (sessionId, info) => {
        const turn = turnTracker.active(sessionId)
        if (turn !== undefined) {
          turnTracker.complete(turn.requestId)
          // The actor lookup's purpose ends with the turn (review B4):
          // without this the map gained one entry per prompt, forever.
          turnActors.delete(turn.requestId)
        }
        rpcLog('discord_turn_ended', { sessionId, hadActiveTurn: turn !== undefined })
        if (info !== undefined) void persistRenderedSeq(sessionId, info.renderedSeq)
      },
    })
    // The ask patches steer the same renderer's progress line (3.2 wiring).
    liveProgressRef.current = liveRef.current
    ctx.effect(() => () => { liveRef.current?.dispose() }, 'dsh-discord live render')
    ctx.effect(() => () => { runtimeRef.current?.dispose() }, 'dsh-discord composed runtime')
    // The router's follow loops and re-arm timers survive nothing else's
    // teardown: without this, plugin removal leaves zombie subscriptions.
    ctx.effect(() => () => { hostEvents.dispose() }, 'dsh-discord host event router')

  })().catch((cause: unknown) => {
    diag('composition-failed', String(cause))
    console.error('[dsh-discord] composition failed:', cause)
    emitLog(ctx, 'warn', { event: 'discord_compose_failed', cause: String(cause) })
    statusTracker.setGateway('disconnected')
  })


}

export {
  DEFAULT_DISCORD_SETTINGS,
  DISCORD_SETTINGS_NAMESPACE,
  DiscordSettingsSchema,
  normalizeDiscordSettings,
  validateDiscordSettings,
} from './settings.js'
export {
  DISCORD_BOT_TOKEN_REF,
  describeDiscordCredential,
  resolveDiscordBotToken,
} from './credential.js'
