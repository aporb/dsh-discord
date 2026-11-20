/**
 * The 0.2.2-rc.1 assistant-stream bridge (fork addition) in the host event
 * router.
 *
 * That host emits NO durable `assistant/chunk` event: live text deltas ride
 * `follow` frames `{type:'assistant-stream', frame}`, and a turn that started
 * before the subscription is carried by the opening snapshot's
 * `assistantStream.activeAttempt` baseline. The router re-shapes both into the
 * durable vocabulary the renderer already understands:
 *
 *   {type:'session/event', event:{type:'assistant/chunk',
 *    data:{turn, step, chunk:{type:'text-delta', text}}}, carrier:'live'}
 *
 * These tests drive the router with a scripted fake `follow()` and assert the
 * emitted frames, the replay of the snapshot baseline, and the drop rules
 * (non-text chunks, duplicate indices, chunks from another attempt).
 */

import { describe, expect, it } from 'vitest'

import {
  createHostEventRouter,
  type HostSessionFollowFace,
  type TrackSeedOptions,
} from '../src/dsh/host-events.js'

type SessionEvent = {
  type: 'session/event'
  sessionId: string
  event: { type: string; data?: Record<string, unknown> }
  carrier?: string
  seq?: number
}

interface ScriptedRouter {
  followRequests: Array<Record<string, unknown>>
  /** Open the consumer stream, track sess-1, let the scripted frames drain, abort. */
  collect(ms?: number, seed?: TrackSeedOptions): Promise<unknown[]>
}

/** A follow face that yields a fixed frame script once, then ends normally. */
function scriptedRouter(frames: ReadonlyArray<unknown>): ScriptedRouter {
  const followRequests: Array<Record<string, unknown>> = []
  const face: HostSessionFollowFace = {
    follow(request, signal) {
      followRequests.push(request as unknown as Record<string, unknown>)
      return {
        async *[Symbol.asyncIterator]() {
          // A microtask hop keeps the async-generator contract explicit; the
          // router's frame queue is what actually paces delivery.
          await Promise.resolve()
          for (const frame of frames) {
            if (signal.aborted) return
            yield frame
          }
        },
      }
    },
    control(signal) {
      return {
        async *[Symbol.asyncIterator]() {
          // Park until the consumer aborts: this test has no control frames.
          if (!signal.aborted) {
            await new Promise<void>(resolve => {
              signal.addEventListener('abort', () => { resolve() }, { once: true })
            })
          }
          // Unreachable in practice; it satisfies the async-generator
          // contract so the face stays structurally valid.
          if (signal.aborted) return
          yield { type: 'control-idle' }
        },
      }
    },
  }
  const router = createHostEventRouter(face)
  return {
    followRequests,
    async collect(ms = 40, seed): Promise<unknown[]> {
      const collected: unknown[] = []
      const controller = new AbortController()
      const consumer = (async () => {
        try {
          for await (const frame of router.stream(controller.signal)) collected.push(frame)
        } catch { /* aborted */ }
      })()
      // Mirror compose's order: the consumer stream opens first, then the
      // session-acquisition sites track.
      await new Promise(resolve => { setTimeout(resolve, 5) })
      router.track('sess-1', seed)
      await new Promise(resolve => { setTimeout(resolve, ms) })
      controller.abort()
      router.dispose()
      await consumer
      return collected
    },
  }
}

function streamFrame(frame: Record<string, unknown>): unknown {
  return { type: 'assistant-stream', frame }
}

