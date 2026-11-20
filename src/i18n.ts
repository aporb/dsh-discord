/**
 * English copy for every user-facing Discord string.
 *
 * This fork is an English-only build: `CopyTable` is the type of the single
 * table below, so a call site that names a missing key fails to compile.
 */

const en = {
  bindConfirmButton: 'Confirm bind',
  bindCancelButton: 'Cancel',
  bindAdminOnly: '⚠️ Only workspace administrators can bind channels.',
  bindUsage: '💡 Usage: /project bind workspace:<pick from candidates>',
  bindWorkspaceGone: '⚠️ That workspace no longer exists; pick again from /project bind candidates.',
  bindWorkspaceUnknown: '⚠️ The workspace directory could not be confirmed in time (unknown); try again later.',
  bindWorkspaceUnavailable: '⚠️ The workspace directory is temporarily unavailable; try again later.',
  bindChannelExists: (title: string, existing: string) => `A channel for workspace "${title}" already exists at <#${existing}>`,
  bindConfirmPrompt: (title: string) => `Create a dedicated channel for workspace "${title}" (under the DeepSeek Harness category)?`,
  bindCancelled: 'Cancelled — no channel was created.',
  bindChannelFailed: '⚠️ Channel creation failed; try again later.',
  bindChannelCreated: (title: string, channelId: string) => `💡 Created a channel for workspace "${title}": <#${channelId}>`,
  bindChannelExisting: (title: string, channelId: string) => `💡 Workspace "${title}" already has a channel: <#${channelId}>`,

  listEmpty: '(no registered workspaces)',
  listHeader: '**Available workspaces**',
  listTruncated: (shown: number, total: number) => `\n(showing ${String(shown)} of ${String(total)})`,
  infoUnboundAllowed: 'This channel is not bound to a workspace; use the workspace home channel (/project bind creates one).',
  infoUnbound: '⚠️ This channel is not bound to a workspace.',
  infoMemberOnly: '⚠️ Only members can view this channel binding.',
  infoUnknown: '⚠️ The workspace directory could not be confirmed in time (unknown); try again later.',
  infoStale: '⚠️ The bound workspace no longer exists; re-run /project bind.',
  infoUnavailable: '⚠️ The workspace directory is temporarily unavailable; try again later.',
  infoRevision: (revision: string, binder: string) => `Revision ${revision} (bound by <@${binder}>)`,
  infoPath: (path: string) => `Path: \`${path}\``,
  unknownSubcommand: '💡 Unknown subcommand. Feedback & docs: https://github.com/aporb/dsh-discord',

  stopNotSessionThread: '⚠️ This channel is not an adapter-owned session thread.',
  stopNothingRunning: 'This thread has no running task to stop.',
  stopNotOwner: '⚠️ The running task was not submitted from this thread and cannot be stopped here.',
  stopStopped: '🛑 Stopped.',
  stopStoppedQueuePreserved: '🛑 Stopped; queued messages are preserved.',
  stopRejected: '⚠️ DSH rejected the stop request.',
  stopUnknown: '⚠️ Stop outcome unknown; check the DSH web console.',
  steerUsage: '💡 Usage: /steer prompt:<steering text>',
  steerNothingRunning: 'This thread has no running task to steer.',
  steerNotOwner: '⚠️ The running task was not submitted from this thread and cannot be steered here.',
  steerQueued: '↪️ Steering delivered.',
  steerRejected: '⚠️ DSH rejected the steering.',
  steerUnknown: '⚠️ Steering outcome unknown.',
  queueNotSessionThread: '⚠️ This channel is not an adapter-owned session thread.',
  queueRemoveUsage: '💡 Usage: /queue remove item:<position from /queue list>',
  queueItemNotFound: 'Queue item not found; run /queue list for fresh positions.',
  queueRemoved: (summary: string) => `⏳ Removed: ${summary}`,
  queueRemoveRejected: '⚠️ DSH rejected the removal (the item may already be handled).',
  queueRemoveUnknown: '⚠️ Removal outcome unknown; verify with /queue list and retry.',
  queueNoData: '⚠️ No queue data yet (the process may have just restarted); it syncs after session activity.',
  queueEmpty: '⏳ (queue is empty)',
  queueHeader: '⏳ **Queue**',
  queueRemoveHint: '💡 Use `/queue remove <position>` to remove.',

  forgetOperatorOnly: '⚠️ Only Host operators can forget a Guild.',
  forgetConfirmPrompt: '⚠️ This deletes every adapter-owned record for this Guild (bindings/intents; DSH workspaces and sessions are untouched). Continue?',
  forgetConfirmButton: 'Confirm forget',
  forgetDone: '💡 Guild forgotten: adapter records (bindings/intents) are deleted; DSH workspaces and sessions are untouched.',
  infoLine: (version: string, connection: string) =>
    `📡 DSH Discord v${version} · ${connection}\n⭐ Feedback & docs: https://github.com/aporb/dsh-discord`,

  commandFailed: '⚠️ Command handling failed; try again later.',
  confirmNotOwner: '⚠️ This confirmation is not yours.',
  submittedAck: '💡 Your choice has been submitted.',
  unresolvedAck: '⚠️ Outcome unknown; DSH did not confirm — do not repeat the click.',
  expiredControl: '⚠️ This control has expired or is no longer valid; run the command again.',

  questionSubmitted: '💡 Answers submitted.',
  questionDenied: '⚠️ This question is not yours.',
  questionAlreadyResolved: '💡 This question has already been handled.',
  questionIncomplete: '💡 Some questions are unanswered; complete them before submitting.',
  questionInvalid: (reason: string) => `⚠️ Invalid answer: ${reason}`,
  questionUnresolved: '⚠️ Outcome unknown; DSH did not confirm.',
  questionResolvedElsewhere: '💡 This question was already handled by another client.',
  questionWebOnlyNotice: '💡 These questions exceed what Discord can display (e.g. too many questions or options); they were sent to the DSH web app for answering.',

  mainlineThreadConflict: '⚠️ This message was already used for another session task; the thread cannot be recreated.',
  mainlineThreadFailed: '⚠️ Thread creation failed; try again later.',
  mainlineSessionRejected: '⚠️ DSH rejected the session creation (the workspace may be stale); try again later or re-run /project bind.',
  mainlineSessionUnknown: '⚠️ Session creation outcome unknown; confirm on the DSH web console before retrying. It will not be resubmitted automatically.',
  mainlinePromptRejected: '⚠️ DSH rejected the task submission.',
  mainlineImageFailed: '⚠️ Could not fetch the attached image(s); the task was not submitted. Retry or describe it in text.',
  mainlineFileFailed: '⚠️ Could not read the attached file(s); the task was not submitted. Retry or describe it in text.',
  mainlinePromptUnknown: '⚠️ Task submission outcome unknown; it will not be resent automatically to avoid double execution. Confirm and retry.',
  continuationRejected: '⚠️ The message submission was rejected by DSH.',
  continuationUnknown: '⚠️ Message submission outcome unknown; it will not be resent automatically. Confirm and retry.',
  attachmentUnsupported: '⚠️ These attachment(s) were not delivered (unsupported type). Currently only images and text files are supported:',
  imageModalityRejected: '⚠️ The current model does not accept image input. Enable image input for this model in Settings → Models.',
  attachmentRejected: '⚠️ DSH rejected the attachment and the task was not submitted. Check the file format and size, then retry.',

  unboundNoticeAdministrator: '💡 This channel is not bound to a workspace. A workspace administrator can run `/project bind` to create and bind the project channel.',
  unboundNoticeMember: '💡 This channel is not bound to a workspace; ask a workspace administrator to run `/project bind`.',

  interruptedMarker: '*(interrupted)*',

  progressThinking: '⏳ Thinking…',
  progressThinkingStep: (step: number) => `⏳ Thinking… (step ${String(step)})`,
  progressWriting: '✍️ Writing the answer…',
  progressApprovalWait: '⏳ Waiting for approval…',
  progressTurnSummary: (total: number, failed: number, breakdown: string) =>
    failed > 0
      ? `⚙️ ${String(total)} tool calls this turn · ${String(failed)} failed ✗ (${breakdown})`
      : `⚙️ ${String(total)} tool calls this turn ✓ (${breakdown})`,
  userInputLabel: '💬 User input',
  userInputNonText: '(non-text message)',
  userInputTruncated: '(truncated)',

  // ── /model show / select ─────────────────────────────────────────────
  modelNeedsThread: '⚠️ /model needs a thread bound to a Session (mention the bot in a project channel first).',
  modelShowUnavailable: '⚠️ The model catalog is temporarily unavailable; try again later.',
  modelShowHeader: (sel: string, groups: number) => `**Current model:** \`${sel}\`\n**Available providers:** ${String(groups)}`,
  modelShowReasoning: (effort: string) => `\n**Reasoning effort:** \`${effort}\``,
  modelShowNotRoutable: '\n⚠️ The current provider is not serving requests right now.',
  modelShowFailures: (names: string) => `\n⚠️ Providers failing catalog lookup: ${names}`,
  modelShowNoGroups: '\n(no providers currently advertise models)',
  modelSelectOperatorOnly: '⚠️ Only Host operators can switch the model (it switches this Session and updates the Host default).',
  modelSelectNoModels: '⚠️ No providers currently advertise models; nothing to select.',
  modelCascadeProviderHeader: (current: string, extra: string) => `Current model: \`${current}\`${extra}\nSelect a provider:`,
  modelCascadeProviderPlaceholder: 'Select a provider',
  modelCascadeModelHeader: (provider: string) => `Provider: **${provider}**\nSelect a model:`,
  modelCascadeModelPlaceholder: 'Select a model',
  modelCascadeReasoningHeader: (model: string) => `Model: **${model}**\nSelect a reasoning effort:`,
  modelCascadeReasoningPlaceholder: 'Select a reasoning effort',
  modelCascadeReasoningDefault: 'Provider default',
  modelCascadeReasoningDefaultHint: 'Use the provider/default reasoning behavior',
  modelCascadeTruncated: (shown: number, total: number) => `(${String(total)} total, showing the first ${String(shown)})`,
  modelCascadeExpired: '⚠️ This selection expired; run /model select again.',
  modelApplied: (sel: string) => `✅ Applied to this session: \`${sel}\`. DSH has also been asked to record it as the Host default.`,
  modelSelectUnknown: '⚠️ The selection outcome is unknown (the request may not have landed); check /model show.',
  modelSelectRejected: (reason: string) => `⚠️ DSH rejected the selection: ${reason}`,
  modelNotInCatalog: "⚠️ That provider/model is not in this session's catalog.",
  modelInvalidReasoning: '⚠️ That reasoning effort is not valid for this model.',
  modelTypedParseFailed: '⚠️ The model must be `provider/model`, or left empty for the interactive cascade.',

  // ── /permission show / set (16.59–16.61) ─────────────────────────────
  permissionNeedsThread: '⚠️ /permission needs a task Thread bound to a Session (mention the bot in a project channel first).',
  permissionShowUnavailable: '⚠️ The permission catalog is temporarily unavailable; try again shortly.',
  permissionShowHeader: (current: string, entries: string) => `**Current permission mode:** ${current}\n**Switchable:** ${entries}`,
  permissionShowUnknownCurrent: 'unknown (projection unreadable)',
  permissionPresetReadOnly: 'View only',
  permissionPresetWorkspaceWrite: 'Workspace edit',
  permissionPresetFullAccess: 'Full access',
  permissionApplied: (label: string) => `✅ Permission mode switched: ${label} (sandbox and approval follow the preset).`,
  permissionRejected: (reason: string) => `⚠️ DSH rejected this switch: ${reason}`,
  permissionUnknown: '⚠️ The switch outcome is unknown (the command may have run); confirm with /permission show.',
  permissionSelectOperatorOnly: '⚠️ Only Host operators can switch the permission mode (full access disables both sandbox and approval).',
  permissionNotInCatalog: "⚠️ That preset is not in this deployment's permission catalog.",
  permissionConfirmHeader: (label: string) => `⚠️ Enable "${label}"?`,
  permissionConfirmBody: 'After enabling, this Session will require fewer confirmations and can directly perform sensitive operations, file changes, or external commands. Only recommended when you trust the upcoming work.',
  permissionConfirmButton: 'I understand the risk, enable',
  permissionConfirmCancelButton: 'Cancel',
  permissionConfirmed: (label: string) => `✅ Confirmed — switching to "${label}"…`,
  permissionCancelled: 'Cancelled; the permission mode is unchanged.',
  permissionConfirmExpired: '⚠️ That confirmation expired; run /permission set again.',
  permissionSystemLine: (label: string) => `🔧 Permission mode → ${label}`,


  // ── /session resume ──────────────────────────────────────────────────
  sessionResumeNeedsBoundChannel: '⚠️ /session resume must run in a bound project channel.',
  sessionResumeStarted: (threadId: string) => `✅ Session resumed into <#${threadId}> — full history lives in the web UI; continue in the thread.`,
  sessionResumeAlreadyBound: (threadId: string) => `This session already lives in <#${threadId}>.`,
  sessionResumeFailed: '⚠️ Resuming the session failed; try again later.',
  sessionResumeAnchor: (title: string) => `📌 Resumed session: ${title}`,
  sessionResumeControlChannel: 'general is the control channel and carries no sessions — use /session resume in a workspace channel.',
  sessionResumeSubagent: '⚠️ That is a subagent session — it cannot be resumed as a top-level thread; view it in the web UI.',
  sessionResumeArchived: '⚠️ That session is archived — a resumed one never runs; unarchive it in the web UI first.',
  sessionCandidateJustNow: 'just now',
  sessionCandidateMinutesAgo: (minutes: number) => `${String(minutes)}m ago`,
  sessionCandidateHoursAgo: (hours: number) => `${String(hours)}h ago`,
  sessionCandidateDaysAgo: (days: number) => `${String(days)}d ago`,
  sessionCandidateRunning: 'running',

  // ── conversation picker (fork addition) ──────────────────────────────
  pickerThreadAnchor: '📌 Conversation picker',
  pickerHeader: '**Which conversation should this thread follow?**\nPick the workspace first; the next step lists that workspace\'s recent conversations.',
  pickerWorkspacePlaceholder: 'Select a workspace',
  pickerSessionHeader: (workspaceTitle: string) => `**${workspaceTitle}** — pick a conversation to follow, or start a new one.`,
  pickerSessionPlaceholder: 'Select a conversation',
  pickerFollowed: (title: string) => `✅ This thread now follows **${title}**. Messages typed here are sent to that conversation, and its answers stream back.`,
  pickerStarted: (title: string) => `✅ Started **${title}** in this workspace. This thread follows it — type a message to begin.`,
  pickerAlreadyBound: (threadId: string) => `That conversation is already followed in <#${threadId}>.`,
  pickerUnavailable: '⚠️ The conversation list is unavailable right now; try again later.',
  pickerNoWorkspaces: '⚠️ No workspaces are registered in this DSH instance.',
  pickerFailed: '⚠️ Could not attach that conversation; try again.',
  pickerPromptRejected: '⚠️ This thread now follows that conversation, but DSH rejected your first message — send it again in this thread.',
  turnFailed: (reason: string) => `⚠️ This turn failed: ${reason}`,
  pickerOpened: (threadId: string) => `💡 Opened the conversation picker in <#${threadId}>.`,
  pickerNeedsBoundChannel: '⚠️ /session pick must run in a server channel.',

  // ── approval / question cards ────────────────────────────────────────
  approvalRequired: (label: string) => `Approval required — ${label}`,
}

