/**
 * TEMPORARY boot diagnostics for the local fork.
 *
 * The Host keeps its logger output in the Electron main process, which is
 * unreadable from inside a session, so a silent activation/composition
 * failure has no observable channel. This module appends one JSON line per
 * milestone to a temp file. Remove it once the fork is stable (tracked in
 * the fork README's known-limitations note while it exists).
 */

import { appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIAG_PATH = join(tmpdir(), 'dsh-discord-diag.log')

/** Append one diagnostic line; never throws, never awaits the caller. */
export function diag(event: string, detail?: unknown): void {
  if (process.env['DSH_DISCORD_DIAG'] === '0') return
  const line = `${new Date().toISOString()} ${event} ${detail === undefined ? '' : safeJson(detail)}\n`
  void appendFile(DIAG_PATH, line, 'utf8').catch(() => {})
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text
  } catch {
    return String(value)
  }
}
