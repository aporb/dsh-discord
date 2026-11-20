/**
 * The mention-driven conversation picker (fork addition).
 *
 * A mention in a channel that is not bound to a Workspace no longer answers
 * with a bind affordance: it anchors a thread and posts a two-step picker —
 * first the Workspace, then one of that Workspace's recent conversations or
 * "New conversation". Selecting a conversation binds the thread to it and
 * starts the live render from the Host's own follow snapshot, so the thread
 * mirrors the conversation from either surface.
 *
 * Wire hygiene: Discord select-menu option VALUES are wire-visible, so they
 * carry only positional indices. The candidates (workspace/session ids)
 * live in the process-local component registry alongside the custom_id,
 * exactly like every other adapter control. This module is pure planning:
 * candidate rows in, Discord-shaped options out, and the inverse index
 * mapping that the router uses on a click.
 */

/** One registered Workspace as the picker offers it. */
export interface PickerWorkspaceRow {
  workspaceId: string
  title: string
  /** The Workspace's registered path, when the Host reports one. */
  path?: string
}

/** One Session row as the picker offers it (already filtered by the caller). */
export interface PickerSessionRow {
  sessionId: string
  title?: string
  updatedAt: number
  running: boolean
  cwd?: string
}

/** One Discord string-select option. */
export interface PickerChoice {
  label: string
  value: string
  description?: string
}

/** The value that means "create a new conversation in this Workspace". */
export const NEW_CONVERSATION_VALUE = 'new'

/** Discord rejects a select with more than 25 options. */
export const MAX_SELECT_OPTIONS = 25

/** One option is reserved for "New conversation". */
const MAX_SESSION_OPTIONS = MAX_SELECT_OPTIONS - 1

/** A select label caps at 100 characters on the wire. */
const LABEL_MAX = 100

function trimLabel(label: string): string {
  return label.length <= LABEL_MAX ? label : `${label.slice(0, LABEL_MAX - 1)}…`
}

/** Short display form of a session id (first 8 characters). */
export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

/** Relative age for a candidate label; the wire has no description field. */
export function relativeAge(fromMs: number, nowMs: number): string {
  const delta = Math.max(0, nowMs - fromMs)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${String(minutes)}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h ago`
  return `${String(Math.floor(hours / 24))}d ago`
}

/**
 * Workspace choices, in the Host's own catalog order. Values are positional
 * indices; the caller stores the matching rows in the registry context.
 */
export function workspaceChoices(rows: ReadonlyArray<PickerWorkspaceRow>): PickerChoice[] {
  return rows.slice(0, MAX_SELECT_OPTIONS).map((row, index) => ({
    label: trimLabel(row.title === '' ? shortId(row.workspaceId) : row.title),
    value: String(index),
    ...(row.path === undefined ? {} : { description: trimLabel(row.path) }),
  }))
}

/**
 * Session choices for one Workspace: newest first, blank sessions hidden,
 * already-bound sessions excluded (their thread is the live surface), and
 * subagent/archived sessions never offered. "New conversation" rides last
 * so the common attach flow needs no extra scroll on a short list.
 */
export function sessionChoices(
  rows: ReadonlyArray<PickerSessionRow>,
  options: { boundSessionIds?: ReadonlySet<string>; nowMs?: number } = {},
): PickerChoice[] {
  const nowMs = options.nowMs ?? Date.now()
  const bound = options.boundSessionIds ?? new Set<string>()
  const visible = rows
    .filter(row => !bound.has(row.sessionId))
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSION_OPTIONS)
  const choices: PickerChoice[] = visible.map((row, index) => ({
    label: trimLabel(`${row.title ?? shortId(row.sessionId)} · ${relativeAge(row.updatedAt, nowMs)}${row.running ? ' · running' : ''}`),
    value: String(index),
  }))
  choices.push({ label: '➕ New conversation', value: NEW_CONVERSATION_VALUE })
  return choices
}

/**
 * Resolve one select-menu value to a positional index. Returns `undefined`
 * for the "new conversation" sentinel, `null` for a malformed/forged value.
 */
export function resolveChoiceIndex(value: string, length: number): number | null | undefined {
  if (value === NEW_CONVERSATION_VALUE) return undefined
  if (!/^\d+$/u.test(value)) return null
  const index = Number.parseInt(value, 10)
  if (!Number.isInteger(index) || index < 0 || index >= length) return null
  return index
}

/** Whether a session row belongs in this Workspace's picker. */
export function isPickerSession(
  row: { blank?: boolean | undefined; cwd?: string | undefined; origin?: string | undefined },
  workspacePath: string | undefined,
): boolean {
  if (row.blank === true) return false
  if (row.origin === 'subagent') return false
  if (workspacePath === undefined) return row.cwd === undefined
  return row.cwd === workspacePath
}