export type CopyTable = typeof en

/** Discord-visible copy (this fork ships English only). */
export function createCopy(): CopyTable {
  return en
}

/**
 * Pick the Discord notice for a Host `session/attachment-invalid` rejection.
 * Only `MODEL_DOES_NOT_SUPPORT_IMAGES` is a model-capability problem; every
 * other reason (INVALID_IMAGE, IMAGE_TOO_LARGE, IMAGE_TYPE_MISMATCH,
 * FILE_NOT_STAGED, …) is a file problem. Treating the whole error code as a
 * modality gate tells users to change a model setting that is already correct
 * (16.114 real-machine finding: a 1×1 PNG was rejected as an invalid image).
 * @returns the notice, or `undefined` when the failure is not an attachment
 * rejection and the caller should use its generic outcome copy.
 */
export function attachmentRejectionCopy(
  code: string | undefined,
  detail: string | undefined,
  copy: CopyTable,
): string | undefined {
  if (code !== 'session/attachment-invalid') return undefined
  return detail === 'MODEL_DOES_NOT_SUPPORT_IMAGES'
    ? copy.imageModalityRejected
    : copy.attachmentRejected
}

/**
 * Localize one permission-preset key for display. The dsh-base canonical
 * three map to Discord copy; deployment-custom keys fall back to the raw
 * host key (never invented labels).
 */
export function permissionPresetLabel(preset: string, copy: CopyTable): string {
  if (preset === 'read-only') return copy.permissionPresetReadOnly
  if (preset === 'workspace-write') return copy.permissionPresetWorkspaceWrite
  if (preset === 'danger-full-access') return copy.permissionPresetFullAccess
  return preset
}
