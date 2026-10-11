// sidekick: a bar above the prompt (TL;DR briefs from a turn ledger, heads-up,
// rule suggestions, edit replay, a context readout, a trim offer, a council
// button), a scope guard
// for multi-repo sessions, long-lived rules in Claude Code's own settings, a
// resume warning, and trimming in place of summary compaction.
// Settings come from plugin.json's userConfig (/plugin configure).
//
// Every function that touches `$` is declared at the top level of this file:
// the engine follows `$` only into functions declared in the hooks module
// itself, and a plugin has one hooks module. Everything else lives beside it
// as pure code: views/ draws from the surface's element table, plain data and
// callbacks; the other files hold the features' logic.
//
// The replay parts are adapted from Anthropic's replay-theater sample mod
// (Copyright 2026 Anthropic PBC, Apache-2.0; anthropics/claude-code-playground,
// claude-code/mods/replay-theater). Modified for sidekick: state lives in
// $.state so it survives a reload, an edit is recorded only once it
// succeeded, and the bar shows its stats.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput, RenderSurface, SessionMessage, StateRef } from 'claude-code'

import type { Bar, BarItemId, Brief, BriefRepo, ContextReadout, HeadsUpNote, PendingBrief, TrimOffer, Replay, ReplayStep, ResumeWarning, RuleSuggestion, Scope } from '../types'
import {
  BRIEF_SYSTEM_PROMPT,
  CONFIRM_ABOVE_CALLS,
  briefLabel,
  briefPrompt,
  briefSummaryText,
  chunkPrompt,
  claimsCheck,
  filesByRepo,
  handoffMarkdown,
  handoffStarterPrompt,
  parseBriefReply,
  planBrief,
  sessionHandoffMarkdown,
  spanStats,
  statLines,
  type SpanStats,
} from './brief'
import {
  FLUSH_EVERY,
  LEDGER_FOLDER,
  SEGMENT_ENTRIES,
  SPAN_WORDS,
  answerEntry,
  callEntry,
  expiredLedgers,
  isNewSay,
  parseSegment,
  promptEntry,
  responseText,
  safeSessionFolder,
  sayEntry,
  sayKey,
  segmentIndex,
  segmentName,
  serializeSegment,
  spanEntries,
  type BriefSpan,
  type LedgerEntry,
} from './ledger'
import { REVIEW_OUTCOME_TEXT, REVIEW_SYSTEM_PROMPT, buildReviewPrompt, parseReview, sameTopic, withTopic, type ReviewOutcome } from './long-answer'
import { isEditTool, stepsForEdit, textField } from './replay-steps'
import { resumeWarningFrom } from './resume-warning'
import { redactSecrets } from './secrets'
import {
  CLASSIFIER_SYSTEM_PROMPT,
  analyzeCommand,
  buildClassifierPrompt,
  checkFileEdit,
  denialMessage,
  describeScope,
  parseClassifierAnswer,
  relativeTo,
  scopeFolderCandidate,
  type GuardVerdict,
  type ScopeContext,
} from './scope-guard'
import {
  builtInEntries,
  describeRule,
  exclusiveConflict,
  isLongLivedRule,
  parseRule,
  parseSettingsText,
  ruleKey,
  ruleSpec,
  syncRules,
  type LongLivedRule,
  type PathRuleStyle,
} from './scope-rules'
import { readSettings, type SidekickSettings } from './settings'
import { planTrim, trimDecision, trimNotice } from './trim'
import { breakdownRows, emptyReadout, withMeasurement } from './context-readout'
import { councilGlimpse, orderFolderFor } from './council-glimpse'
import { modelFailureText, stringList, textKey } from './values'
import { barView } from './views/bar'
import { barModel, type BarHandlers, type BarState } from './views/bar-model'
import { MAX_VIEW_DIFF_LINES, replayView } from './views/replay'

const REPLAY_PANE_ID = 'sidekick-replay'
const KNOWN_TOPICS_STORE_KEY = 'knownTopics'
const SHOWN_TOPICS_STORE_KEY = 'shownTopics'
// The tools the scope guard polices (NotebookEdit is guarded but not
// replayed, so this differs from replay-steps' list on purpose).
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_BLOCKED_CALLS = 20
// Stored per-session scopes older than this are pruned at session start.
const SCOPE_RETENTION_MS = 30 * 24 * 3600 * 1000

const SCOPE_STORE_PREFIX = 'scope:'
const scopeStoreKey = (sessionId: string) => `${SCOPE_STORE_PREFIX}${sessionId}`
const rulesStoreKey = (root: string) => `rules:${root}`
const rulesDenyStoreKey = (root: string) => `rulesDeny:${root}`
const rulesStyleStoreKey = (root: string) => `rulesStyle:${root}`
const declinedRulesStoreKey = (root: string) => `declinedRules:${root}`

const replayAtom = atom({ plugin: 'sidekick', key: 'replay' } as const, {
  steps: [],
  index: 0,
  isSeen: true,
  isOpen: false,
  isInBand: false,
} as Replay)
const noteAtom = atom({ plugin: 'sidekick', key: 'note' } as const, null as HeadsUpNote | null)
const briefAtom = atom({ plugin: 'sidekick', key: 'brief' } as const, null as Brief | null)
const pendingBriefAtom = atom({ plugin: 'sidekick', key: 'pendingBrief' } as const, null as PendingBrief | null)
const scopeAtom = atom({ plugin: 'sidekick', key: 'scope' } as const, { folders: [] } as Scope)
const resumeAtom = atom({ plugin: 'sidekick', key: 'resumeWarning' } as const, null as ResumeWarning | null)
const ruleSuggestionAtom = atom({ plugin: 'sidekick', key: 'ruleSuggestion' } as const, null as RuleSuggestion | null)
const trimOfferAtom = atom({ plugin: 'sidekick', key: 'trimOffer' } as const, null as TrimOffer | null)
const contextAtom = atom({ plugin: 'sidekick', key: 'context' } as const, emptyReadout() as ContextReadout)
const hasCouncilAtom = atom({ plugin: 'sidekick', key: 'hasCouncil' } as const, false)
// The council mod's own state: any plugin may read another's (never write).
const councilStateRef = { plugin: 'council', key: 'council' } as const
const councilCourtRef = { plugin: 'council', key: 'court' } as const
// sidekick works without council, so it doesn't list council as a dependency
// and council's contract isn't in its types; $.state.get types only sidekick's
// own keys. Its refs are cast to one of those at the call (the engine needs the
// const ref itself there) and the values read as unknown, checked by shape.
type ForeignStateRef = StateRef<'sidekick', 'hasCouncil'>
const barAtom = atom({ plugin: 'sidekick', key: 'bar' } as const, { open: null, busy: [], notices: {}, blockedCalls: [] } as Bar)

// Module state: what only matters within one turn or one process. A reload
// starts it over (and drops the module's timers).
let settings: SidekickSettings = readSettings({})
let pendingSteps: ReplayStep[] = []
let lastUserPrompt = ''
// The files the last main turn edited, for the heads-up review.
let lastTurnChangedFiles: string[] = []
// The main loop's current turn: a review that finishes after the next turn
// began doesn't post a stale result.
let currentTurnId = ''
// Claude's words are recorded only while a main turn runs: a compaction
// outside one (/compact) re-appends the conversation as response rows.
let isMainTurnRunning = false
// The responses of the conversation the last compaction rebuilt, by sayKey:
// its re-appended rows aren't new words, even mid-turn (auto-compaction).
let compactedSays = new Set<string>()
let isReviewRunning = false
let isBriefRunning = false
let hasToastedClassifierPause = false
// The home folder, for the guard's `~` paths (undefined until read, '' if unknown).
let homeFolder: string | undefined
// Classifier answers by command, folder and scope, so a repeated unclear
// command costs one model call (rebuilt on reload).
const classifierCache = new Map<string, ClassifierResult>()
const MAX_CLASSIFIER_CACHE = 200
// Turns left to look for the council mod (it may register late; not forever).
let councilChecksLeft = 3
// The open ledger: its session folder, the segment being filled (its entries
// in memory), full segments not yet written, and entries since the last write.
type OpenLedger = { folder: string; segmentIndex: number; segment: LedgerEntry[]; fullSegments: Array<{ index: number; entries: LedgerEntry[] }>; unwritten: number }
let ledger: OpenLedger | undefined
// Entries recorded before the ledger opened (a hot reload mid-turn).
let earlyEntries: LedgerEntry[] = []
const MAX_EARLY_ENTRIES = 500
// Writes run one after another.
let ledgerWrites: Promise<void> = Promise.resolve()
let isLedgerFolderProtected = false
// Chunk summaries by chunk, so pressing again costs only the new part (rebuilt on reload).
const chunkSummaries = new Map<string, string>()
const MAX_CHUNK_SUMMARIES = 100

// ── The bar ───────────────────────────────────────────────────────────────

const updateBar = ($: EngineInterface, change: (bar: Bar) => Bar) => update($, barAtom, change)

const toggleBar = ($: EngineInterface, id: BarItemId) => updateBar($, bar => ({ ...bar, open: bar.open === id ? null : id }))

const openBar = ($: EngineInterface, id: BarItemId) => updateBar($, bar => ({ ...bar, open: id, notices: { ...bar.notices, [id]: undefined } }))

const closeBar = ($: EngineInterface) => updateBar($, bar => ({ ...bar, open: null }))

