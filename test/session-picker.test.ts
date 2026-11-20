/**
 * The conversation picker's pure planning layer (fork addition).
 *
 * Wire hygiene is the theme: Discord select-menu VALUES are wire-visible, so
 * the plan emits positional indices and the router maps them back through
 * `resolveChoiceIndex`. These tests pin the shaping, the caps Discord
 * enforces (25 options, 100-char labels), and the session scoping rules the
 * caller applies through `isPickerSession`.
 */

import { describe, expect, it } from 'vitest'

import {
  MAX_SELECT_OPTIONS,
  NEW_CONVERSATION_VALUE,
  isPickerSession,
  relativeAge,
  resolveChoiceIndex,
  sessionChoices,
  shortId,
  workspaceChoices,
  type PickerSessionRow,
  type PickerWorkspaceRow,
} from '../src/features/session-picker.js'

const NOW = 1_800_000_000_000

function workspace(overrides: Partial<PickerWorkspaceRow> & { workspaceId: string }): PickerWorkspaceRow {
  return { title: overrides.workspaceId, ...overrides }
}

function session(overrides: Partial<PickerSessionRow> & { sessionId: string }): PickerSessionRow {
  return { updatedAt: NOW, running: false, ...overrides }
}

describe('workspaceChoices', () => {
  it('emits positional index values and keeps catalog order', () => {
    const choices = workspaceChoices([
      workspace({ workspaceId: 'ws-1', title: 'Alpha' }),
      workspace({ workspaceId: 'ws-2', title: 'Beta' }),
    ])
    expect(choices).toEqual([
      { label: 'Alpha', value: '0' },
      { label: 'Beta', value: '1' },
    ])
  })

  it('falls back to the short workspace id when the title is empty', () => {
    const choices = workspaceChoices([workspace({ workspaceId: 'abcdefghijkl', title: '' })])
    expect(choices).toEqual([{ label: 'abcdefgh', value: '0' }])
  })

  it('rides the registered path in the description and omits it when absent', () => {
    const choices = workspaceChoices([
      workspace({ workspaceId: 'ws-1', title: 'Alpha', path: '/tmp/alpha' }),
      workspace({ workspaceId: 'ws-2', title: 'Beta' }),
    ])
    expect(choices[0]).toEqual({ label: 'Alpha', value: '0', description: '/tmp/alpha' })
    expect(choices[1]).toEqual({ label: 'Beta', value: '1' })
  })

  it('caps the list at Discord\'s 25-option ceiling', () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      workspace({ workspaceId: `ws-${String(index)}`, title: `W${String(index)}` }))
    const choices = workspaceChoices(rows)
    expect(choices).toHaveLength(MAX_SELECT_OPTIONS)
    expect(choices[24]).toEqual({ label: 'W24', value: '24' })
  })

  it('trims an over-long label to 100 characters with an ellipsis', () => {
    const choices = workspaceChoices([workspace({ workspaceId: 'ws-1', title: 'T'.repeat(150) })])
    const label = choices[0]?.label ?? ''
    expect(label).toHaveLength(100)
    expect(label).toBe(`${'T'.repeat(99)}…`)
  })

  it('trims an over-long path description the same way', () => {
    const choices = workspaceChoices([workspace({ workspaceId: 'ws-1', title: 'Alpha', path: 'p'.repeat(150) })])
    const description = choices[0]?.description ?? ''
    expect(description).toHaveLength(100)
    expect(description).toBe(`${'p'.repeat(99)}…`)
  })
})

