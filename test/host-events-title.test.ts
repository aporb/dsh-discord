/**
 * Thread-title sync, router half (fork addition).
 *
 * 0.2.2-rc.1 carries title changes on `session/control` projection frames:
 * `{type:'projection', sessionId, seq, changes:[{key:'title', val}]}`, where
 * `val` is either a plain string or a `{title}` snapshot. The router
 * translates exactly that change into the renderer's frame vocabulary:
 *
 *   {type:'session/projection', sessionId, key:'title', value:'…'}
 *
 * Non-title projection changes stay dropped, and the legacy `queue` frame
 * translation is untouched.
 */

import { describe, expect, it } from 'vitest'

import { createHostEventRouter, type HostSessionFollowFace } from '../src/dsh/host-events.js'

interface Collected {
  type?: string
  sessionId?: string
  key?: string
  value?: unknown
  items?: unknown
}

/**
 * Open the router's consumer stream over a face whose `control` iterable
 * plays the scripted frames; collect what the consumer receives, then abort
 * and dispose (so re-arm timers cannot keep the test alive).
 */
function collectControlFrames(script: ReadonlyArray<unknown>): Promise<unknown[]> {
  const face: HostSessionFollowFace = {
    follow(_request, signal) {
      return {
        async *[Symbol.asyncIterator]() {
          // No follow records here; stay open until the consumer aborts so
          // the router does not schedule re-arm timers mid-test.
          await Promise.resolve()
          yield* [] as unknown[]
          if (!signal.aborted) {
            await new Promise<void>(resolve => {
              signal.addEventListener('abort', () => { resolve() }, { once: true })
            })
          }
        },
      }
    },
    control(signal) {
      return {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve()
          for (const frame of script) {
            if (signal.aborted) return
            yield frame
          }
        },
      }
    },
  }
  const router = createHostEventRouter(face)
  const collected: unknown[] = []
  const controller = new AbortController()
  const consumer = (async () => {
    try {
      for await (const frame of router.stream(controller.signal)) collected.push(frame)
    } catch {
      // aborted
    }
  })()
  return new Promise<unknown[]>((resolve) => {
    setTimeout(() => {
      controller.abort()
      router.dispose()
      void consumer.then(() => { resolve(collected) })
    }, 40)
  })
}

describe('host-events: projection title translation', () => {
  it('translates title projection changes (snapshot and plain string) and drops other keys', async () => {
    const frames = await collectControlFrames([
      { type: 'projection', sessionId: 'sess-1', seq: 5, changes: [{ key: 'title', val: { title: 'Repo Review' } }] },
      { type: 'projection', sessionId: 'sess-1', seq: 6, changes: [{ key: 'title', val: 'Plain Title' }] },
      { type: 'projection', sessionId: 'sess-1', seq: 7, changes: [{ key: 'modelSelection', val: { provider: 'x' } }] },
      { type: 'projection', sessionId: 'sess-1', seq: 8, changes: [{ key: 'title', val: '   ' }] },
    ])
    const projections = frames.filter((frame): frame is Collected =>
      typeof frame === 'object' && frame !== null && (frame as Collected).type === 'session/projection')
    expect(projections.map(frame => ({ key: frame.key, value: frame.value, sessionId: frame.sessionId })))
      .toEqual([
        { key: 'title', value: 'Repo Review', sessionId: 'sess-1' },
        { key: 'title', value: 'Plain Title', sessionId: 'sess-1' },
      ])
  })

  it('keeps the legacy queue frame translation', async () => {
    const frames = await collectControlFrames([{ type: 'queue', sessionId: 'sess-1', items: [] }])
    const queues = frames.filter((frame): frame is Collected =>
      typeof frame === 'object' && frame !== null && (frame as Collected).type === 'session/queue')
    expect(queues).toHaveLength(1)
    expect(queues[0]?.sessionId).toBe('sess-1')
    expect(Array.isArray(queues[0]?.items)).toBe(true)
  })
})
