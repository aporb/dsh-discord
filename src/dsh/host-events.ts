/**
 * The 0.1.6 host event bridge: fans the per-session `session/follow`
 * journals plus the host-wide `session/control` stream into the single
 * frame stream the live renderer consumes (the rc.2 `apiProxy.events.mux`
 * global stream no longer exists).
 *
 * Frame vocabulary is preserved verbatim (`session/event`,
 * `session/subscribed`, `session/queue`), so `src/stream/live.ts` and its
 * tests are untouched by the host-side rebase. Two deliberate exclusions:
 *
 * - `snapshot` opening windows ARE translated through the same seq
 *   watermark as live events: the turn often completes between prompt
 *   admission and our follow subscription, so the opening window is the
 *   ONLY carrier of those records. The watermark (last delivered seq per
 *   session) keeps re-subscription replays idempotent.
 * - approval/question request frames are NOT synthesized here: the 0.1.6
 *   host routes asks through the composed-approval model, which the
 *   ask-wiring migration wires separately.
 */

/** Narrow follow face over one durable session journal. */
export interface HostSessionFollowFace {
  follow(request: {
    address: { kind: 'session'; sessionId: string }
    assistantStream?: true
  }, signal: AbortSignal): AsyncIterable<unknown>
  control(signal: AbortSignal): AsyncIterable<unknown>
}

/**
 * Durable catch-up seeding for one tracked session (replay-fence D2):
 * `floor` raises the in-memory watermark so snapshot records the thread
 * already rendered are dropped before they reach the renderer;
 * `suppressOpeningSnapshot` swallows the FIRST opening snapshot whole
 * (watermark advances, nothing delivers) — the one-time migration for
 * bindings that predate the persisted watermark.
 */
export interface TrackSeedOptions {
  floor?: number
  suppressOpeningSnapshot?: boolean
  /**
   * Bounded history window for the opening snapshot (0.2.2-rc.1
   * `SessionFollowRequest.turnWindow`). Attach flows ask for at least 20
   * turns so a fresh Discord thread shows recent history; live tracking
   * after a prompt leaves it unset.
   */
  turnWindow?: { minMessages: number; minTurns: number }
}

export interface HostEventRouterOptions {
  log?: (event: string, detail?: unknown) => void
}

interface FrameQueue {
  push(frame: unknown): void
  close(): void
}

/** Build the push-side of the single consumer queue. */
export function createFrameQueue(): FrameQueue & { iterate(signal: AbortSignal): AsyncIterable<unknown> } {
  const buffered: unknown[] = []
  let notify: (() => void) | undefined
  let closed = false
  const queue: FrameQueue = {
    push(frame) {
      if (closed) return
      buffered.push(frame)
      const wake = notify
      notify = undefined
      wake?.()
    },
    close() {
      closed = true
      const wake = notify
      notify = undefined
      wake?.()
    },
  }
  return {
    ...queue,
    iterate(signal) {
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (;;) {
              if (signal.aborted) return
              while (buffered.length > 0) {
                // shift() cannot miss: the length guard ran first.
                yield buffered.shift()
              }
              if (closed) return
              await new Promise<void>(resolve => {
                const abort = () => {
                  notify = undefined
                  resolve()
                }
                signal.addEventListener('abort', abort, { once: true })
                notify = () => {
                  // The wake path must drop its abort listener: a streaming
                  // session parks here per drain, and a leaked listener per
                  // park accumulates into MaxListenersExceededWarning.
                  signal.removeEventListener('abort', abort)
                  resolve()
                }
              })
            }
          } finally {
            queue.close()
          }
        },
      }
    },
  }
}

/** Normalize a title projection value (plain string or `{title}` snapshot). */
function projectionTitle(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim()
  if (isRecord(value) && typeof value['title'] === 'string') {
    return value['title'].trim() === '' ? undefined : value['title'].trim()
  }
  return undefined
}

/** Defensive record probe: the wire is untrusted regardless of declared types. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Extract one journal record's seq through both envelope shapes (double
 * `{type:'event', event:{seq}}` and flat `{seq}`); undefined when absent.
 */