// Runs one item's work with the item marked busy, and a notice if it ends empty.
async function runBarTask($: EngineInterface, id: BarItemId, task: () => Promise<string | undefined>): Promise<void> {
  await updateBar($, bar => ({ ...bar, open: id, busy: [...new Set([...bar.busy, id])], notices: { ...bar.notices, [id]: undefined } }))
  let notice: string | undefined
  try {
    notice = await task()
  } catch {
    notice = 'Something went wrong; try again.'
  }
  await updateBar($, bar => ({ ...bar, busy: bar.busy.filter(busy => busy !== id), notices: { ...bar.notices, [id]: notice } }))
}

// ── Edit replay ───────────────────────────────────────────────────────────

async function recordableSteps($: EngineInterface, tool: string, input: Record<string, unknown>, cwd: string): Promise<ReplayStep[]> {
  let previousContents: string | undefined
  const filePath = textField(input.file_path)
  if (tool === 'Write' && filePath) {
    try {
      if (await $.fs.exists(filePath)) previousContents = await $.fs.read(filePath)
    } catch {
      // unreadable: shown as a new file
    }
  }
  return stepsForEdit(tool, input, cwd, previousContents)
}

async function openReplay($: EngineInterface): Promise<boolean> {
  const replay = await read($, replayAtom)
  if (replay.steps.length === 0) return false
  await update($, replayAtom, current => ({ ...current, index: 0, isSeen: true, isOpen: true, isInBand: false }))
  // The pane takes the keyboard only while nothing else holds it; let the
  // bar (which held the keys if its button was pressed) redraw first.
  await $.clock.sleep(200)
  const placed = await $.ui.open({ id: REPLAY_PANE_ID, title: 'Replay', focus: true, closeOnEscape: true, rows: MAX_VIEW_DIFF_LINES + 8 })
  // No room for a pane (a narrow terminal): draw the replay in the band.
  if (!placed.isPlaced) await update($, replayAtom, current => ({ ...current, isInBand: true }))
  return true
}

async function closeReplay($: EngineInterface): Promise<void> {
  const replay = await read($, replayAtom)
  if (!replay.isInBand) await $.ui.close({ id: REPLAY_PANE_ID })
  await update($, replayAtom, current => ({ ...current, isOpen: false, isInBand: false }))
}

// One step at a time, in the pane or (when no pane could be placed) the band.
async function drawReplay($: EngineInterface, e: RenderInput<'AbovePrompt' | 'Pane'>, isInBand: boolean) {
  const replay = await read($, replayAtom)
  const maxRows = 'maxRows' in e.props ? e.props.maxRows : 20
  return replayView($.ui.resolve(e), {
    replay,
    maxDiffLines: isInBand ? Math.max(3, Math.min(MAX_VIEW_DIFF_LINES, maxRows - 7)) : MAX_VIEW_DIFF_LINES,
    width: Math.max(40, ('bodyColumns' in e.props ? e.props.bodyColumns : 100) - 4),
    onGoTo: target => update($, replayAtom, current => ({ ...current, index: Math.max(0, Math.min(target, current.steps.length - 1)) })),
    onClose: () => closeReplay($),
  })
}

// ── Reviews: TL;DR, heads-up, rule suggestions ────────────────────────────

async function rememberTopic($: EngineInterface, storeKey: string, topic: string): Promise<void> {
  const topics = stringList(await $.store.get(storeKey))
  const updated = withTopic(topics, topic)
  if (updated !== topics) await $.store.set(storeKey, updated)
}

type ReviewInput = {
  userPrompt: string
  answer: string
  changedFiles: string[]
  turnId?: string
  wantsSummary: boolean
  wantsHeadsUp: boolean
  wantsRule: boolean
  blockedCalls: string[]
}

async function runReview($: EngineInterface, input: ReviewInput): Promise<ReviewOutcome> {
  const wantsSummary = input.wantsSummary && settings.isSummaryEnabled
  const wantsHeadsUp = input.wantsHeadsUp && settings.isHeadsUpEnabled
  const wantsRule = input.wantsRule && settings.isRuleSuggestionsEnabled
  if (!wantsSummary && !wantsHeadsUp && !wantsRule) return 'nothing'

  const [knownTopics, shownTopics] = await Promise.all([$.store.get(KNOWN_TOPICS_STORE_KEY), $.store.get(SHOWN_TOPICS_STORE_KEY)]).then(lists => lists.map(stringList))
  const root = await $.session.root()
  const [rules, declined, topLevelFolders] = wantsRule
    ? await Promise.all([readRules($, root), readDeclinedRules($, root), topLevelFolderNames($, root)])
    : [[], [], []]
  const reply = await $.model.complete({
    model: settings.model,
    system: REVIEW_SYSTEM_PROMPT,
    prompt: buildReviewPrompt(settings, {
      userPrompt: input.userPrompt,
      answer: input.answer,
      changedFiles: input.changedFiles,
      knownTopics: knownTopics!,
      shownTopics: shownTopics!,
      wantsSummary,
      wantsHeadsUp,
      wantsRule,
      blockedCalls: input.blockedCalls,
      topLevelFolders,
      existingRules: rules.map(rule => ruleSpec(rule, root)),
      declinedRules: declined,
    }),
    maxTokens: 450,
    timeoutMs: 45000,
  })
  if (!reply.isAnswered) return 'failed'
  const review = parseReview(reply.text)
  const isStillCurrent = input.turnId === undefined || input.turnId === currentTurnId
  if (wantsSummary && review.summary && isStillCurrent) await update($, briefAtom, () => lineBrief(review.summary!))
  if (wantsRule && review.rule) await offerRule($, root, review.rule.spec, review.rule.reason, rules, declined)
  const note = wantsHeadsUp ? review.note : null
  if (note === null) return 'nothing'
  if ([...knownTopics!, ...shownTopics!].some(topic => sameTopic(topic, note.headline))) return 'duplicate'
  await rememberTopic($, SHOWN_TOPICS_STORE_KEY, note.headline)
  await update($, noteAtom, () => note)
  return 'shown'
}

// Keeps at most one review in flight.
async function startReview($: EngineInterface, input: ReviewInput): Promise<ReviewOutcome | 'busy'> {
  if (isReviewRunning) return 'busy'
  isReviewRunning = true
  try {
    return await runReview($, input)
  } catch {
    return 'failed'
  } finally {
    isReviewRunning = false
  }
}

// The last exchange in the transcript, for the on-demand reviews.
async function lastExchange($: EngineInterface): Promise<{ userPrompt: string; answer: string } | undefined> {
  const messages = await $.session.messages()
  const answerIndex = messages.findLastIndex(message => message.role === 'assistant' && message.text.trim() !== '')
  if (answerIndex === -1) return undefined
  const prompt = messages.slice(0, answerIndex).findLast(message => message.role === 'user' && message.text.trim() !== '')
  return { userPrompt: prompt?.text ?? '', answer: messages[answerIndex]!.text }
}

const onDemand = (exchange: { userPrompt: string; answer: string }, wants: Pick<ReviewInput, 'wantsSummary' | 'wantsHeadsUp' | 'wantsRule'>, blockedCalls: string[] = []): ReviewInput => ({
  ...exchange,
  changedFiles: [],
  blockedCalls,
  ...wants,
})

const clearNote = ($: EngineInterface) => update($, noteAtom, () => null)

// TL;DR: a brief of the span, made when asked. The bar's button briefs the
// last turn (and reopens a brief already made); /tldr names a span.
async function pressSummary($: EngineInterface, span: BriefSpan = 'last', isFresh = false): Promise<void> {
  if (!isFresh && (await read($, briefAtom)) !== null) return void (await toggleBar($, 'tldr'))
  await runBarTask($, 'tldr', () => makeBrief($, span, false))
}

// The one-sentence TL;DR of a short tool-less turn: the old review's summary.
const lineBrief = (line: string): Brief => ({
  span: 'last',
  label: 'last turn',
  line,
  done: null,
  stuck: null,
  needsYou: null,
  findings: [],
  phases: [],
  stats: [],
  repos: [],
  skippedNote: null,
  isExpanded: false,
})

async function summarizeLastAnswer($: EngineInterface, exchange: { userPrompt: string; answer: string } | undefined): Promise<string | undefined> {
  const answered = exchange ?? (await lastExchange($))
  if (answered === undefined) return 'No answer to summarize yet.'
  // Tied to the current turn: a summary that lands after the next prompt is dropped.
  const outcome = await startReview($, { ...onDemand(answered, { wantsSummary: true, wantsHeadsUp: false, wantsRule: false }), turnId: currentTurnId })
  if (outcome === 'busy') return 'A review is already running; try again in a moment.'
  return (await read($, briefAtom))?.line ? undefined : 'Could not summarize the last answer.'
}

// Heads-up: a review on request; the note stays until dismissed.
async function pressHeadsUp($: EngineInterface): Promise<void> {
  const note = await read($, noteAtom)
  if (note !== null) return void (await toggleBar($, 'headsUp'))
  await runBarTask($, 'headsUp', async () => {
    const exchange = await lastExchange($)
    if (exchange === undefined) return 'No answer to review yet.'
    const outcome = await startReview($, { ...onDemand(exchange, { wantsSummary: false, wantsHeadsUp: true, wantsRule: false }), changedFiles: lastTurnChangedFiles })
    if (outcome === 'shown') return undefined
    return outcome === 'busy' ? 'A review is already running; try again in a moment.' : REVIEW_OUTCOME_TEXT[outcome]
  })
}