function sessionEvents(frames: ReadonlyArray<unknown>): SessionEvent[] {
  return frames.filter((frame): frame is SessionEvent =>
    typeof frame === 'object' && frame !== null && (frame as { type?: unknown }).type === 'session/event')
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

describe('assistant-stream bridge: live deltas', () => {
  it('requests assistant streaming and re-shapes text deltas into assistant/chunk events', async () => {
    const h = scriptedRouter([
      streamFrame({ type: 'start', attemptId: 'a', turn: 1, step: 1 }),
      streamFrame({ type: 'chunk', attemptId: 'a', index: 0, chunk: { type: 'text-delta', text: 'Hel' } }),
      // Non-text chunks are not part of the assistant answer: ignored.
      streamFrame({ type: 'chunk', attemptId: 'a', index: 1, chunk: { type: 'reasoning-delta', text: 'ponder' } }),
      streamFrame({ type: 'chunk', attemptId: 'a', index: 2, chunk: { type: 'text-delta', text: 'lo' } }),
      // A redelivered index must not replay text (the wire is at-most-once).
      streamFrame({ type: 'chunk', attemptId: 'a', index: 2, chunk: { type: 'text-delta', text: 'DUP' } }),
      streamFrame({ type: 'end', attemptId: 'a' }),
    ])
    const frames = await h.collect()

    expect(h.followRequests).toEqual([
      { address: { kind: 'session', sessionId: 'sess-1' }, assistantStream: true },
    ])
    expect(frames).toContainEqual({ type: 'session/subscribed', sessionId: 'sess-1' })
    expect(sessionEvents(frames)).toEqual([
      {
        type: 'session/event',
        sessionId: 'sess-1',
        event: { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'Hel' } } },
        carrier: 'live',
      },
      {
        type: 'session/event',
        sessionId: 'sess-1',
        event: { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'lo' } } },
        carrier: 'live',
      },
    ])
    expect(json(frames)).not.toContain('DUP')
    expect(json(frames)).not.toContain('ponder')
  })

  it('drops chunks before start, from another attempt, and after end', async () => {
    const h = scriptedRouter([
      // Before any start: no turn/step identity to attach the delta to.
      streamFrame({ type: 'chunk', attemptId: 'a', index: 0, chunk: { type: 'text-delta', text: 'early' } }),
      streamFrame({ type: 'start', attemptId: 'a', turn: 3, step: 2 }),
      // A chunk from a different attempt is not ours.
      streamFrame({ type: 'chunk', attemptId: 'b', index: 0, chunk: { type: 'text-delta', text: 'other' } }),
      // No index on the wire: still a valid delta (no dedupe floor to apply).
      streamFrame({ type: 'chunk', attemptId: 'a', chunk: { type: 'text-delta', text: 'noidx' } }),
      streamFrame({ type: 'end', attemptId: 'a' }),
      // The attempt closed: a late delta is dropped.
      streamFrame({ type: 'chunk', attemptId: 'a', index: 1, chunk: { type: 'text-delta', text: 'late' } }),
      // Malformed assistant-stream payloads never throw.
      { type: 'assistant-stream', frame: 'not-a-record' },
    ])
    const frames = await h.collect()

    expect(sessionEvents(frames)).toEqual([
      {
        type: 'session/event',
        sessionId: 'sess-1',
        event: { type: 'assistant/chunk', data: { turn: 3, step: 2, chunk: { type: 'text-delta', text: 'noidx' } } },
        carrier: 'live',
      },
    ])
    expect(json(frames)).not.toContain('early')
    expect(json(frames)).not.toContain('other')
    expect(json(frames)).not.toContain('late')
  })
})

describe('assistant-stream bridge: snapshot baseline replay', () => {
  it('replays text-chunks and chunk records from the snapshot before live frames', async () => {
    const h = scriptedRouter([
      {
        type: 'snapshot',
        records: [{ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } }],
        assistantStream: {
          activeAttempt: {
            attemptId: 'a',
            turn: 1,
            step: 2,
            nextIndex: 4,
            stream: [
              { type: 'text-chunks', texts: ['A', 'B'] },
              { type: 'chunk', chunk: { type: 'text-delta', text: 'C' } },
              // Non-text baseline records are skipped.
              { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'hidden' } },
            ],
          },
        },
      },
      // Below the baseline's nextIndex (4): already replayed, must be dropped.
      streamFrame({ type: 'chunk', attemptId: 'a', index: 2, chunk: { type: 'text-delta', text: 'stale' } }),
      // At/after nextIndex: delivered live.
      streamFrame({ type: 'chunk', attemptId: 'a', index: 4, chunk: { type: 'text-delta', text: 'D' } }),
      streamFrame({ type: 'chunk', attemptId: 'a', index: 5, chunk: { type: 'text-delta', text: 'E' } }),
      streamFrame({ type: 'end', attemptId: 'a' }),
    ])
    const frames = await h.collect()

    const events = sessionEvents(frames)
    expect(events[0]).toEqual({
      type: 'session/event',
      sessionId: 'sess-1',
      event: { type: 'turn/start', data: { turn: 1 } },
      carrier: 'snapshot',
      seq: 1,
    })
    expect(events.slice(1)).toEqual([
      {
        type: 'session/event',
        sessionId: 'sess-1',
        event: { type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'text-delta', text: 'A' } } },
        carrier: 'live',
      },
      {
        type: 'session/event',
        sessionId: 'sess-1',
        event: { type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'text-delta', text: 'B' } } },
        carrier: 'live',
      },
      {
        type: 'session/event',
        sessionId: 'sess-1',
        event: { type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'text-delta', text: 'C' } } },
        carrier: 'live',
      },
      {
        type: 'session/event',
        sessionId: 'sess-1',
        event: { type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'text-delta', text: 'D' } } },
        carrier: 'live',
      },
      {
        type: 'session/event',
        sessionId: 'sess-1',
        event: { type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'text-delta', text: 'E' } } },
        carrier: 'live',
      },
    ])
    expect(json(frames)).not.toContain('stale')
    expect(json(frames)).not.toContain('hidden')
  })

  it('ignores a malformed or empty snapshot baseline', async () => {
    const h = scriptedRouter([
      { type: 'snapshot', records: [] },
      { type: 'snapshot', records: [], assistantStream: { activeAttempt: { attemptId: 'a' } } },
      { type: 'snapshot', records: [], assistantStream: { activeAttempt: { attemptId: 'a', turn: 1, step: 1, stream: [] } } },
      streamFrame({ type: 'start', attemptId: 'a', turn: 1, step: 1 }),
      streamFrame({ type: 'chunk', attemptId: 'a', index: 0, chunk: { type: 'text-delta', text: 'ok' } }),
    ])
    const frames = await h.collect()

    expect(sessionEvents(frames)).toEqual([
      {
        type: 'session/event',
        sessionId: 'sess-1',
        event: { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'ok' } } },
        carrier: 'live',
      },
    ])
  })
})
