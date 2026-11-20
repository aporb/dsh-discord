/**
 * Thread-title sync, renderer half (fork addition).
 *
 * The renderer renames the bound Discord thread from either carrier:
 * - the durable `session/title` event (`data.title`), which 0.2.2-rc.1 writes
 *   for model-generated and explicit titles, or
 * - the router's translated `session/projection` frame with key `title`.
 *
 * Dedupe rules: one rename per distinct title per runtime, and no rename when
 * the thread's current wire name already slugifies to the same value
 * (Discord throttles renames hard). Names go through `safeTitle`, which
 * neutralizes mention syntax and caps the length at 100.
 */

import { describe, expect, it } from 'vitest'

import { startLiveRender, type LiveDeliveryPort, type LiveFrame } from '../src/stream/live.js'

type DeliveryCall = { kind: 'send' | 'edit' | 'typing' | 'rename' | 'delete'; channelId: string; name?: string }

function createDelivery(): { delivery: LiveDeliveryPort; calls: DeliveryCall[] } {
  const calls: DeliveryCall[] = []
  const delivery: LiveDeliveryPort = {
    send: (request) => {
      calls.push({ kind: 'send', channelId: request.channelId })
      return Promise.resolve({ outcome: 'completed', messageId: 'm-1' })
    },
    edit: (request) => {
      calls.push({ kind: 'edit', channelId: request.channelId })
      return Promise.resolve({ outcome: 'completed' })
    },
    typing: (channelId) => {
      calls.push({ kind: 'typing', channelId })
      return Promise.resolve()
    },
    renameThread: (request) => {
      calls.push({ kind: 'rename', channelId: request.channelId, name: request.name })
      return Promise.resolve({ outcome: 'completed' })
    },
    delete: (request) => {
      calls.push({ kind: 'delete', channelId: request.channelId })
      return Promise.resolve({ outcome: 'completed' })
    },
  }
  return { delivery, calls }
}

async function drive(
  frames: LiveFrame[],
  options: { threadName?: (channelId: string) => Promise<string | undefined> } = {},
): Promise<DeliveryCall[]> {
  const { delivery, calls } = createDelivery()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  async function* source(): AsyncIterable<LiveFrame> {
    for (const frame of frames) {
      yield frame
      await new Promise(resolve => { setTimeout(resolve, 5) })
    }
    release()
  }
  const live = startLiveRender({
    frames: source,
    threadForSession: () => 'thread-1',
    delivery,
    updateIntervalMs: 0,
    activityCoalesceMs: 0,
    typingIntervalMs: 60_000,
    ...(options.threadName === undefined ? {} : { threadName: options.threadName }),
  })
  await gate
  await new Promise(resolve => { setTimeout(resolve, 15) })
  live.dispose()
  return calls
}

function titleEvent(title: string): LiveFrame {
  return {
    type: 'session/event',
    sessionId: 'sess-1',
    event: { type: 'session/title', data: { title } },
  }
}

function renameCalls(calls: DeliveryCall[]): DeliveryCall[] {
  return calls.filter(call => call.kind === 'rename')
}

describe('live renderer: thread title sync', () => {
  it('renames the thread on the durable session/title event and dedupes the same title', async () => {
    const calls = await drive([titleEvent('Repo Review'), titleEvent('Repo Review')])
    const renames = renameCalls(calls)
    expect(renames).toHaveLength(1)
    expect(renames[0]).toMatchObject({ channelId: 'thread-1', name: 'Repo Review' })
  })

  it('renames on a translated title projection frame', async () => {
    const calls = await drive([
      { type: 'session/projection', sessionId: 'sess-1', key: 'title', value: 'Another Name' },
    ])
    expect(renameCalls(calls)).toHaveLength(1)
    expect(renameCalls(calls)[0]).toMatchObject({ channelId: 'thread-1', name: 'Another Name' })
  })

  it('skips a rename when the thread wire name already slugifies to the title', async () => {
    const calls = await drive([titleEvent('Repo Review')], {
      threadName: () => Promise.resolve('repo-review'),
    })
    expect(renameCalls(calls)).toHaveLength(0)
  })

  it('sanitizes mention syntax and caps the name at 100 characters', async () => {
    const calls = await drive([
      titleEvent(`@everyone <@123> ${'long '.repeat(40)}`),
    ])
    const renames = renameCalls(calls)
    expect(renames).toHaveLength(1)
    const name = renames[0]?.name ?? ''
    expect(name.includes('@everyone')).toBe(false)
    expect(/<@\d/u.test(name)).toBe(false)
    expect(name.length).toBeLessThanOrEqual(100)
  })
})