// Rule?: appears after the guard blocks something; suggests on request.
async function pressRule($: EngineInterface): Promise<void> {
  if ((await read($, ruleSuggestionAtom)) !== null) return void (await toggleBar($, 'rule'))
  await runBarTask($, 'rule', async () => {
    const { blockedCalls } = await read($, barAtom)
    const exchange = (await lastExchange($)) ?? { userPrompt: '', answer: '' }
    const outcome = await startReview($, onDemand(exchange, { wantsSummary: false, wantsHeadsUp: false, wantsRule: true }, blockedCalls))
    if (outcome === 'busy') return 'A review is already running; try again in a moment.'
    return (await read($, ruleSuggestionAtom)) === null ? 'No rule worth adding for these blocks.' : undefined
  })
}

async function clearRuleEvidence($: EngineInterface): Promise<void> {
  await update($, ruleSuggestionAtom, () => null)
  await updateBar($, bar => ({ ...bar, open: bar.open === 'rule' ? null : bar.open, blockedCalls: [], notices: { ...bar.notices, rule: undefined } }))
}

// ── The turn ledger ───────────────────────────────────────────────────────

// Opens this session's ledger: continues its newest segment, takes in what
// was recorded before it opened, and deletes ledgers past their retention.
async function openLedger($: EngineInterface): Promise<void> {
  ledger = undefined
  const home = await readHome($)
  if (!home) return
  const base = `${home}/${LEDGER_FOLDER}`
  const sessionFolder = safeSessionFolder(await $.session.id())
  const folder = `${base}/${sessionFolder}`
  const indexes = (await $.fs.list(folder).catch(() => []))
    .filter(entry => entry.kind === 'file')
    .map(entry => segmentIndex(entry.name))
    .filter((index): index is number => index !== undefined)
  const newest = indexes.length > 0 ? Math.max(...indexes) : 0
  const segment = indexes.length > 0 ? parseSegment(await $.fs.read(`${folder}/${segmentName(newest)}`).catch(() => '')) : []
  ledger = segment.length >= SEGMENT_ENTRIES ? { folder, segmentIndex: newest + 1, segment: [], fullSegments: [], unwritten: 0 } : { folder, segmentIndex: newest, segment, fullSegments: [], unwritten: 0 }
  const early = earlyEntries
  earlyEntries = []
  for (const entry of early) recordEntry($, entry)
  void pruneLedgers($, base, sessionFolder, await $.clock.now()).catch(() => undefined)
}

async function pruneLedgers($: EngineInterface, base: string, current: string, now: number): Promise<void> {
  const folders = []
  for (const entry of await $.fs.list(base).catch(() => [])) {
    if (entry.kind !== 'dir') continue
    const files = await $.fs.list(`${base}/${entry.name}`).catch(() => [])
    folders.push({ name: entry.name, newestMs: Math.max(0, ...files.map(file => file.mtimeMs)) })
  }
  for (const name of expiredLedgers(folders, current, now)) await $.process.run(['rm', '-rf', '--', `${base}/${name}`], { timeoutMs: 5000 })
}

// The time for a ledger entry: recording must never fail the hook it's in.
const ledgerNow = ($: EngineInterface) => $.clock.now().catch(() => 0)

// Adds an entry in memory; a full segment rolls over, and every few entries
// (and each turn's end) are written.
function recordEntry($: EngineInterface, entry: LedgerEntry): void {
  if (ledger === undefined) {
    if (earlyEntries.length < MAX_EARLY_ENTRIES) earlyEntries.push(entry)
    return
  }
  ledger.segment.push(entry)
  ledger.unwritten++
  if (ledger.segment.length >= SEGMENT_ENTRIES) {
    ledger.fullSegments.push({ index: ledger.segmentIndex, entries: ledger.segment })
    ledger.segmentIndex++
    ledger.segment = []
  }
  if (ledger.unwritten >= FLUSH_EVERY) void flushLedger($)
}

function flushLedger($: EngineInterface): Promise<void> {
  ledgerWrites = ledgerWrites.then(() => writeLedger($)).catch(() => undefined)
  return ledgerWrites
}

async function writeLedger($: EngineInterface): Promise<void> {
  const open = ledger
  if (open === undefined || (open.unwritten === 0 && open.fullSegments.length === 0)) return
  const full = open.fullSegments.splice(0)
  const count = open.unwritten
  open.unwritten = 0
  try {
    for (const segment of full) await $.fs.write(`${open.folder}/${segmentName(segment.index)}`, serializeSegment(segment.entries))
    await $.fs.write(`${open.folder}/${segmentName(open.segmentIndex)}`, serializeSegment(open.segment))
  } catch {
    // Kept for the next write.
    open.fullSegments.unshift(...full)
    open.unwritten += count
    return
  }
  // The ledger holds commands and Claude's words: only the user may read it.
  if (!isLedgerFolderProtected) {
    isLedgerFolderProtected = true
    const base = open.folder.slice(0, open.folder.lastIndexOf('/'))
    await $.process.run(['chmod', '700', base.slice(0, base.lastIndexOf('/')), base, open.folder], { timeoutMs: 3000 }).catch(() => undefined)
  }
}

// The ledger's entries from the newest segment back, until `isStart` finds
// one (all of them when it never does), oldest first.
async function readLedgerBack($: EngineInterface, isStart: (entry: LedgerEntry) => boolean): Promise<LedgerEntry[]> {
  if (ledger === undefined) return [...earlyEntries]
  const open = ledger
  const pending = new Map(open.fullSegments.map(segment => [segment.index, segment.entries]))
  const onDisk = (await $.fs.list(open.folder).catch(() => []))
    .map(entry => segmentIndex(entry.name))
    .filter((index): index is number => index !== undefined && index < open.segmentIndex)
  const indexes = [...new Set([...onDisk, ...pending.keys()])].sort((left, right) => right - left)
  let entries = [...open.segment]
  for (const index of indexes) {
    if (entries.some(isStart)) break
    entries = [...(pending.get(index) ?? parseSegment(await $.fs.read(`${open.folder}/${segmentName(index)}`).catch(() => ''))), ...entries]
  }
  return entries
}

const spanStart = (span: BriefSpan) => (entry: LedgerEntry) => (span === 'last' ? entry.kind === 'prompt' : span === 'since' && entry.kind === 'brief')

// ── TL;DR briefs ──────────────────────────────────────────────────────────

// Makes the brief of a span, or leaves it pending when it needs more calls
// than the confirm threshold. Returns a notice when there's nothing to show.
async function makeBrief($: EngineInterface, span: BriefSpan, isConfirmed: boolean, isForHandoff = false): Promise<string | undefined> {
  if (isBriefRunning || isReviewRunning) return 'A TL;DR is already running; try again in a moment.'
  const entries = spanEntries(await readLedgerBack($, spanStart(span)), span)
  if (entries.length === 0) {
    if (span === 'last') return summarizeLastAnswer($, undefined)
    return 'Nothing recorded yet: the record starts with sidekick 0.14.'
  }
  const plan = planBrief(entries)
  if (plan.isTrivial) {
    const prompt = entries.findLast(entry => entry.kind === 'prompt')
    const answer = entries.findLast(entry => entry.kind === 'answer')
    return summarizeLastAnswer($, answer === undefined ? undefined : { userPrompt: prompt?.kind === 'prompt' ? prompt.text : '', answer: answer.kind === 'answer' ? answer.text : '' })
  }
  if (plan.calls > CONFIRM_ABOVE_CALLS && !isConfirmed) {
    await update($, pendingBriefAtom, () => ({ span, calls: plan.calls, characters: plan.chunks.reduce((sum, chunk) => sum + chunk.length, 0), isForHandoff }))
    return undefined
  }
  isBriefRunning = true
  const turnAtStart = currentTurnId
  try {
    await update($, pendingBriefAtom, () => null)
    const stats = spanStats(entries)
    const findings = claimsCheck(stats)
    const figures = statLines(stats)
    const partSummaries = plan.chunks.length > 1 ? await summarizeChunks($, plan.chunks) : undefined
    if (partSummaries !== undefined && 'failure' in partSummaries) return `The TL;DR failed: a part of the log could not be condensed (${partSummaries.failure}).`
    const reply = await $.model.complete({
      model: settings.model,
      system: BRIEF_SYSTEM_PROMPT,
      prompt: briefPrompt({ span, stats: figures, findings, ...(partSummaries ? { partSummaries: partSummaries.summaries } : { log: plan.chunks[0] ?? '' }), answer: stats.answer?.text ?? null }),
      maxTokens: 600,
      timeoutMs: 60000,
    })
    if (!reply.isAnswered) return `The TL;DR failed (${modelFailureText(reply)}).`
    if (span === 'last' && currentTurnId !== turnAtStart) return undefined
    const brief: Brief = {
      span,
      label: briefLabel(span, stats),
      line: null,
      ...parseBriefReply(reply.text),
      findings,
      stats: figures,
      repos: await repoFacts($, stats).catch(() => []),
      skippedNote: plan.skippedNote,
      isExpanded: false,
    }
    await update($, briefAtom, () => brief)
    recordEntry($, { kind: 'brief', at: await $.clock.now() })
    return undefined
  } finally {
    isBriefRunning = false
  }
}