describe('sessionChoices', () => {
  it('sorts newest-first and labels each row with age and the running marker', () => {
    const choices = sessionChoices([
      session({ sessionId: 's-old', title: 'Old one', updatedAt: NOW - 3 * 3_600_000 }),
      session({ sessionId: 's-new', title: 'New one', updatedAt: NOW - 30_000, running: true }),
      session({ sessionId: 's-bound', title: 'Bound one', updatedAt: NOW }),
    ], { boundSessionIds: new Set(['s-bound']), nowMs: NOW })

    expect(choices).toEqual([
      { label: 'New one · just now · running', value: '0' },
      { label: 'Old one · 3h ago', value: '1' },
      // "New conversation" rides last so a short list needs no extra scroll.
      { label: '➕ New conversation', value: NEW_CONVERSATION_VALUE },
    ])
  })

  it('uses the short session id for an untitled row', () => {
    const choices = sessionChoices([session({ sessionId: 'abcdefghijkl', updatedAt: NOW })], { nowMs: NOW })
    expect(choices[0]).toEqual({ label: 'abcdefgh · just now', value: '0' })
  })

  it('keeps at most 24 sessions and appends the new-conversation sentinel last', () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      session({ sessionId: `s-${String(index)}`, title: `S${String(index)}`, updatedAt: NOW - index * 60_000 }))
    const choices = sessionChoices(rows, { nowMs: NOW })
    expect(choices).toHaveLength(MAX_SELECT_OPTIONS)
    expect(choices).toHaveLength(24 + 1)
    expect(choices[23]).toEqual({ label: 'S23 · 23m ago', value: '23' })
    expect(choices.at(-1)).toEqual({ label: '➕ New conversation', value: NEW_CONVERSATION_VALUE })
  })

  it('does not filter blank or subagent rows itself — that is the caller\'s job', () => {
    // The router filters candidates through isPickerSession before calling
    // this planner; a blank/subagent row handed in directly still renders.
    const choices = sessionChoices([
      session({ sessionId: 's-blank', title: 'Blank', updatedAt: NOW, cwd: '/w' }),
      session({ sessionId: 's-sub', title: 'Subagent', updatedAt: NOW - 1, cwd: '/w' }),
    ], { nowMs: NOW })
    expect(choices.map(choice => choice.label)).toEqual([
      'Blank · just now',
      'Subagent · just now',
      '➕ New conversation',
    ])
  })
})

describe('resolveChoiceIndex', () => {
  it('maps the new-conversation sentinel to undefined', () => {
    expect(resolveChoiceIndex(NEW_CONVERSATION_VALUE, 3)).toBeUndefined()
  })

  it('resolves a valid positional value to its index', () => {
    expect(resolveChoiceIndex('0', 2)).toBe(0)
    expect(resolveChoiceIndex('1', 2)).toBe(1)
  })

  it('rejects malformed or out-of-range values with null', () => {
    expect(resolveChoiceIndex('2', 2)).toBeNull()
    expect(resolveChoiceIndex('0', 0)).toBeNull()
    expect(resolveChoiceIndex('999999999999999999999', 2)).toBeNull()
    expect(resolveChoiceIndex('', 2)).toBeNull()
    expect(resolveChoiceIndex('abc', 2)).toBeNull()
    expect(resolveChoiceIndex('1.5', 2)).toBeNull()
    expect(resolveChoiceIndex('-1', 2)).toBeNull()
  })
})

describe('isPickerSession', () => {
  it('rejects blank and subagent rows outright', () => {
    expect(isPickerSession({ blank: true, cwd: '/w' }, '/w')).toBe(false)
    expect(isPickerSession({ origin: 'subagent', cwd: '/w' }, '/w')).toBe(false)
  })

  it('scopes rows to the workspace path when one is known', () => {
    expect(isPickerSession({ cwd: '/w' }, '/w')).toBe(true)
    expect(isPickerSession({ cwd: '/other' }, '/w')).toBe(false)
    expect(isPickerSession({ }, '/w')).toBe(false)
    expect(isPickerSession({ origin: 'mention', cwd: '/w' }, '/w')).toBe(true)
  })

  it('asks for un-scoped rows when the workspace path is unknown', () => {
    // No path to compare against: only rows the Host reports without a cwd
    // are safe to offer (offering another workspace's sessions is worse than
    // offering none).
    expect(isPickerSession({}, undefined)).toBe(true)
    expect(isPickerSession({ cwd: '/w' }, undefined)).toBe(false)
  })
})

describe('relativeAge', () => {
  it('renders the coarse buckets', () => {
    expect(relativeAge(NOW, NOW)).toBe('just now')
    expect(relativeAge(NOW - 59_000, NOW)).toBe('just now')
    expect(relativeAge(NOW - 60_000, NOW)).toBe('1m ago')
    expect(relativeAge(NOW - 59 * 60_000, NOW)).toBe('59m ago')
    expect(relativeAge(NOW - 60 * 60_000, NOW)).toBe('1h ago')
    expect(relativeAge(NOW - 23 * 3_600_000, NOW)).toBe('23h ago')
    expect(relativeAge(NOW - 24 * 3_600_000, NOW)).toBe('1d ago')
    expect(relativeAge(NOW - 2 * 86_400_000, NOW)).toBe('2d ago')
  })

  it('clamps a future timestamp to "just now"', () => {
    expect(relativeAge(NOW + 10_000, NOW)).toBe('just now')
  })
})

describe('shortId', () => {
  it('takes the first eight characters', () => {
    expect(shortId('abcdefghijkl')).toBe('abcdefgh')
    expect(shortId('abc')).toBe('abc')
    expect(shortId('')).toBe('')
  })
})