function journalSeq(record: unknown): number | undefined {
  if (!isRecord(record)) return undefined
  const inner = isRecord(record['event']) ? record['event'] : record
  const seq = inner['seq']
  return typeof seq === 'number' ? seq : undefined
}

/** Defensive text extraction from a queued message's JSON content parts. */
function queueItemSummary(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const typed = part as { type?: unknown; text?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') texts.push(typed.text)
  }
  return texts.join(' ').slice(0, 200)
}

/**
 * The fan-in router. `track(sessionId)` is idempotent and safe to call from
 * every session-acquisition site (create, adopt, resume, prompt); each
 * tracked session owns one follow loop whose frames join the shared queue.
 */
export function createHostEventRouter(
  services: HostSessionFollowFace,
  options: HostEventRouterOptions = {},
): {
  track(sessionId: string, seed?: TrackSeedOptions): void
  stream(signal: AbortSignal): AsyncIterable<unknown>
  /** Abort every tracked follow loop, cancel pending re-arms, stop the router. */
  dispose(): void
} {
  const log = options.log
  const tracked = new Map<string, AbortController>()
  /** Last delivered durable seq per session: the replay-dedupe watermark. */
  const watermark = new Map<string, number>()
  /** Sessions whose NEXT opening snapshot is swallowed whole (legacy bindings). */
  const suppressOnce = new Set<string>()
  /** Pending re-arm timers: disposed routers must stop resubscribing. */
  const rearmTimers = new Set<ReturnType<typeof setTimeout>>()
  let consumer: FrameQueue | undefined
  let rootSignal: AbortSignal | undefined
  let disposed = false

  /** Per-track bounded history window for the opening snapshot. */
  const followWindows = new Map<string, { minMessages: number; minTurns: number }>()
  /**
   * Live assistant deltas (0.2.2-rc.1): this host emits NO durable
   * `assistant/chunk` session event. Deltas ride `follow` frames
   * `{type:'assistant-stream', frame}`; the renderer keys on the durable
   * vocabulary, so this bridge re-shapes each stream chunk into the
   * `assistant/chunk` event the renderer already understands
   * (`{turn, step, chunk:{type:'text-delta', text}}`). `start` supplies the
   * turn/step identity; `end` closes the attempt.
   */
  const streamAttempts = new Map<string, { attemptId: string; turn: number; step: number }>()
  /** Highest delivered stream index per attempt, so re-arm cannot replay. */
  const streamProgress = new Map<string, number>()

  function emitTextDelta(sessionId: string, turn: number, step: number, chunk: unknown): void {
    if (!isRecord(chunk)) return
    if (chunk['type'] !== 'text-delta' || typeof chunk['text'] !== 'string') return
    consumer?.push({
      type: 'session/event',
      sessionId,
      event: { type: 'assistant/chunk', data: { turn, step, chunk: { type: 'text-delta', text: chunk['text'] } } },
      carrier: 'live',
    })
  }

  function handleAssistantStreamFrame(sessionId: string, frame: Record<string, unknown>): void {
    const kind = frame['type']
    if (kind === 'start') {
      const attemptId = frame['attemptId']
      const turn = frame['turn']
      const step = frame['step']
      if (typeof attemptId === 'string' && typeof turn === 'number' && typeof step === 'number') {
        streamAttempts.set(sessionId, { attemptId, turn, step })
        streamProgress.set(attemptId, -1)
      }
      return
    }
    if (kind === 'chunk') {
      const state = streamAttempts.get(sessionId)
      const attemptId = frame['attemptId']
      if (state === undefined || typeof attemptId !== 'string' || attemptId !== state.attemptId) return
      const index = typeof frame['index'] === 'number' ? frame['index'] : undefined
      if (index !== undefined) {
        const last = streamProgress.get(attemptId) ?? -1
        if (index <= last) return
        streamProgress.set(attemptId, index)
      }
      emitTextDelta(sessionId, state.turn, state.step, frame['chunk'])
      return
    }
    if (kind === 'end') {
      const attemptId = frame['attemptId']
      if (typeof attemptId === 'string') streamProgress.delete(attemptId)
      streamAttempts.delete(sessionId)
    }
  }

  /**
   * Seed the live-delta bridge from a snapshot's `assistantStream` baseline:
   * a turn that started before this subscription gets its already-received
   * chunks replayed, so attach mid-turn does not lose the visible prefix.
   */
  function replayAssistantBaseline(sessionId: string, baseline: unknown): void {
    if (!isRecord(baseline)) return
    const active = baseline['activeAttempt']
    if (!isRecord(active)) return
    const attemptId = active['attemptId']
    const turn = active['turn']
    const step = active['step']
    if (typeof attemptId !== 'string' || typeof turn !== 'number' || typeof step !== 'number') return
    streamAttempts.set(sessionId, { attemptId, turn, step })
    const nextIndex = typeof active['nextIndex'] === 'number' ? active['nextIndex'] : 0
    streamProgress.set(attemptId, nextIndex - 1)
    const records = Array.isArray(active['stream']) ? active['stream'] : []
    for (const record of records) {
      if (!isRecord(record)) continue
      if (record['type'] === 'chunk') emitTextDelta(sessionId, turn, step, record['chunk'])
      if (record['type'] === 'text-chunks' && Array.isArray(record['texts'])) {
        for (const text of record['texts']) {
          if (typeof text === 'string') emitTextDelta(sessionId, turn, step, { type: 'text-delta', text })
        }
      }
    }
  }

  const startLoop = (sessionId: string, attempt = 0): void => {
    const per = new AbortController()
    tracked.set(sessionId, per)
    void (async () => {
      if (process.env['DSH_DISCORD_TRACE'] === '1') console.error(`[dsh-discord:trace] follow-start session=${sessionId.slice(0, 8)} attempt=${String(attempt)}`)
      try {
        consumer?.push({ type: 'session/subscribed', sessionId })
        // The follow request MUST ask for assistant streaming: without the
        // flag the host (alpha.2) delivers only the opening snapshot and
        // never pushes later journal records — the live tail stays dead
        // (diagnosis.md §D, run 2 vs run 3).
        const window = followWindows.get(sessionId)
        const request = {
          address: { kind: 'session' as const, sessionId },
          assistantStream: true as const,
          ...(window === undefined ? {} : { turnWindow: window }),
        }
        for await (const raw of services.follow(request, per.signal)) {
          if (process.env['DSH_DISCORD_TRACE'] === '1') {
            const dumped = JSON.stringify(raw)
            console.error(`[dsh-discord:trace] raw-follow-frame type=${String(isRecord(raw) ? raw['type'] : typeof raw)} frame=${dumped.length > 300 ? `${dumped.slice(0, 300)}…` : dumped}`)
          }
          if (!isRecord(raw)) continue
          const frame = raw
          // Both the opening snapshot and live journal entries carry the
          // same {type, data, seq} record envelope the rc.2 mux delivered;
          // the seq watermark keeps replayed windows idempotent.
          if (frame['type'] === 'event' || frame['type'] === 'snapshot') {
            // Two carriers, both real-machine verified (alpha.2): snapshot
            // windows batch their records under `records`, while live records
            // arrive as single-record frames — the record rides the `event`
            // key of the frame itself, no array. Snapshots without a records
            // array stay drops (malformed), live frames become their own
            // one-element batch.
            const records = (raw as { records?: unknown }).records
            const batch = Array.isArray(records)
              ? records
              : frame['type'] === 'event'
                ? [raw]
                : undefined
            if (batch === undefined) continue
            // Legacy-binding migration (D2): swallow the first opening
            // snapshot whole — the thread already rendered that history in
            // a pre-feature process; re-delivering it would replay the very
            // duplication this fence exists to stop. The watermark still
            // advances, so later live frames deliver untouched.
            if (frame['type'] === 'snapshot' && suppressOnce.delete(sessionId)) {
              let maxSeq = watermark.get(sessionId) ?? 0
              for (const record of batch) {
                const seq = journalSeq(record)
                if (seq !== undefined && seq > maxSeq) maxSeq = seq
              }
              if (maxSeq > 0) watermark.set(sessionId, maxSeq)
              if (process.env['DSH_DISCORD_TRACE'] === '1') {
                console.error(`[dsh-discord:trace] snapshot-suppressed session=${sessionId.slice(0, 8)} watermark=${String(maxSeq)}`)
              }
              continue
            }
            const through = watermark.get(sessionId) ?? 0
            let delivered = through
            for (const record of batch) {
              // Journal records arrive double-wrapped: {type:'event',
              // event:{type, seq, time, data}} — the wire event rides the
              // `event` key. Accept the flat shape defensively too.
              const candidate = record as { type?: unknown; data?: unknown; seq?: unknown; event?: unknown } | null
              if (candidate === null || typeof candidate !== 'object') continue
              const inner = typeof candidate.event === 'object' && candidate.event !== null
                ? candidate.event as { type?: unknown; data?: unknown; seq?: unknown }
                : candidate
              if (typeof inner.type !== 'string') continue
              if (typeof inner.seq === 'number') {
                if (inner.seq <= through) continue
                if (inner.seq > delivered) delivered = inner.seq
              }
              if (process.env['DSH_DISCORD_TRACE'] === '1') {
                // Full data dump (truncated): diagnosis needs the field
                // shapes, not just the key names — keys hide nesting.
                const dumped = JSON.stringify(inner.data)
                console.error(`[dsh-discord:trace] record type=${inner.type} seq=${String(inner.seq)} data=${dumped.length > 800 ? `${dumped.slice(0, 800)}…` : dumped}`)
              }
              consumer?.push({
                type: 'session/event',
                sessionId,
                event: { type: inner.type, data: (typeof inner.data === 'object' && inner.data !== null ? inner.data : {}) as Record<string, unknown> },
                // Carrier + seq (replay-fence D4): the renderer's watermark
                // tracking and catch-up/live distinction ride these; pure
                // additions every existing consumer can ignore.
                carrier: frame['type'] === 'snapshot' ? 'snapshot' : 'live',
                ...(typeof inner.seq === 'number' ? { seq: inner.seq } : {}),
              })
            }
            if (delivered > through) watermark.set(sessionId, delivered)
            if (frame['type'] === 'snapshot') replayAssistantBaseline(sessionId, frame['assistantStream'])
          } else if (frame['type'] === 'assistant-stream') {
            // 0.2.2-rc.1: durable assistant/chunk events do not exist; text
            // deltas arrive only here. Re-shape them into the renderer's
            // durable vocabulary (see handleAssistantStreamFrame).
            if (process.env['DSH_DISCORD_TRACE'] === '1') {
              const streamFrame = frame['frame']
              const dumped = JSON.stringify(streamFrame)
              console.error(`[dsh-discord:trace] assistant-stream type=${String(isRecord(streamFrame) ? streamFrame['type'] : '?')} frame=${dumped.length > 300 ? `${dumped.slice(0, 300)}…` : dumped}`)
            }
            if (isRecord(frame['frame'])) handleAssistantStreamFrame(sessionId, frame['frame'])
            continue
          } else if (process.env['DSH_DISCORD_TRACE'] === '1') {
            const dumped = JSON.stringify(frame)
            console.error(`[dsh-discord:trace] follow-frame UNHANDLED type=${String(frame['type'])} frame=${dumped.length > 400 ? `${dumped.slice(0, 400)}…` : dumped}`)
          }
        }
      } catch (cause) {
        if (!per.signal.aborted) {
          if (process.env['DSH_DISCORD_TRACE'] === '1') console.error(`[dsh-discord:trace] follow-threw session=${sessionId.slice(0, 8)} cause=${String(cause).slice(0, 300)}`)
          log?.('discord_host_follow_threw', { sessionId, cause: String(cause) })
        }
      } finally {
        if (process.env['DSH_DISCORD_TRACE'] === '1') console.error(`[dsh-discord:trace] follow-end session=${sessionId.slice(0, 8)} aborted=${String(per.signal.aborted)} tracked=${String(tracked.get(sessionId) === per)}`)
        if (tracked.get(sessionId) === per) tracked.delete(sessionId)
        // A follow stream may END normally once its snapshot is delivered
        // (a cold session has no live agent to follow): without a
        // re-subscribe, every later turn is invisible until the next
        // process restart replays the journal. Re-arm with backoff.
        if (!per.signal.aborted) {
          const delayMs = Math.min(30_000, 1_000 * 2 ** attempt)
          const timer = setTimeout(() => {
            rearmTimers.delete(timer)
            if (disposed || per.signal.aborted || tracked.has(sessionId)) return
            log?.('discord_host_follow_resubscribed', { sessionId, delayMs })
            startLoop(sessionId, attempt + 1)
          }, delayMs)
          // A parked re-arm must never pin the host's event loop open.
          timer.unref()
          rearmTimers.add(timer)
        }
      }
    })()
  }

  const startControlLoop = (signal: AbortSignal): void => {
    void (async () => {
      try {
        for await (const raw of services.control(signal)) {
          if (!isRecord(raw)) continue
          const frame = raw
          if (process.env['DSH_DISCORD_TRACE'] === '1') {
            const dumped = JSON.stringify(frame)
            console.error(`[dsh-discord:trace] control type=${String(frame['type'])} frame=${dumped.length > 400 ? `${dumped.slice(0, 400)}…` : dumped}`)
          }
          if (frame['type'] === 'projection' && typeof frame['sessionId'] === 'string') {
            // 0.2.2-rc.1 control frames carry whole projection updates; the
            // title change is what the Discord thread name follows.
            const changes = Array.isArray(frame['changes']) ? frame['changes'] as unknown[] : []
            for (const change of changes) {
              if (!isRecord(change) || change['key'] !== 'title') continue
              const title = projectionTitle(change['val'])
              if (title === undefined) continue
              consumer?.push({ type: 'session/projection', sessionId: frame['sessionId'], key: 'title', value: title })
            }
          }
          if (frame['type'] === 'queue' && typeof frame['sessionId'] === 'string') {
            const rawItems = Array.isArray(frame['items']) ? frame['items'] as unknown[] : []
            const items = rawItems
              .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item['id'] === 'string')
              .map(item => ({
                id: item['id'] as string,
                summary: queueItemSummary(isRecord(item['message']) ? item['message']['content'] : undefined),
              }))
            consumer?.push({
              type: 'session/queue',
              sessionId: frame['sessionId'],
              items,
            })
          }
          // baseline / jobs / projection frames carry no live-render state.
        }
      } catch (cause) {
        if (!signal.aborted) {
          log?.('discord_host_control_threw', { cause: String(cause) })
        }
      }
    })()
  }

  return {
    track(sessionId, seed) {
      if (sessionId === '' || tracked.has(sessionId)) return
      if (disposed || rootSignal?.aborted) return
      if (seed !== undefined) {
        // Seed BEFORE the loop opens: the opening snapshot races the very
        // first watermark read.
        if (seed.floor !== undefined && seed.floor > (watermark.get(sessionId) ?? 0)) {
          watermark.set(sessionId, seed.floor)
        }
        if (seed.suppressOpeningSnapshot === true) suppressOnce.add(sessionId)
        if (seed.turnWindow !== undefined) followWindows.set(sessionId, seed.turnWindow)
      }
      startLoop(sessionId)
    },
    stream(signal) {
      if (process.env['DSH_DISCORD_TRACE'] === '1') console.error(`[dsh-discord:trace] router-stream-open tracked=${String(tracked.size)} rearm=${String(tracked.size)}`)
      rootSignal = signal
      const queue = createFrameQueue()
      consumer = queue
      // Re-arm every already-tracked session against the new consumer.
      for (const [sessionId, per] of [...tracked.entries()]) {
        per.abort()
        tracked.delete(sessionId)
        startLoop(sessionId)
      }
      startControlLoop(signal)
      return queue.iterate(signal)
    },
    dispose() {
      // Plugin teardown: the per-session follow loops run on their own
      // controllers (the consumer signal only reaches the control loop),
      // so nothing else stops them — without this, disposal leaves zombie
      // subscriptions and a re-arm chain that resubscribes forever.
      disposed = true
      rootSignal = undefined
      for (const [, per] of [...tracked.entries()]) per.abort()
      tracked.clear()
      for (const timer of rearmTimers) clearTimeout(timer)
      rearmTimers.clear()
      consumer?.close()
    },
  }
}