// One call per chunk (three at a time, cached by chunk); why one failed when
// one did.
async function summarizeChunks($: EngineInterface, chunks: readonly string[]): Promise<{ summaries: string[] } | { failure: string }> {
  const summaries: Array<string | null> = chunks.map(chunk => chunkSummaries.get(textKey(chunk)) ?? null)
  const missing = chunks.map((_, index) => index).filter(index => summaries[index] === null)
  const failures: string[] = []
  for (let start = 0; start < missing.length; start += 3) {
    await Promise.all(
      missing.slice(start, start + 3).map(async index => {
        const reply = await $.model.complete({ model: settings.model, system: BRIEF_SYSTEM_PROMPT, prompt: chunkPrompt(chunks[index]!, index, chunks.length), maxTokens: 350, timeoutMs: 60000 })
        if (!reply.isAnswered) return void failures.push(modelFailureText(reply))
        summaries[index] = reply.text.trim()
        if (chunkSummaries.size >= MAX_CHUNK_SUMMARIES) chunkSummaries.delete(chunkSummaries.keys().next().value!)
        chunkSummaries.set(textKey(chunks[index]!), reply.text.trim())
      }),
    )
  }
  if (failures.length > 0) return { failure: failures[0]! }
  return summaries.every((summary): summary is string => summary !== null) ? { summaries } : { failure: 'a part came back empty' }
}

async function git($: EngineInterface, folder: string, args: string[]): Promise<string | undefined> {
  const result = await $.process.run(['git', '-C', folder, ...args], { timeoutMs: 5000 }).catch(() => undefined)
  return result?.exitCode === 0 ? result.stdout.trim() : undefined
}

// The repos the span changed files in, with their state now: the span's
// commits, uncommitted and unpushed counts. Files are grouped by the folder
// under the session root they sit in, resolved to its repo once.
async function repoFacts($: EngineInterface, stats: SpanStats): Promise<BriefRepo[]> {
  const root = await $.session.root()
  const groupFolder = (path: string) => (path.startsWith(`${root}/`) ? `${root}/${path.slice(root.length + 1).split('/')[0]}` : path.slice(0, path.lastIndexOf('/')))
  const tops = new Map<string, string | undefined>()
  for (const folder of new Set(stats.files.map(file => groupFolder(file.path)))) {
    const isFolder = (await $.fs.stat(folder).catch(() => undefined))?.kind === 'dir'
    tops.set(folder, await git($, isFolder ? folder : folder.slice(0, folder.lastIndexOf('/')), ['rev-parse', '--show-toplevel']))
  }
  const since = new Date(stats.startAt).toISOString()
  const repos: BriefRepo[] = []
  for (const [folder, files] of [...filesByRepo(stats.files, path => tops.get(groupFolder(path)))].slice(0, 12)) {
    const [status, unpushed, log] = await Promise.all([
      git($, folder, ['status', '--porcelain']),
      git($, folder, ['rev-list', '--count', '@{u}..HEAD']),
      git($, folder, ['log', `--since=${since}`, '--format=%h %s', '-n', '20']),
    ])
    repos.push({
      folder,
      name: folder.slice(folder.lastIndexOf('/') + 1),
      files: files.map(file => ({ ...file, path: file.path.startsWith(`${folder}/`) ? file.path.slice(folder.length + 1) : file.path })),
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
      commits: log ? log.split('\n').filter(Boolean) : [],
      uncommitted: status === undefined ? null : status.split('\n').filter(Boolean).length,
      unpushed: unpushed === undefined ? null : Number(unpushed),
    })
  }
  return repos
}

// HANDOFF.md in each repo the brief covers: written, never committed.
async function writeRepoHandoffs($: EngineInterface): Promise<void> {
  const brief = await read($, briefAtom)
  if (brief === null || brief.repos.length === 0) return void $.ui.toast('No repo changed in this span: no handoff to write.')
  const writtenAt = new Date(await $.clock.now()).toISOString()
  const written: string[] = []
  for (const repo of brief.repos) {
    await $.fs
      .write(`${repo.folder}/HANDOFF.md`, handoffMarkdown(brief, repo, writtenAt))
      .then(() => written.push(repo.name))
      .catch(() => undefined)
  }
  $.ui.toast(written.length > 0 ? `Wrote HANDOFF.md in ${written.join(', ')} (not committed).` : 'Could not write HANDOFF.md.')
}

// One tool call into the ledger, with its outcome (a denial is an error).
async function recordCall(
  $: EngineInterface,
  call: { tool: string; input: Record<string, unknown>; agentId: string | undefined; startedAt: number | undefined; steps: readonly ReplayStep[]; result: { deny?: string; isError?: boolean; result?: unknown; text?: string } },
): Promise<void> {
  const at = await ledgerNow($)
  const isError = call.result.deny !== undefined || call.result.isError === true
  const editedPath = textField(call.input.file_path) ?? textField(call.input.notebook_path)
  const editedFile =
    isEditTool(call.tool) && editedPath !== undefined
      ? { path: editedPath, added: call.steps.reduce((sum, step) => sum + step.addedCount, 0), removed: call.steps.reduce((sum, step) => sum + step.removedCount, 0) }
      : undefined
  recordEntry(
    $,
    callEntry({
      tool: call.tool,
      input: call.input,
      at,
      durationMs: call.startedAt === undefined ? 0 : Math.max(0, at - call.startedAt),
      isError,
      ...(call.agentId !== undefined ? { agentId: call.agentId } : {}),
      ...(editedFile ? { editedFile } : {}),
      result: call.result.result,
      ...(typeof call.result.text === 'string' ? { resultText: call.result.text } : {}),
    }),
  )
}

async function runPendingBrief($: EngineInterface, surface: RenderSurface): Promise<void> {
  const pending = await read($, pendingBriefAtom)
  if (pending === null) return
  await runBarTask($, 'tldr', async () => {
    const notice = await makeBrief($, pending.span, true)
    return notice === undefined && pending.isForHandoff ? writeSessionHandoff($, surface) : notice
  })
}

// ── The session handoff ───────────────────────────────────────────────────

// For moving to a new session: briefs the whole session (waiting for a
// go-ahead when that's long), writes HANDOFF.md beside the session's record
// and copies a first prompt for the new session that points at it.
async function pressHandoff($: EngineInterface, surface: RenderSurface): Promise<void> {
  await runBarTask($, 'tldr', async () => {
    const notice = await makeBrief($, 'full', false, true)
    if (notice !== undefined || (await read($, pendingBriefAtom)) !== null) return notice
    return writeSessionHandoff($, surface)
  })
}

// Returns the notice the TL;DR card shows: where the file is and whether the
// first prompt reached the clipboard.
async function writeSessionHandoff($: EngineInterface, surface: RenderSurface): Promise<string> {
  const [brief, warning] = await Promise.all([read($, briefAtom), read($, resumeAtom)])
  if (brief === null || ledger === undefined) return 'No handoff: the session has no record to hand off.'
  const recordFolder = ledger.folder
  await flushLedger($)
  const heldPrompt = warning?.heldPrompt ?? null
  const path = `${recordFolder}/HANDOFF.md`
  const markdown = sessionHandoffMarkdown({
    brief,
    root: await $.session.root(),
    sessionId: await $.session.id(),
    recordFolder,
    heldPrompt: heldPrompt === null ? null : redactSecrets(heldPrompt),
    writtenAt: new Date(await $.clock.now()).toISOString(),
  })
  const isWritten = await $.fs.write(path, markdown).then(() => true, () => false)
  if (!isWritten) return `Could not write ${path}.`
  const copy = await $.ui.copy({ text: handoffStarterPrompt(path, heldPrompt), surface }).catch(() => undefined)
  return copy?.isCopied === true
    ? `Handoff written to ${path}. Its first prompt is copied: paste it into a new session.`
    : `Handoff written to ${path}. Copying failed: start a new session with "Read ${path} first."`
}

// ── Scope guard ───────────────────────────────────────────────────────────

// The home folder ('' when it can't be read), read once per process.
async function readHome($: EngineInterface): Promise<string> {
  if (homeFolder === undefined) {
    const result = await $.process.run(['printenv', 'HOME'], { timeoutMs: 3000 }).catch(() => undefined)
    homeFolder = result?.exitCode === 0 ? result.stdout.trim() : ''
  }
  return homeFolder
}

async function scopeContext($: EngineInterface): Promise<ScopeContext> {
  const [root, cwd, scope, home] = await Promise.all([$.session.root(), $.session.cwd(), read($, scopeAtom), readHome($)])
  return { root, cwd, folders: scope.folders, ...(home ? { home } : {}) }
}

function showScopeStatus($: EngineInterface, scope: Scope, root: string): void {
  $.ui.status(settings.isScopeGuardEnabled && scope.folders.length > 0 ? `scope: ${describeScope({ root, folders: scope.folders })}` : undefined)
}

async function saveScope($: EngineInterface, scope: Scope, root: string): Promise<void> {
  await update($, scopeAtom, () => scope)
  await $.store.set(scopeStoreKey(await $.session.id()), { ...scope, savedAt: await $.clock.now() })
  showScopeStatus($, scope, root)
}

