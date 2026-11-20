/**
 * The copy table's runtime contract (design 16.25, English-only fork). The
 * type system already forces every call site to name an existing key; these
 * tests pin the parts types cannot express — that the table is English, that
 * no entry silently carries leftover Chinese text (a missed translation), and
 * the spot values the 16.114 attachment feedback depends on.
 */

import { describe, expect, it } from 'vitest'

import { attachmentRejectionCopy, createCopy, type CopyTable } from '../src/i18n.js'

/** Every copy member that is a plain (non-function) string value. */
function stringEntries(copy: CopyTable): Array<[string, string]> {
  return Object.entries(copy).filter(([, value]) => typeof value === 'string') as Array<[string, string]>
}

const CJK = /[\u4e00-\u9fff]/u

describe('i18n copy table', () => {
  it('returns one shared English table', () => {
    expect(createCopy()).toBe(createCopy())
  })

  // Obsolete in the English-only fork: there is no second table to align.
  // (Was: "keeps both tables key-aligned at runtime".)

  it('carries no Chinese text in the copy table', () => {
    for (const [key, value] of stringEntries(createCopy())) {
      expect(value, `copy.${key} still contains Chinese`).not.toMatch(CJK)
    }
  })

  it('resolves spot values', () => {
    expect(createCopy().stopStopped).toBe('🛑 Stopped.')
    expect(createCopy().interruptedMarker).toBe('*(interrupted)*')
    // Function members produce the localized placeholder too.
    expect(createCopy().bindConfirmPrompt('ws')).toContain('workspace "ws"')
    // 16.114 attachment feedback must exist.
    expect(createCopy().attachmentUnsupported).toContain('unsupported type')
    expect(createCopy().mainlineFileFailed).toContain('attached file')
    expect(createCopy().imageModalityRejected).toContain('image input')
    expect(createCopy().attachmentRejected).toContain('attachment')
  })
})

describe('attachment rejection notice (16.114)', () => {
  it('only the modality reason points at the model', () => {
    expect(attachmentRejectionCopy('session/attachment-invalid', 'MODEL_DOES_NOT_SUPPORT_IMAGES', createCopy()))
      .toBe(createCopy().imageModalityRejected)
  })

  it('an invalid or oversized image points at the file', () => {
    for (const reason of ['INVALID_IMAGE', 'IMAGE_TOO_LARGE', 'IMAGE_TYPE_MISMATCH']) {
      expect(attachmentRejectionCopy('session/attachment-invalid', reason, createCopy()))
        .toBe(createCopy().attachmentRejected)
    }
  })

  it('an absent detail is treated as a file problem, never a model limit', () => {
    expect(attachmentRejectionCopy('session/attachment-invalid', undefined, createCopy()))
      .toBe(createCopy().attachmentRejected)
  })

  it('other Host codes are not attachment notices', () => {
    expect(attachmentRejectionCopy('session/agent-busy', 'MODEL_DOES_NOT_SUPPORT_IMAGES', createCopy())).toBeUndefined()
    expect(attachmentRejectionCopy(undefined, undefined, createCopy())).toBeUndefined()
  })
})