// Restores this session's scope, and prunes scopes stored by sessions long gone.
async function restoreScope($: EngineInterface, root: string): Promise<void> {
  const [sessionId, now, keys] = await Promise.all([$.session.id(), $.clock.now(), $.store.keys()])
  for (const key of keys.filter(key => key.startsWith(SCOPE_STORE_PREFIX) && key !== scopeStoreKey(sessionId))) {
    const savedAt = ((await $.store.get(key)) as { savedAt?: unknown } | undefined)?.savedAt
    if (typeof savedAt !== 'number' || now - savedAt > SCOPE_RETENTION_MS) await $.store.delete(key)
  }
  const stored = (await $.store.get(scopeStoreKey(sessionId))) as (Partial<Scope> & { isInferred?: unknown }) | undefined
  // Scopes earlier versions inferred from a first edit are dropped, not restored
  // as if the user had set them.
  if (!stored || !Array.isArray(stored.folders) || stored.isInferred === true) return
  const scope: Scope = { folders: stringList(stored.folders) }
  await update($, scopeAtom, () => scope)
  showScopeStatus($, scope, root)
}

type ClassifierResult = { kind: 'allow' } | { kind: 'block'; reason: string } | { kind: 'skipped'; why: 'off' | 'built-in' | 'usage-cap' | 'failed' }

// Asks the model only when nothing built in will look at the command anyway.
async function classifyCommand($: EngineInterface, command: string, context: ScopeContext): Promise<ClassifierResult> {
  if (!settings.isScopeClassifierEnabled) return { kind: 'skipped', why: 'off' }
  try {
    // 'ask' goes to the mode's decider (the dialog or the auto-mode
    // classifier, which reads the rules); 'deny' is refused anyway.
    const check = await $.tool.check({ tool: 'Bash', input: { command } })
    if (check.decision !== 'allow') return { kind: 'skipped', why: 'built-in' }
  } catch {
    // no answer: fall through to the model
  }
  try {
    const usage = await $.session.usage()
    const fiveHour = usage.rateLimits.find(limit => limit.kind === 'five_hour')
    if (fiveHour !== undefined && fiveHour.percentUsed >= settings.classifierUsageCap) {
      if (!hasToastedClassifierPause) $.ui.toast(`Scope classifier paused: 5-hour usage is at ${fiveHour.percentUsed}%.`)
      hasToastedClassifierPause = true
      return { kind: 'skipped', why: 'usage-cap' }
    }
  } catch {
    // no usage figures (an API key, not a subscription): carry on
  }
  const cacheKey = JSON.stringify([command, context.cwd, context.folders])
  const cached = classifierCache.get(cacheKey)
  if (cached !== undefined) return cached
  // 4 s: the whole tool.call hook has a 10 s budget.
  const reply = await $.model.complete({ model: settings.model, system: CLASSIFIER_SYSTEM_PROMPT, prompt: buildClassifierPrompt(command.slice(0, 2000), context), maxTokens: 60, timeoutMs: 4000 })
  if (!reply.isAnswered) return { kind: 'skipped', why: 'failed' }
  const result: ClassifierResult = parseClassifierAnswer(reply.text) ?? { kind: 'skipped', why: 'failed' }
  if (result.kind !== 'skipped') {
    if (classifierCache.size >= MAX_CLASSIFIER_CACHE) classifierCache.delete(classifierCache.keys().next().value!)
    classifierCache.set(cacheKey, result)
  }
  return result
}

// The folder of the council order a subagent carries, if it carries one
// (read from the council mod's state; see council-glimpse.ts).
async function councilOrderFolder($: EngineInterface, agentId: string): Promise<string | undefined> {
  if (!(await read($, hasCouncilAtom))) return undefined
  const { value } = await $.state.get(councilCourtRef as unknown as ForeignStateRef)
  return orderFolderFor(value as unknown, agentId)
}

// Returns the denial Claude reads, or undefined to let the call run. Called
// only for the tools it polices, with the context already read. With no scope
// set (only /scope set or add, or a council order, sets one) nothing is blocked.
async function guardToolCall($: EngineInterface, tool: string, input: Record<string, unknown>, context: ScopeContext): Promise<string | undefined> {
  let verdict: GuardVerdict = { kind: 'allow' }
  const isFileEdit = FILE_TOOLS.has(tool)

  if (isFileEdit) {
    const filePath = textField(input.file_path) ?? textField(input.notebook_path)
    if (!filePath || context.folders.length === 0) return undefined
    verdict = checkFileEdit(filePath, context)
  } else {
    const command = textField(input.command)
    if (!command) return undefined
    verdict = analyzeCommand(command, context)
    if (verdict.kind === 'unclear') {
      const judged = await classifyCommand($, command, context)
      if (judged.kind === 'block') verdict = { kind: 'block', target: context.cwd, reason: `${judged.reason} (scope classifier)` }
      // The classifier was asked and gave no answer: fail closed, as the guard
      // does on errors. (Turned off, or paused at the usage cap, it's the
      // user's choice to let unclear commands through.)
      else if (judged.kind === 'skipped' && judged.why === 'failed') {
        verdict = { kind: 'block', target: context.cwd, reason: `${verdict.reason}, and the scope classifier could not judge it` }
      }
    }
  }

  if (verdict.kind !== 'block') return undefined
  const blocked = `${tool}: ${relativeTo(context.root, verdict.target)}`
  if (settings.isRuleSuggestionsEnabled) {
    await updateBar($, bar => ({ ...bar, blockedCalls: [...bar.blockedCalls, blocked].slice(-MAX_BLOCKED_CALLS) }))
  }
  $.ui.toast(`Scope guard blocked ${tool}: ${relativeTo(context.root, verdict.target)} is outside ${describeScope(context)}.`)
  return denialMessage(verdict, context, isFileEdit ? 'edit' : 'command')
}

// ── Long-lived rules in Claude Code's own settings ────────────────────────

const settingsLocalPath = (root: string) => `${root}/.claude/settings.local.json`

async function readRules($: EngineInterface, root: string): Promise<LongLivedRule[]> {
  const stored = await $.store.get(rulesStoreKey(root))
  return Array.isArray(stored) ? stored.filter(isLongLivedRule) : []
}

const readDeclinedRules = async ($: EngineInterface, root: string) => stringList(await $.store.get(declinedRulesStoreKey(root)))

async function storedStyle($: EngineInterface, root: string): Promise<PathRuleStyle> {
  return (await $.store.get(rulesStyleStoreKey(root))) === 'project-relative' ? 'project-relative' : 'absolute'
}

// Throws when the file exists but isn't JSON, so a rule is never stored
// without being written.
async function readLocalSettings($: EngineInterface, root: string): Promise<{ exists: boolean; settings: Record<string, unknown> }> {
  const path = settingsLocalPath(root)
  const exists = await $.fs.exists(path)
  return { exists, settings: parseSettingsText(exists ? await $.fs.read(path) : undefined) }
}

async function topLevelFolderNames($: EngineInterface, root: string): Promise<string[]> {
  const entries = await $.fs.list(root).catch(() => [])
  return entries.filter(entry => entry.kind === 'dir' && !entry.name.startsWith('.')).map(entry => entry.name)
}

// True once the engine's own permission check denies an edit there.
async function isDenyActive($: EngineInterface, folder: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await $.clock.sleep(400)
    try {
      const check = await $.tool.check({ tool: 'Edit', input: { file_path: `${folder}/.sidekick-rule-probe`, old_string: 'a', new_string: 'b' } })
      if (check.decision === 'deny') return true
    } catch {
      // try again
    }
  }
  return false
}

// Writes the rules into settings.local.json in one path spelling, replacing
// whatever sidekick wrote before; leaves the file alone when nothing changes.
async function writeRules($: EngineInterface, root: string, rules: readonly LongLivedRule[], style: PathRuleStyle): Promise<void> {
  const { exists, settings: current } = await readLocalSettings($, root)
  const previousDeny = stringList(await $.store.get(rulesDenyStoreKey(root)))
  const entries = builtInEntries(rules, root, style)
  const next = syncRules(current, previousDeny, entries)
  if (JSON.stringify(next) !== JSON.stringify(current) && (exists || Object.keys(next).length > 0)) {
    await $.fs.write(settingsLocalPath(root), `${JSON.stringify(next, null, 2)}\n`)
  }
  await $.store.set(rulesDenyStoreKey(root), entries.deny)
  await $.store.set(rulesStyleStoreKey(root), style)
}

// After a change: write, then confirm with Claude Code's own permission check
// that a fence is enforced, trying the other path spelling if it isn't.
async function applyRules($: EngineInterface, root: string): Promise<string> {
  const rules = await readRules($, root)
  const fence = rules.find((rule): rule is Extract<LongLivedRule, { kind: 'fence' }> => rule.kind === 'fence')
  const preferred = await storedStyle($, root)
  const styles: PathRuleStyle[] = preferred === 'absolute' ? ['absolute', 'project-relative'] : ['project-relative', 'absolute']
  for (const style of styles) {
    await writeRules($, root, rules, style)
    if (fence === undefined) return 'Saved to .claude/settings.local.json.'
    if (await isDenyActive($, fence.folder)) return 'Saved to .claude/settings.local.json; Claude Code confirmed the fence is enforced.'
  }
  return 'Saved to .claude/settings.local.json, but Claude Code has not reported the fence as enforced yet (settings may reload later).'
}

async function addRule($: EngineInterface, root: string, rule: LongLivedRule): Promise<string> {
  const rules = await readRules($, root)
  if (rules.some(existing => ruleKey(existing) === ruleKey(rule))) return `Already a rule: ${describeRule(rule, root)}.`
  try {
    await readLocalSettings($, root)
  } catch (error) {
    return `Not added: .claude/settings.local.json could not be read (${error instanceof Error ? error.message : String(error)}). Fix it, then add the rule again.`
  }
  await $.store.set(rulesStoreKey(root), [...rules, rule])
  return `Rule added: ${describeRule(rule, root)}. ${await applyRules($, root)}`
}

// A suggestion from the review becomes the Rule? panel, unless it's known,
// declined, malformed, or names a folder that doesn't exist.
async function offerRule($: EngineInterface, root: string, spec: string, reason: string, rules: readonly LongLivedRule[], declined: readonly string[]): Promise<void> {
  const rule = parseRule(spec, root)
  if (rule === undefined) return
  const key = ruleKey(rule)
  if (rules.some(existing => ruleKey(existing) === key) || declined.includes(key)) return
  for (const folder of rule.kind === 'fence' ? [rule.folder] : rule.folders) {
    if ((await $.fs.list(folder).catch(() => undefined)) === undefined) return
  }
  await update($, ruleSuggestionAtom, () => ({ spec: ruleSpec(rule, root), key, description: describeRule(rule, root), reason }))
}

async function acceptSuggestedRule($: EngineInterface, suggestion: RuleSuggestion): Promise<void> {
  const root = await $.session.root()
  const rule = parseRule(suggestion.spec, root)
  await clearRuleEvidence($)
  if (rule !== undefined) $.ui.toast(await addRule($, root, rule).catch(error => `Not added: ${error instanceof Error ? error.message : String(error)}`))
}

async function declineSuggestedRule($: EngineInterface, suggestion: RuleSuggestion): Promise<void> {
  const root = await $.session.root()
  await $.store.set(declinedRulesStoreKey(root), [...new Set([...(await readDeclinedRules($, root)), suggestion.key])])
  await clearRuleEvidence($)
}

async function rulesCommand($: EngineInterface, args: string): Promise<string> {
  const [action = 'list', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const root = await $.session.root()
  const rules = await readRules($, root)
  switch (action) {
    case 'list':
      return rules.length === 0
        ? 'No long-lived rules. The bar offers one after the scope guard blocks something; /rules add fence <folder> or /rules add exclusive <a> <b> adds one.'
        : `Rules (in .claude/settings.local.json):\n${rules.map((rule, index) => `${index + 1}. ${describeRule(rule, root)}`).join('\n')}`
    case 'add': {
      const rule = parseRule(rest.join(' '), root)
      return rule === undefined ? 'Usage: /rules add fence <folder> | /rules add exclusive <folder> <folder>' : addRule($, root, rule)
    }
    case 'remove': {
      const index = Number(rest[0]) - 1
      const removed = rules[index]
      if (removed === undefined) return 'Usage: /rules remove <number from /rules list>'
      await $.store.set(rulesStoreKey(root), rules.filter((_, position) => position !== index))
      return `Removed: ${describeRule(removed, root)}. ${await applyRules($, root)}`
    }
    default:
      return 'Usage: /rules [list | add fence <folder> | add exclusive <folder> <folder> | remove <n>]'
  }
}

async function scopeCommand($: EngineInterface, args: string): Promise<string> {
  const [action = 'show', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const argument = rest.join(' ')
  const root = await $.session.root()
  const scope = await read($, scopeAtom)

  switch (action) {
    case 'show':
      return `Scope: ${describeScope({ root, folders: scope.folders })}. Guard ${settings.isScopeGuardEnabled ? 'on' : 'off'}${scope.folders.length === 0 ? ', idle until /scope set or add' : ''}.`
    case 'set':
    case 'add': {
      if (!argument) return `Usage: /scope ${action} <folder> (or . for the root's own files)`
      const folder = scopeFolderCandidate(root, argument)
      if (folder === undefined || (await $.fs.list(folder).catch(() => undefined)) === undefined) return `"${argument}" is not ${root} or a folder under it.`
      // The root's own files sit in neither folder of an exclusive rule.
      if (action === 'add' && folder !== root) {
        const scopedFolders = scope.folders.filter(existing => existing !== root)
        const conflict = exclusiveConflict(await readRules($, root), scopedFolders, folder)
        if (conflict !== undefined) return `Not added: a rule says ${describeRule(conflict, root)}. /rules list to review it.`
      }
      const folders = action === 'set' ? [folder] : [...new Set([...scope.folders, folder])]
      await saveScope($, { folders }, root)
      return `Scope: ${describeScope({ root, folders })}.`
    }
    case 'remove': {
      if (!argument) return 'Usage: /scope remove <folder> (or . for the root\'s own files)'
      const folder = scopeFolderCandidate(root, argument)
      const folders = scope.folders.filter(existing => existing !== folder)
      await saveScope($, { folders }, root)
      return `Scope: ${describeScope({ root, folders })}.`
    }
    case 'clear':
      await saveScope($, { folders: [] }, root)
      return 'Scope cleared; the guard is idle until /scope set or add.'
    default:
      return 'Usage: /scope [show | set <folder> | add <folder> | remove <folder> | clear]'
  }
}

// ── Trim instead of summary compaction ────────────────────────────────────

const trimSettings = () => ({ atPercent: settings.trimAtPercent, targetPercent: settings.trimTargetPercent, keepTurns: settings.trimKeepTurns })

// `/compact trim` (you ran it) or the built-in automatic compaction (when a
// trim frees enough) is answered with a trim; any other compaction is the
// engine's summary. Sidekick can't start one itself: the engine skips the
// calling plugin's hooks, so its own request would become a summary.
const isTrimCommand = (e: { trigger: string; instructions?: string }) => e.trigger === 'manual' && /^\s*trim\b/i.test(e.instructions ?? '')

async function compactByTrim(
  $: EngineInterface,
  e: { trigger: string; agentId?: string; instructions?: string; messages: readonly SessionMessage[] },
): Promise<{ messages: SessionMessage[] } | { skip: string } | undefined> {
  if (e.agentId !== undefined || !Array.isArray(e.messages)) return undefined
  const isAsked = isTrimCommand(e)
  if (!isAsked && (e.trigger !== 'auto' || !settings.isTrimEnabled)) return undefined
  // `/compact trim all` (run between turns) drops the newest turn's output too.
  const keepTurns = isAsked && /^\s*trim\s+all\b/i.test(e.instructions ?? '') ? 0 : settings.trimKeepTurns
  const plan = planTrim(e.messages, keepTurns)
  if (plan.droppedCount === 0) return isAsked ? { skip: 'sidekick: no old tool output to trim' } : undefined
  const { context } = await $.session.usage()
  const decision = trimDecision(context.tokens ?? 0, context.window, plan.savedCharacters, isAsked ? { ...trimSettings(), atPercent: 0, targetPercent: 100 } : trimSettings())
  if (!decision.isWorth) return undefined
  $.ui.toast(trimNotice(plan, decision))
  return { messages: plan.messages }
}

// Whether the automatic compaction would be answered with a trim now.
async function isTrimWorthIt($: EngineInterface, messages: readonly SessionMessage[]): Promise<boolean> {
  if (!settings.isTrimEnabled || !Array.isArray(messages)) return false
  const plan = planTrim(messages, settings.trimKeepTurns)
  if (plan.droppedCount === 0) return false
  const { context } = await $.session.usage()
  return trimDecision(context.tokens ?? 0, context.window, plan.savedCharacters, trimSettings()).isWorth
}

// After each turn: offer a trim on the bar when the context is past the
// threshold and a trim would bring it to the target or below.
async function refreshTrimOffer($: EngineInterface, tokens: number | undefined, window: number, messages: readonly SessionMessage[]): Promise<void> {
  let offer: TrimOffer | null = null
  if (settings.isTrimEnabled && tokens !== undefined && window > 0 && (tokens / window) * 100 >= settings.trimAtPercent) {
    const plan = planTrim(messages, settings.trimKeepTurns)
    const decision = trimDecision(tokens, window, plan.savedCharacters, trimSettings())
    if (decision.isWorth && plan.droppedCount > 0) offer = { currentPercent: decision.currentPercent, projectedPercent: decision.projectedPercent, droppedCount: plan.droppedCount }
  }
  const current = await read($, trimOfferAtom)
  if (JSON.stringify(current) !== JSON.stringify(offer)) await update($, trimOfferAtom, () => offer)
}

// What belongs to one conversation: reset by /clear.
async function resetConversationState($: EngineInterface): Promise<void> {
  pendingSteps = []
  lastTurnChangedFiles = []
  await Promise.all([
    update($, replayAtom, current => ({ ...current, steps: [], index: 0, isOpen: false, isSeen: true })),
    update($, noteAtom, () => null),
    update($, briefAtom, () => null),
    update($, pendingBriefAtom, () => null),
    update($, resumeAtom, () => null),
    update($, ruleSuggestionAtom, () => null),
    update($, trimOfferAtom, () => null),
    update($, contextAtom, () => emptyReadout()),
    update($, barAtom, current => ({ ...current, open: null, notices: {}, blockedCalls: [] })),
  ])
}

// ── The context readout and the council button ────────────────────────────

// The panel asks for /context's breakdown, estimated locally (no request).
async function openContextPanel($: EngineInterface): Promise<void> {
  await openBar($, 'context')
  await refreshBreakdown($)
}

// Reads /context's breakdown into the readout (a new measurement clears it,
// so an open panel reads it again).
async function refreshBreakdown($: EngineInterface): Promise<void> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary', columns: 40 })
    if (context.breakdown === undefined) throw new Error('the engine gave none')
    const rows = breakdownRows(context.breakdown.categories)
    await update($, contextAtom, current => ({ ...current, breakdown: rows }))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await updateBar($, bar => ({ ...bar, notices: { ...bar.notices, context: `No breakdown: ${reason}. /context has it.` } }))
  }
}

// Whether the council mod is installed: its /council command is listed. It
// registers at its own session start, which may land after sidekick's, so
// this looks again a little later (and after turns) until it's found.
async function detectCouncil($: EngineInterface): Promise<boolean> {
  if (!settings.isCouncilButtonEnabled) return false
  if (await read($, hasCouncilAtom)) return true
  const isListed = (await $.command.list()).some(command => command.name === 'council')
  if (isListed) await update($, hasCouncilAtom, () => true)
  return isListed
}

async function readCouncil($: EngineInterface) {
  if (!(await read($, hasCouncilAtom))) return undefined
  const { value } = await $.state.get(councilStateRef as unknown as ForeignStateRef)
  return councilGlimpse(value as unknown)
}

// Puts a /council command in front of the prompt box's draft (replacing one
// already there): the rest is typed at full width and sent with Enter.
async function fillCouncilCommand($: EngineInterface, command: string): Promise<void> {
  await closeBar($)
  const draft = (await $.prompt.read()).text.replace(/^\/council(?: deep)?(?: reconsider)?\s*/, '')
  await $.prompt.fill({ text: `${command}${draft}`, mode: 'replace' })
}

async function openCouncilChamber($: EngineInterface): Promise<void> {
  await closeBar($)
  await $.command.run({ command: 'council', args: 'show' }).catch(() => $.prompt.fill({ text: '/council show', mode: 'replace' }))
}

// What the bar's buttons and panel actions do; the rest of the bar is pure
// (views/bar-model.ts).
function barHandlers($: EngineInterface, state: BarState): BarHandlers {
  const { warning, note, suggestion } = state
  const held = warning?.heldPrompt ?? null
  const releaseHeld = async (isSending: boolean) => {
    await update($, resumeAtom, current => (current ? { ...current, isAcknowledged: true, heldPrompt: null } : current))
    await closeBar($)
    if (held === null) return
    if (isSending) await $.prompt.submit({ text: held })
    else await $.prompt.fill({ text: held, mode: 'replace' })
  }
  const settleNote = async (afterwards?: () => Promise<unknown>) => {
    if (afterwards) await afterwards()
    await clearNote($)
    await closeBar($)
  }
  // Model calls run on a timer, not in the press: a press that outlasts its
  // 10 s budget fails. The bar's busy state shows the work going on.
  const detach = (work: () => Promise<unknown>) => void $.clock.after(0, () => void work().catch(() => undefined))
  return {
    toggle: id => toggleBar($, id),
    close: () => closeBar($),
    summary: () => detach(() => pressSummary($)),
    toggleBriefDetail: () => update($, briefAtom, current => (current ? { ...current, isExpanded: !current.isExpanded } : current)),
    writeRepoHandoffs: () => writeRepoHandoffs($),
    handoff: press => detach(() => pressHandoff($, press.surface)),
    // Choosing the handoff answers the warning: the held prompt goes back in
    // the prompt box unsent (and into HANDOFF.md), and the TL;DR card shows
    // the handoff's progress.
    handoffFromResume: async press => {
      await update($, resumeAtom, current => (current ? { ...current, isAcknowledged: true } : current))
      if (held !== null) await $.prompt.fill({ text: held, mode: 'replace' })
      detach(() => pressHandoff($, press.surface))
    },
    runPendingBrief: press => detach(() => runPendingBrief($, press.surface)),
    cancelPendingBrief: async () => {
      await update($, pendingBriefAtom, () => null)
      await closeBar($)
    },
    headsUp: () => detach(() => pressHeadsUp($)),
    rule: () => detach(() => pressRule($)),
    replay: () => openReplay($),
    sendHeld: () => releaseHeld(true),
    editHeld: async () => {
      // Editing is the answer to the warning: the edited prompt sends as is.
      await update($, resumeAtom, current => (current ? { ...current, heldPrompt: null, isAcknowledged: true } : current))
      if (held !== null) await $.prompt.fill({ text: held, mode: 'replace' })
    },
    releaseHeld: () => releaseHeld(false),
    askAboutNote: () => settleNote(() => $.prompt.fill({ text: `About your heads-up "${note?.headline ?? ''}": `, mode: 'replace' })),
    knewNote: () => settleNote(() => (note ? rememberTopic($, KNOWN_TOPICS_STORE_KEY, note.headline) : Promise.resolve())),
    dismissNote: () => settleNote(),
    addRule: () => (suggestion ? acceptSuggestedRule($, suggestion) : undefined),
    laterRule: () => clearRuleEvidence($),
    neverRule: () => (suggestion ? declineSuggestedRule($, suggestion) : undefined),
    clearBlocks: () => clearRuleEvidence($),
    fillTrim: async () => {
      await closeBar($)
      await $.prompt.fill({ text: '/compact trim', mode: 'replace' })
    },
    openContext: () => openContextPanel($),
    askCouncil: () => fillCouncilCommand($, '/council '),
    // A brain trust: every advisor on the stronger model.
    askBrainTrust: () => fillCouncilCommand($, '/council deep '),
    reconsiderCouncil: () => fillCouncilCommand($, '/council reconsider '),
    openChamber: () => openCouncilChamber($),
  }
}

// ── Hooks ─────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // One literal call per command: the engine reads the names off the source.
    if (settings.isReplayEnabled) await $.command.register({ name: 'replay', description: "Step through the last turn's file edits" })
    if (settings.isSummaryEnabled) await $.command.register({ name: 'tldr', description: 'Brief what happened: the last turn, since the last brief, or the whole session', argumentHint: '[last|since|full]' })
    await $.command.register({ name: 'heads-up', description: 'Review the last answer for something you should know, or list/forget topics marked known', argumentHint: '[now|known|forget]' })
    await $.command.register({ name: 'scope', description: "Show or change this session's target folders", argumentHint: '[show|set <folder>|add <folder>|remove <folder>|clear]' })
    // Looked for afresh each start (the council mod may have been turned off).
    await update($, hasCouncilAtom, () => false)
    void detectCouncil($)
      .then(isFound => (isFound ? true : $.clock.sleep(3000).then(() => detectCouncil($))))
      .catch(() => undefined)
    await $.command.register({ name: 'rules', description: "Long-lived rules in Claude Code's own settings: list, add or remove", argumentHint: '[list|add fence <folder>|add exclusive <a> <b>|remove <n>]' })
    if (settings.isSummaryEnabled) await openLedger($).catch(() => undefined)
    const root = await $.session.root()
    await restoreScope($, root)
    // The rules are the source of truth; the settings file is made to match.
    await (async () => writeRules($, root, await readRules($, root), await storedStyle($, root)))().catch((error: unknown) =>
      $.ui.toast(`Sidekick could not sync its rules into .claude/settings.local.json, so they are not enforced: ${error instanceof Error ? error.message : String(error)}`),
    )
    return result
  })

  on('command.run', { command: 'replay' }, async $ => {
    const isOpened = await openReplay($)
    const { steps } = await read($, replayAtom)
    return { text: isOpened ? `Replay: ${steps.length} edits.` : 'Replay: no edits recorded yet.' }
  })

  on('command.run', { command: 'tldr' }, async ($, e) => {
    const word = e.args.trim().toLowerCase().split(/\s+/)[0] || 'last'
    const span = SPAN_WORDS[word]
    if (span === undefined) return { text: 'Usage: /tldr [last|since|full] (since = since the last brief, also range; full = the whole session, also whole or complete)' }
    await pressSummary($, span, true)
    const [brief, pending, bar] = await Promise.all([read($, briefAtom), read($, pendingBriefAtom), read($, barAtom)])
    if (pending !== null && pending.span === span) return { text: `This TL;DR needs ${pending.calls} Haiku calls: confirm it on the bar above the prompt.` }
    return { text: bar.notices.tldr ?? (brief !== null ? briefSummaryText(brief) : 'TL;DR: shown above the prompt.') }
  })

  on('command.run', { command: 'heads-up' }, async ($, e) => {
    const action = e.args.trim().toLowerCase() || 'now'
    if (action === 'known') {
      const topics = stringList(await $.store.get(KNOWN_TOPICS_STORE_KEY))
      return { text: topics.length ? `Topics marked known:\n${topics.map(topic => `- ${topic}`).join('\n')}` : 'No topics marked known.' }
    }
    if (action === 'forget') {
      await $.store.delete(KNOWN_TOPICS_STORE_KEY)
      await $.store.delete(SHOWN_TOPICS_STORE_KEY)
      return { text: 'Forgot the known and recently shown topics.' }
    }
    if (action !== 'now') return { text: 'Usage: /heads-up [now|known|forget]' }
    await pressHeadsUp($)
    const { notices } = await read($, barAtom)
    return { text: notices.headsUp ?? 'Heads-up: shown above the prompt.' }
  })

  on('command.run', { command: 'scope' }, async ($, e) => ({ text: await scopeCommand($, e.args) }))

  on('command.run', { command: 'rules' }, async ($, e) => ({ text: await rulesCommand($, e.args) }))

  // Guard first (a blocked call is never recorded), then record successful edits.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isGuarded = settings.isScopeGuardEnabled && (FILE_TOOLS.has(tool) || tool === 'Bash')
    const isRecorded = settings.isReplayEnabled && isEditTool(tool)
    const isLedgered = settings.isSummaryEnabled
    // With the TL;DR off, every other tool passes untouched, with no lookups.
    if (!isGuarded && !isRecorded && !isLedgered) return next(e)
    const input = e as unknown as Record<string, unknown>
    const agentId = typeof e.agentId === 'string' ? e.agentId : undefined

    let context: ScopeContext | undefined
    if (isGuarded) {
      let denial: string | undefined
      try {
        context = await scopeContext($)
        // A council knight or scout is held to its order's folder instead.
        const orderFolder = typeof e.agentId === 'string' ? await councilOrderFolder($, e.agentId) : undefined
        if (orderFolder !== undefined) context = { ...context, folders: [orderFolder] }
        denial = await guardToolCall($, tool, input, context)
      } catch {
        // A guard that can't check fails closed. Claude can retry; if it keeps
        // failing, the user turns the guard off (scopeGuardEnabled) or clears the scope.
        denial =
          'The sidekick scope guard hit an internal error while checking this call and blocked it to be safe. Retry it once; if it is blocked again, stop and tell the user the scope guard is failing (they can run /scope clear or turn off scopeGuardEnabled).'
        $.ui.toast('Scope guard error: the call was blocked.')
      }
      if (denial !== undefined) {
        if (isLedgered) await recordCall($, { tool, input, agentId, startedAt: undefined, steps: [], result: { deny: denial } }).catch(() => undefined)
        return { deny: denial }
      }
    }

    if (!isRecorded && !isLedgered) return next(e)
    let steps: ReplayStep[] = []
    if (isEditTool(tool)) {
      try {
        steps = await recordableSteps($, tool, input, context?.cwd ?? (await $.session.cwd().catch(() => '')))
      } catch {
        // recording must never stop the edit
      }
    }
    const startedAt = isLedgered ? await ledgerNow($) : undefined
    const result = await next(e)
    if (isRecorded && result.deny === undefined && result.isError !== true) pendingSteps.push(...steps)
    if (isLedgered) await recordCall($, { tool, input, agentId, startedAt, steps, result }).catch(() => undefined)
    return result
  }).catch(($, e, next) => {
    // The hook failed or ran out of time: a guarded call it hadn't let through
    // is refused (fail closed); anything else goes on.
    if (next.called) return next(e)
    const isGuarded = settings.isScopeGuardEnabled && (FILE_TOOLS.has(String(e.tool)) || e.tool === 'Bash')
    return isGuarded ? { deny: 'The sidekick scope guard could not finish checking this call in time and blocked it to be safe. Retry it once; if it is blocked again, tell the user.' } : next(e)
  })

  // A subagent's run raises no turn.start, so this is the main loop's.
  on('turn.start', async ($, e, next) => {
    pendingSteps = []
    lastUserPrompt = e.text
    currentTurnId = e.turnId
    isMainTurnRunning = true
    compactedSays = new Set()
    if (settings.isSummaryEnabled) recordEntry($, promptEntry(await ledgerNow($), e.turnId, e.text))
    // A last-turn TL;DR is stale now (a brief of a longer span stays); written
    // only when there is one, so a turn without one redraws nothing.
    if ((await read($, briefAtom))?.span === 'last') await update($, briefAtom, () => null)
    const bar = await read($, barAtom)
    if (bar.notices.tldr !== undefined || bar.notices.headsUp !== undefined || bar.open === 'tldr') {
      await updateBar($, current => ({ ...current, open: current.open === 'tldr' ? null : current.open, notices: { ...current.notices, tldr: undefined, headsUp: undefined } }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    isMainTurnRunning = false
    if (councilChecksLeft > 0) {
      councilChecksLeft--
      void detectCouncil($).catch(() => undefined)
    }
    if (settings.isSummaryEnabled) {
      const answer = 'answer' in e && typeof e.answer === 'string' ? e.answer : ''
      recordEntry($, answerEntry(await ledgerNow($), e.turnId, answer, e.durationMs, e.isAborted))
      await flushLedger($)
    }
    const steps = pendingSteps
    pendingSteps = []
    lastTurnChangedFiles = [...new Set(steps.map(step => step.file))]
    if (steps.length > 0) await update($, replayAtom, current => ({ ...current, steps, index: 0, isSeen: false }))
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    // /clear starts a new conversation without a session.start: drop what
    // belonged to the old one (the scope and long-lived rules carry on).
    if (e.source === 'clear') {
      await resetConversationState($)
      if (settings.isSummaryEnabled) await flushLedger($).then(() => openLedger($)).catch(() => undefined)
    }
    if (settings.isResumeWarningEnabled) {
      const warning = resumeWarningFrom(e as Parameters<typeof resumeWarningFrom>[0])
      if (warning !== undefined) await update($, resumeAtom, () => warning)
    }
    return result
  })

  // Holds the first typed prompt of a resumed session whose cache expired.
  on('prompt.submit', async ($, e, next) => {
    if (!settings.isResumeWarningEnabled || e.origin.kind !== 'composer' || e.text.trim().startsWith('/')) return next(e)
    const warning = await read($, resumeAtom)
    if (warning === null || warning.isAcknowledged) return next(e)
    await update($, resumeAtom, current => (current ? { ...current, heldPrompt: e.text } : current))
    return { drop: 'Held by sidekick: this resumed session has to re-send its whole context. Send it, or edit it, from the bar above the prompt.' }
  })

  // Claude's own words in each main response, for the ledger.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (settings.isSummaryEnabled && e.agentId === undefined && isMainTurnRunning) {
      try {
        const text = responseText(e.message.content)
        if (isNewSay(text, compactedSays)) recordEntry($, sayEntry(await ledgerNow($), text))
      } catch {
        // recording must never stop the row
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // After each turn the engine reports the context's size: offer a trim if it's worth it.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    // Only a change in the context (after a turn), not a rate-limit window
    // moving, which can happen mid-turn.
    if (!e.changed.includes('context')) return result
    const messages = await $.session.messages().catch(() => [])
    await refreshTrimOffer($, e.context.tokens, e.context.window, messages).catch(() => undefined)
    if (settings.isContextReadoutEnabled) {
      // The turn's final answer: the last message, when it's Claude's.
      const last = messages[messages.length - 1]
      const answerCharacters = last?.role === 'assistant' ? last.text.length : 0
      await update($, contextAtom, current => withMeasurement(current, e.context.tokens, e.context.window, lastUserPrompt, answerCharacters))
      if ((await read($, barAtom)).open === 'context') await refreshBreakdown($)
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    if (Array.isArray(e.messages)) compactedSays = new Set(e.messages.filter(message => message.role === 'assistant').map(message => sayKey(message.text)))
    // A summary computed ahead of time is wasted when the compaction it's for
    // will be a trim.
    if (e.trigger === 'precompute' && (await isTrimWorthIt($, e.messages).catch(() => false))) return { skip: 'sidekick: this compaction will be a trim' }
    // `/compact trim` never falls back to a summary: a trim that can't run says why.
    const trimmed = await compactByTrim($, e).catch((error: unknown) =>
      isTrimCommand(e) ? { skip: `sidekick: the trim failed (${error instanceof Error ? error.message : String(error)}); nothing was changed` } : undefined,
    )
    const result = trimmed ?? (isTrimCommand(e) ? { skip: 'sidekick: no transcript to trim; nothing was changed' } : await next(e))
    if (!('skip' in result)) await update($, trimOfferAtom, () => null)
    return result
  }).catch(($, e, next) =>
    // Out of time or failed: `/compact trim` still never becomes a summary.
    isTrimCommand(e) ? { skip: 'sidekick: the trim did not finish; nothing was changed' } : next(e),
  )

  // The bar, always one line; an open item's panel under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [replay, bar, warning, note, brief, pendingBrief, suggestion, trimOffer, context, council] = await Promise.all([
      read($, replayAtom),
      read($, barAtom),
      read($, resumeAtom),
      read($, noteAtom),
      read($, briefAtom),
      read($, pendingBriefAtom),
      read($, ruleSuggestionAtom),
      read($, trimOfferAtom),
      read($, contextAtom),
      readCouncil($),
    ])
    if (replay.isOpen && replay.isInBand) return drawReplay($, e, true)
    const state: BarState = { bar, replay, warning, note, brief, pendingBrief, suggestion, trimOffer, context, council }
    const model = barModel(state, barHandlers($, state), settings)
    return model.items.length === 0 ? next(e) : barView($.ui.resolve(e), model)
  })

  on('ui.render', { component: 'Pane', requestId: REPLAY_PANE_ID }, ($, e) => drawReplay($, e, false))

  // The person closed a pane (Escape, the close mark): keep state in step.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === REPLAY_PANE_ID) await update($, replayAtom, current => ({ ...current, isOpen: false, isInBand: false }))
    return result
  })
}
