// sidekick: a bar above the prompt (TL;DR briefs from a turn ledger, heads-up,
// rule suggestions, edit replay, a context readout, a trim offer, a council
// button), a scope guard
// for multi-repo sessions with path rules (and a git backstop when a council
// order's agent stops), long-lived rules in Claude Code's own settings, a
// resume warning, trimming in place of summary compaction, and ask_codex and
// ask_agy (a prompt to another agent's CLI, approved by the person each call).
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
import type { EngineInterface, ModelCompleteRequest, ModelCompleteResult, ModelUsage, Register, RenderInput, RenderSurface, SessionMessage, StateRef } from 'claude-code'

import type { Bar, BarItemId, Brief, BriefRepo, ContextReadout, HeadsUpNote, PendingBrief, TrimOffer, Replay, ReplayStep, ResumeWarning, RuleSuggestion, Scope } from '../types'
import {
  BRIEF_SYSTEM_PROMPT,
  CONFIRM_ABOVE_CALLS,
  baseName,
  briefLabel,
  briefPrompt,
  briefSummaryText,
  chunkPrompt,
  claimsCheck,
  filesByRepo,
  handoffMarkdown,
  handoffStarterPrompt,
  parentFolder,
  parseBriefReply,
  pathInRepo,
  planBrief,
  repoGroupFolder,
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
import { ASK_CLIS, ASK_SCHEMA, approvalText, askCli, askCliFor, askDescription, findOnPath, promptOf, type AskCliId, type AskOutcome } from './ask-cli'
import { isEditTool, stepsForEdit, textField } from './replay-steps'
import {
  BACKSTOP_MARK,
  BACKSTOP_RETENTION_MS,
  backstopToast,
  backstopWarning,
  scopePathspec,
  withinScope,
  changesSince,
  dirtyMatches,
  flaggedChanges,
  isBaseline,
  newSinceStart,
  parseNameStatus,
  parseStatus,
  type Baseline,
  type Change,
} from './backstop'
import { resumeWarningFrom } from './resume-warning'
import { inlineCodeDenial, inlineCodeQuestion } from './inline-code'
import { REVIEW_MARK, REVIEW_MAX_TOKENS, REVIEW_TIMEOUT_MS, RECENT_COMMANDS, buildStopReviewPrompt, parseReviewAnswer, reviewNote, reviewSystemPrompt } from './judge'
import { METRICS_RETENTION_MS, countDecision, emptyMetrics, metricsText, readMetrics, type GuardMetrics } from './guard-metrics'
import { DEFAULT_POLICY, assemblePolicy } from './policy'
import {
  decideCall,
  decideShell,
  isShellTool,
  newJudgeState,
  policyDenial,
  policyQuestion,
  policyToast,
  shellCommandOf,
  type JudgeEvent,
  type JudgeHost,
  type JudgeState,
  type ModelReply,
  type ShellCall,
  type ShellDecision,
  type ShellTool,
} from './policy-guard'
import { POSIX_SNAPSHOT_ARGV, WINDOWS_SNAPSHOT_ARGV, parsePosixSnapshot, parseWindowsSnapshot, type ProcessSnapshot } from './processes'
import { powerShellPathOps } from './powershell'
import { redactSecrets } from './secrets'
import {
  checkFileEdit,
  commandPathOps,
  denialMessage,
  describeScope,
  fileReadings,
  pathStyleOf,
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
  matchPathRules,
  parseRule,
  parseSettingsText,
  pathRuleDenial,
  ruleKey,
  ruleSpec,
  standingPathRules,
  standingPolicy,
  syncRules,
  type ActivePathRule,
  type GuardLayer,
  type LongLivedRule,
  type PathOp,
  type PathRuleHit,
  type PathRuleStyle,
} from './scope-rules'
import { readSettings, type SidekickSettings } from './settings'
import { planTrim, trimDecision, trimNotice } from './trim'
import { breakdownRows, emptyReadout, withMeasurement } from './context-readout'
import { councilGlimpse, orderFor, type CarriedOrder } from './council-glimpse'
import { NO_HOME, homeFromEnvironment } from './paths'
import { removeInside, type RemoveHost } from './remove'
import { modelFailureText, stringList, textKey } from './values'
import { barView } from './views/bar'
import { barModel, type BarHandlers, type BarState } from './views/bar-model'
import { MAX_VIEW_DIFF_LINES, replayView } from './views/replay'
import { modelEntries, modelEntry, parseSince, scopeUsageReport } from './usage'

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
let hasToastedJudgePause = false
// The home folder, for the guard's `~` paths (undefined until read, '' if unknown).
let homeFolder: string | undefined
// The policy judge's memory for this process: the segments it allowed, and
// the calls each budget has spent (rebuilt on reload, so a reload starts the
// budgets over; the ledger's metrics keep the session's totals).
let judgeState: JudgeState = newJudgeState()
// /scope judge off: this session's commands skip the judge (the inline-code
// ban, the scope and the path rules still hold).
let isJudgeOffForSession = false
let snapshotCache: { at: number; value: ProcessSnapshot | undefined } | undefined
const SNAPSHOT_CACHE_MS = 2000
// The commands run, per agent id (and 'owner'), for the judge and the stop review.
const recentCommands = new Map<string, string[]>()
const MAX_REMEMBERED_COMMANDS = 200
// The order each agent carried at its first guarded call, for its stop review.
const agentOrders = new Map<string, CarriedOrder>()
// This session's guard metrics, written to the store every few changes.
let guardMetrics: GuardMetrics = emptyMetrics()
let metricsChanges = 0
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
// Order agents whose path rules' backstop has been looked at (its baseline
// is in the store, when its rules call for one).
const backstopsStarted = new Set<string>()
// Where each ask CLI was found at session start (absolute); a CLI missing
// then has no entry and no tool.
const askPaths = new Map<AskCliId, string>()

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
  const reply = await completeModel($, { purpose: wantsSummary ? 'tldr' : wantsHeadsUp ? 'heads-up' : 'rule' }, {
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

// remove.ts's engine calls, spelled here: the engine follows `$` into no other file.
const removeHost = ($: EngineInterface): RemoveHost => ({
  stat: (path, options) => $.fs.stat(path, options),
  list: path => $.fs.list(path),
  exists: path => $.fs.exists(path),
  run: (argv, init) => $.process.run(argv, init),
})

async function pruneLedgers($: EngineInterface, base: string, current: string, now: number): Promise<void> {
  const folders = []
  for (const entry of await $.fs.list(base).catch(() => [])) {
    if (entry.kind !== 'dir') continue
    const files = await $.fs.list(`${base}/${entry.name}`).catch(() => [])
    folders.push({ name: entry.name, newestMs: Math.max(0, ...files.map(file => file.mtimeMs)) })
  }
  // Each on its own: one that can't be deleted (or is refused) leaves the rest to go.
  const home = await readHome($)
  for (const name of expiredLedgers(folders, current, now)) {
    await removeInside(removeHost($), `${base}/${name}`, base, home || undefined).catch(error => {
      try {
        $.ui.log(`sidekick: kept an expired ledger: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
      } catch {
        // A log line is best effort.
      }
    })
  }
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
    const use = { purpose: isForHandoff ? 'handoff' : 'brief' }
    const partSummaries = plan.chunks.length > 1 ? await summarizeChunks($, plan.chunks, use) : undefined
    if (partSummaries !== undefined && 'failure' in partSummaries) return `The TL;DR failed: a part of the log could not be condensed (${partSummaries.failure}).`
    const reply = await completeModel($, use, {
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
async function summarizeChunks($: EngineInterface, chunks: readonly string[], use: ModelUse): Promise<{ summaries: string[] } | { failure: string }> {
  const summaries: Array<string | null> = chunks.map(chunk => chunkSummaries.get(textKey(chunk)) ?? null)
  const missing = chunks.map((_, index) => index).filter(index => summaries[index] === null)
  const failures: string[] = []
  for (let start = 0; start < missing.length; start += 3) {
    await Promise.all(
      missing.slice(start, start + 3).map(async index => {
        const reply = await completeModel($, use, { model: settings.model, system: BRIEF_SYSTEM_PROMPT, prompt: chunkPrompt(chunks[index]!, index, chunks.length), maxTokens: 350, timeoutMs: 60000 })
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
  const groupFolder = (path: string) => repoGroupFolder(root, path)
  const tops = new Map<string, string | undefined>()
  for (const folder of new Set(stats.files.map(file => groupFolder(file.path)))) {
    const isFolder = (await $.fs.stat(folder).catch(() => undefined))?.kind === 'dir'
    tops.set(folder, await git($, isFolder ? folder : parentFolder(folder), ['rev-parse', '--show-toplevel']))
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
      name: baseName(folder),
      files: files.map(file => ({ ...file, path: pathInRepo(folder, file.path) })),
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
    const notice = await makeBrief($, pending.span, true, pending.isForHandoff)
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

// The home folder ('' when neither HOME nor USERPROFILE is set), read once
// per process. Unknown, the ledger stays off and says why once.
async function readHome($: EngineInterface): Promise<string> {
  if (homeFolder === undefined) {
    const [fromHome, fromProfile] = await Promise.all([$.env.get('HOME').catch(() => undefined), $.env.get('USERPROFILE').catch(() => undefined)])
    homeFolder = homeFromEnvironment(fromHome, fromProfile) ?? ''
    if (homeFolder === '') {
      try {
        $.ui.log(`sidekick: ${NO_HOME}; the turn ledger (TL;DR, handoff) is off and the scope guard can't place ~ paths.`)
      } catch {
        // A log line is best effort.
      }
    }
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

// ── The policy judge ──────────────────────────────────────────────────────

// The judge's model call, through the engine's own model call (completeModel,
// which records its usage): the Claude Code session's sign-in pays for it, as
// for every other sidekick call (a subscription's usage, or the API key the
// session runs on).
// 4 s: the whole tool.call hook has a 10 s budget, and the snapshot may take 1-2 s.
function judgeHost($: EngineInterface, who: { agentId: string | undefined; order: CarriedOrder | undefined }): JudgeHost {
  const use: ModelUse = { purpose: 'judge', ...(who.agentId !== undefined ? { agentId: who.agentId } : {}), ...(who.order !== undefined ? { orderId: who.order.id } : {}) }
  return {
    complete: request => completeModel($, use, { model: settings.model, system: request.system, prompt: request.prompt, maxTokens: request.maxTokens, timeoutMs: request.timeoutMs, effort: request.effort }) as Promise<ModelReply>,
    snapshot: () => processSnapshot($),
    pausedBecause: () => judgePause($),
  }
}

// Paused once the 5-hour usage passes the cap (with no figures, an API key
// session, it never pauses). Paused, it fails closed like a spent budget.
async function judgePause($: EngineInterface): Promise<string | undefined> {
  try {
    const usage = await $.session.usage()
    const fiveHour = usage.rateLimits.find(limit => limit.kind === 'five_hour')
    if (fiveHour === undefined || fiveHour.percentUsed < settings.classifierUsageCap) return undefined
    if (!hasToastedJudgePause) $.ui.toast(`Policy judge paused: 5-hour usage is at ${fiveHour.percentUsed}%. Commands it would judge are refused (agents) or asked about (you).`)
    hasToastedJudgePause = true
    return `the policy judge is paused: the 5-hour usage is at ${fiveHour.percentUsed}% (the cap is ${settings.classifierUsageCap}%)`
  } catch {
    return undefined
  }
}

// One query, cached for 2 s: every process with its parent, name, start and
// command line (cut to 200 characters), read in processes.ts.
async function processSnapshot($: EngineInterface): Promise<ProcessSnapshot | undefined> {
  const now = await $.clock.now()
  if (snapshotCache !== undefined && now - snapshotCache.at < SNAPSHOT_CACHE_MS) return snapshotCache.value
  const isWindows = pathStyleOf(await $.session.root()) === 'windows'
  const result = await $.process.run(isWindows ? [...WINDOWS_SNAPSHOT_ARGV] : [...POSIX_SNAPSHOT_ARGV], { timeoutMs: 3000 }).catch(() => undefined)
  const value = result === undefined || result.exitCode !== 0 || result.isStdoutTruncated ? undefined : isWindows ? parseWindowsSnapshot(result.stdout) : parsePosixSnapshot(result.stdout)
  snapshotCache = { at: now, value }
  return value
}

// ── The guard's metrics and the stop review ───────────────────────────────

const METRICS_STORE_PREFIX = 'guardMetrics:'
const metricsStoreKey = (sessionId: string) => `${METRICS_STORE_PREFIX}${sessionId}`
const METRICS_FLUSH_EVERY = 20

// Loads this session's metrics (and with them the judge's spent budgets, so
// a reload doesn't reset them), and deletes other sessions' past retention.
async function restoreMetrics($: EngineInterface): Promise<void> {
  const [sessionId, now, keys] = await Promise.all([$.session.id(), $.clock.now(), $.store.keys()])
  guardMetrics = readMetrics(await $.store.get(metricsStoreKey(sessionId)))
  for (const [budget, calls] of Object.entries(guardMetrics.callsByBudget)) judgeState.calls.set(budget, calls)
  for (const key of keys.filter(key => key.startsWith(METRICS_STORE_PREFIX) && key !== metricsStoreKey(sessionId))) {
    const savedAt = readMetrics(await $.store.get(key)).savedAt
    if (now - savedAt > METRICS_RETENTION_MS) await $.store.delete(key)
  }
}

async function flushMetrics($: EngineInterface): Promise<void> {
  if (metricsChanges === 0) return
  metricsChanges = 0
  guardMetrics.savedAt = await $.clock.now()
  await $.store.set(metricsStoreKey(await $.session.id()), guardMetrics)
}

function countGuardDecision($: EngineInterface, decision: ShellDecision, event: JudgeEvent, budgetKey: string): void {
  countDecision(guardMetrics, decision, event, budgetKey)
  if (++metricsChanges >= METRICS_FLUSH_EVERY) void flushMetrics($).catch(() => undefined)
}

// When an order's agent stops: one judge call over its whole command log
// (redacted, as data), for what only the sequence shows. A note for the main
// session, or undefined when there's nothing to say.
async function reviewAgentRun($: EngineInterface, agentId: string): Promise<string | undefined> {
  const order = agentOrders.get(agentId)
  agentOrders.delete(agentId)
  const commands = recentCommands.get(agentId) ?? []
  recentCommands.delete(agentId)
  if (order === undefined || commands.length < 2 || !isJudging(agentId)) return undefined
  const spent = judgeState.calls.get(agentId) ?? 0
  if (spent >= settings.judgeBudgetAgent) return reviewNote(order.id, { kind: 'skipped', why: "the judge's budget for this agent was spent" })
  const paused = await judgePause($)
  if (paused !== undefined) return reviewNote(order.id, { kind: 'skipped', why: paused })
  judgeState.calls.set(agentId, spent + 1)
  const context = await scopeContext($)
  // With its granted leave, so the review doesn't warn of what was granted.
  const policy = assemblePolicy(standingPolicy(await readRules($, context.root)), { id: order.id, sentences: order.policy, leave: order.leave })
  const reply = await completeModel($, { purpose: 'stop-review', agentId, orderId: order.id }, {
    model: settings.model,
    system: reviewSystemPrompt(policy),
    prompt: buildStopReviewPrompt({ commands, agent: agentLabelOf(agentId, order), folders: [order.folder] }, context.home),
    maxTokens: REVIEW_MAX_TOKENS,
    timeoutMs: REVIEW_TIMEOUT_MS,
  }).catch(() => undefined)
  guardMetrics.reviews++
  metricsChanges++
  if (reply === undefined || !reply.isAnswered) return reviewNote(order.id, { kind: 'failed', why: reply === undefined ? 'the review call failed' : `the review gave no answer: ${modelFailureText(reply)}` })
  guardMetrics.inputTokens += reply.usage?.input_tokens ?? 0
  guardMetrics.outputTokens += reply.usage?.output_tokens ?? 0
  guardMetrics.cacheReadTokens += reply.usage?.cache_read_input_tokens ?? 0
  const answer = parseReviewAnswer(reply.text, reply.usage?.output_tokens)
  if (answer.kind === 'warn') {
    guardMetrics.reviewWarnings++
    $.ui.toast(`Stop review: order ${order.id}'s commands, read together, may break the policy.`)
  }
  return reviewNote(order.id, answer)
}

const JUDGE_OFF_STORE_PREFIX = 'judgeOff:'
const judgeOffStoreKey = (sessionId: string) => `${JUDGE_OFF_STORE_PREFIX}${sessionId}`

function judgeStatusText(): string {
  if (settings.policyJudge === 'off') return 'off (the policyJudge setting)'
  if (isJudgeOffForSession) return 'off for this session (/scope judge on turns it back on)'
  const spent = [...judgeState.calls.values()].reduce((sum, calls) => sum + calls, 0)
  return `on for ${settings.policyJudge === 'all' ? 'every session' : "subagents' commands"} (${settings.model}; at most ${settings.judgeBudgetAgent} calls per agent, ${settings.judgeBudgetSession} for your own session; ${spent} spent since sidekick loaded)`
}

// Restores /scope judge off for this session, and prunes old entries.
async function restoreJudgeOff($: EngineInterface): Promise<void> {
  const [sessionId, now, keys] = await Promise.all([$.session.id(), $.clock.now(), $.store.keys()])
  isJudgeOffForSession = false
  for (const key of keys.filter(key => key.startsWith(JUDGE_OFF_STORE_PREFIX))) {
    const savedAt = ((await $.store.get(key)) as { savedAt?: unknown } | undefined)?.savedAt
    if (key === judgeOffStoreKey(sessionId)) isJudgeOffForSession = true
    else if (typeof savedAt !== 'number' || now - savedAt > SCOPE_RETENTION_MS) await $.store.delete(key)
  }
}

// Whether a call's commands go to the judge: policyJudge `all` (every
// session), `agents` (subagents only) or `off`, and not turned off for this
// session with /scope judge off.
const isJudging = (agentId: string | undefined) => !isJudgeOffForSession && (settings.policyJudge === 'all' || (settings.policyJudge === 'agents' && agentId !== undefined))

const agentLabelOf = (agentId: string | undefined, order: CarriedOrder | undefined) =>
  order !== undefined ? `a council order's agent (order ${order.id})` : agentId !== undefined ? "a subagent of the owner's session" : "the owner's own interactive session"

// The commands a session (or each of its agents) ran, newest last: the
// judge reads the last few; the stop review reads an agent's whole run.
function rememberCommand(key: string, tool: string, command: string, outcome: 'ran' | 'refused'): void {
  const list = recentCommands.get(key) ?? []
  list.push(`${outcome === 'refused' ? '(refused) ' : ''}${tool === 'PowerShell' ? 'PS> ' : ''}${command.slice(0, 600)}`)
  if (list.length > MAX_REMEMBERED_COMMANDS) list.splice(0, list.length - MAX_REMEMBERED_COMMANDS)
  recentCommands.set(key, list)
  if (recentCommands.size > 50) recentCommands.delete(recentCommands.keys().next().value!)
}

// The policy decision for a shell call: the judge (and its fast path, cache,
// complexity rule and budget), after the deterministic checks.
async function judgeShellCall(
  $: EngineInterface,
  tool: ShellTool,
  command: string,
  context: ScopeContext,
  who: { agentId: string | undefined; order: CarriedOrder | undefined },
): Promise<ShellDecision> {
  // An order's agent answers to its order's rules and granted leave; the
  // deterministic checks before the judge hold either way (decideCall).
  const policy = assemblePolicy(standingPolicy(await readRules($, context.root)), who.order === undefined ? undefined : { id: who.order.id, sentences: who.order.policy, leave: who.order.leave })
  const budgetKey = who.agentId ?? 'owner'
  const call: ShellCall = {
    tool,
    command,
    context,
    isAgent: who.agentId !== undefined,
    agentLabel: agentLabelOf(who.agentId, who.order),
    budgetKey,
    policy,
    recent: (recentCommands.get(budgetKey) ?? []).slice(-RECENT_COMMANDS),
  }
  const options = {
    isInlineBanEnabled: settings.isInlineCodeBanEnabled,
    judge: { isEnabled: isJudging(who.agentId), maxSegments: settings.judgeMaxSegments, budget: who.agentId !== undefined ? settings.judgeBudgetAgent : settings.judgeBudgetSession },
  }
  const event: JudgeEvent = { judged: false }
  const decision = await decideCall(call, options, judgeState, judgeHost($, who), event)
  countGuardDecision($, decision, event, budgetKey)
  return decision
}

// The council order a subagent carries, if it carries one (read from the
// council mod's state; see council-glimpse.ts).
async function councilOrder($: EngineInterface, agentId: string): Promise<CarriedOrder | undefined> {
  if (!(await read($, hasCouncilAtom))) return undefined
  const { value } = await $.state.get(councilCourtRef as unknown as ForeignStateRef)
  return orderFor(value as unknown, agentId)
}

// The path rules a call answers to: the standing forbid rules (globs from the
// root), then its council order's own (globs from the order's folder).
async function activePathRules($: EngineInterface, root: string, order: CarriedOrder | undefined): Promise<ActivePathRule[]> {
  const ordered = (order?.forbid ?? []).map(rule => ({ ...rule, base: order!.folder, source: { kind: 'order' as const, id: order!.id } }))
  return [...standingPathRules(await readRules($, root), root), ...ordered]
}

// A write to a file that exists edits it; to one that doesn't, creates it.
// Both, when the guard can't tell.
async function opsForWrite($: EngineInterface, path: string): Promise<PathOp[]> {
  const exists = await $.fs.exists(path).catch(() => undefined)
  return exists === undefined ? ['create', 'edit'] : exists ? ['edit'] : ['create']
}

// The path rules a file tool's call breaks: Write, Edit, MultiEdit and
// NotebookEdit create or edit, by whether the file is there.
async function fileToolHits($: EngineInterface, filePath: string, context: ScopeContext, rules: readonly ActivePathRule[]): Promise<PathRuleHit[]> {
  if (rules.length === 0) return []
  const readings = fileReadings(filePath, context)
  if (readings.length === 0) return []
  const ops = await opsForWrite($, readings[0]!)
  return readings.flatMap(reading => matchPathRules(reading, ops, rules))
}

// The path rules a shell command breaks, from the paths it names: `rm` and
// `git rm` delete; `mv` deletes its sources and writes its destination;
// redirects, `tee`, `touch`, `cp`, `sed -i` and the like write, a create or an
// edit by whether the file is there. A copy or move into a folder writes the
// names it puts there. Indirect writes (scripts, build tools, `xargs` fed by a
// pipe, `find -exec`) never reach this layer; the backstop looks for them.
// PowerShell's file cmdlets (Set-Content, Remove-Item, Move-Item…) are read
// the same way (powershell.ts).
async function shellHits($: EngineInterface, tool: ShellTool, command: string, context: ScopeContext, rules: readonly ActivePathRule[]): Promise<PathRuleHit[]> {
  if (rules.length === 0) return []
  const hits: PathRuleHit[] = []
  const changes = tool === 'PowerShell' ? powerShellPathOps(command, context) : commandPathOps(command, context)
  for (const change of changes.slice(0, 50)) {
    if (change.op === 'delete') {
      hits.push(...matchPathRules(change.path, ['delete'], rules))
      continue
    }
    const isFolder = change.into.length > 0 && (await $.fs.stat(change.path).catch(() => undefined))?.kind === 'dir'
    for (const path of isFolder ? change.into.map(name => `${change.path}/${name}`) : [change.path]) {
      const candidates = matchPathRules(path, ['create', 'edit', 'delete'], rules)
      if (candidates.length > 0) hits.push(...matchPathRules(path, await opsForWrite($, path), rules))
    }
  }
  return hits
}

// A path rule's refusal: a toast naming the rule, its source and the layer,
// and the denial Claude reads.
function refusePathRule($: EngineInterface, tool: string, hits: readonly PathRuleHit[], layer: GuardLayer): string {
  const first = hits[0]!
  const source = first.rule.source.kind === 'order' ? `order ${first.rule.source.id}` : 'a standing rule'
  $.ui.toast(`Path rule (${source}, ${layer} layer) blocked ${tool}: ${first.op} ${first.path} matches ${first.rule.glob}.`)
  return pathRuleDenial(hits, layer)
}

// Asking the owner. The engine fires classic.PreToolUse inside tool.call's
// next(e), carrying the call's tool_use_id but not its agent: so tool.call
// (which knows the agent) decides, and for the owner's own call leaves the
// question here for the PreToolUse hook to put. Its ask is a floor the engine
// keeps in every mode. Until a PreToolUse has been seen in this process, an
// owner's refused call is denied instead (with the way out), so a call is
// never let through unasked on an engine that doesn't fire the hook.
const pendingOwnerAsks = new Map<string, string>()
let hasSeenPreToolUse = false

const askKeysOf = (tool: string, input: Record<string, unknown>): string[] => {
  const command = shellCommandOf(input)
  return [...(typeof input.tool_use_id === 'string' ? [`id:${input.tool_use_id}`] : []), ...(command === undefined ? [] : [`cmd:${tool}\0${command}`])]
}

function leaveOwnerAsk(tool: string, input: Record<string, unknown>, question: string): void {
  if (pendingOwnerAsks.size > 50) pendingOwnerAsks.clear()
  for (const key of askKeysOf(tool, input)) pendingOwnerAsks.set(key, question)
}

// Whether the question left for this call is still waiting (then forgets it).
function takeOwnerAsk(tool: string, input: Record<string, unknown>): string | undefined {
  let question: string | undefined
  for (const key of askKeysOf(tool, input)) {
    question ??= pendingOwnerAsks.get(key)
    pendingOwnerAsks.delete(key)
  }
  return question
}

// The classic.PreToolUse hook for Bash and PowerShell: puts a question left for this call.
function preToolUseQuestion(tool: ShellTool, input: Record<string, unknown>): { ask: string } | undefined {
  hasSeenPreToolUse = true
  const question = takeOwnerAsk(tool, input)
  return question === undefined ? undefined : { ask: question }
}

// Who made a call: a subagent (a council order's agent or any other) can't be
// asked, so what the guard refuses is denied; the owner is asked instead.
type CallOrigin = { agentId: string | undefined; order: CarriedOrder | undefined }

// What the guard says about a call: nothing (it runs), a denial, or (for the
// owner's own shell call) a question, with the denial to give instead when
// the question can't be put.
type GuardResult = undefined | string | { ask: string; deny: string }

// Returns the denial Claude reads, or undefined to let the call run. Called
// only for the tools it polices, with the context already read. File tools:
// the scope and the path rules. Shell tools: the inline-code ban, the scope,
// the path rules, then the policy judge.
async function guardToolCall(
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>,
  context: ScopeContext,
  rules: readonly ActivePathRule[] = [],
  origin: CallOrigin = { agentId: undefined, order: undefined },
): Promise<GuardResult> {
  let verdict: GuardVerdict = { kind: 'allow' }
  const isFileEdit = FILE_TOOLS.has(tool)
  const isAgent = origin.agentId !== undefined

  if (isFileEdit) {
    const filePath = textField(input.file_path) ?? textField(input.notebook_path)
    if (!filePath) return undefined
    if (context.folders.length > 0) verdict = checkFileEdit(filePath, context)
    if (verdict.kind !== 'block') {
      const hits = await fileToolHits($, filePath, context, rules)
      if (hits.length > 0) return refusePathRule($, tool, hits, 'file tool')
    }
  } else if (isShellTool(tool)) {
    const command = shellCommandOf(input)
    if (!command) return undefined
    // Deterministic refusals first: the inline-code ban, the scope, the path rules.
    const first = decideShell(tool, command, context, { isInlineBanEnabled: settings.isInlineCodeBanEnabled })
    if (first.kind === 'refuse') countGuardDecision($, first, { judged: false }, origin.agentId ?? 'owner')
    if (first.kind === 'refuse' && first.via === 'inline') {
      if (isAgent) $.ui.toast(`Guard refused ${tool}: inline interpreter code (${first.finding.shape}).`)
      return isAgent ? inlineCodeDenial(first.finding, true) : { ask: inlineCodeQuestion(first.finding), deny: inlineCodeDenial(first.finding, false) }
    }
    if (first.kind === 'refuse' && first.via === 'scope') verdict = first.verdict
    else {
      const hits = await shellHits($, tool, command, context, rules)
      if (hits.length > 0) return refusePathRule($, tool, hits, tool)
      // Then the judge.
      const decision = await judgeShellCall($, tool, command, context, origin)
      if (decision.kind === 'refuse' && decision.via !== 'inline' && decision.via !== 'scope') {
        if (isAgent) $.ui.toast(policyToast(tool, decision))
        return isAgent ? policyDenial(decision, true) : { ask: policyQuestion(decision), deny: policyDenial(decision, false) }
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

// ── The path rules' backstop ──────────────────────────────────────────────

const BACKSTOP_STORE_PREFIX = 'backstop:'
const backstopStoreKey = (agentId: string) => `${BACKSTOP_STORE_PREFIX}${agentId}`

// Raw git output (NUL-separated lists keep their leading spaces), or undefined.
async function gitOutput($: EngineInterface, folder: string, args: string[]): Promise<string | undefined> {
  const result = await $.process.run(['git', '-C', folder, ...args], { timeoutMs: 3000 }).catch(() => undefined)
  return result?.exitCode === 0 ? result.stdout : undefined
}

// The content hash of each path (relative to the top), '' for one that's gone.
async function hashesOf($: EngineInterface, top: string, changes: readonly Change[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  const present = changes.filter(change => change.op !== 'delete').map(change => change.path)
  for (const change of changes) hashes[change.path] = ''
  if (present.length === 0) return hashes
  const lines = ((await gitOutput($, top, ['hash-object', '--', ...present])) ?? '').split('\n')
  present.forEach((path, index) => (hashes[path] = lines[index]?.trim() ?? ''))
  return hashes
}

// At an order agent's first tool call: if its order or the standing rules
// forbid any paths, record where its repo starts (HEAD, and the matching paths
// already changed then inside its own folder). Kept in the store, so a reload mid-run keeps it.
async function startBackstop($: EngineInterface, agentId: string): Promise<void> {
  const order = await councilOrder($, agentId)
  if (order === undefined) return
  backstopsStarted.add(agentId)
  if ((await $.store.get(backstopStoreKey(agentId))) !== undefined) return
  const rules = await activePathRules($, await $.session.root(), order)
  if (rules.length === 0) return
  const [top, head, scope] = await Promise.all([
    git($, order.folder, ['rev-parse', '--show-toplevel']),
    git($, order.folder, ['rev-parse', 'HEAD']),
    git($, order.folder, ['rev-parse', '--show-prefix']),
  ])
  if (!top || !head || scope === undefined) return void $.ui.toast(`Path rules backstop: ${order.id}'s folder is not a git repository with a commit, so what it changes won't be checked when it stops.`)
  const status = await gitOutput($, top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', scopePathspec(scope)])
  const dirty = await hashesOf($, top, dirtyMatches(withinScope(parseStatus(status ?? ''), scope), top, rules))
  const baseline: Baseline = { orderId: order.id, folder: order.folder, top, scope, start: head, rules, dirty, startedAt: await $.clock.now() }
  await $.store.set(backstopStoreKey(agentId), baseline)
}

// When an order's agent stops: what changed since its start that a rule
// forbids, as the warning for the main session (and a toast), or undefined.
async function finishBackstop($: EngineInterface, agentId: string): Promise<string | undefined> {
  backstopsStarted.delete(agentId)
  const stored = await $.store.get(backstopStoreKey(agentId))
  if (stored === undefined) return undefined
  await $.store.delete(backstopStoreKey(agentId))
  if (!isBaseline(stored)) return undefined
  const [diff, untracked] = await Promise.all([
    gitOutput($, stored.top, ['diff', '--name-status', '--no-renames', '-z', stored.start, '--', scopePathspec(stored.scope)]),
    gitOutput($, stored.top, ['ls-files', '--others', '--exclude-standard', '-z', '--', scopePathspec(stored.scope)]),
  ])
  if (diff === undefined || untracked === undefined) {
    $.ui.toast(`Path rules backstop: git could not list what ${stored.orderId} changed, so its forbidden paths were not checked at its stop.`)
    return undefined
  }
  const flagged = flaggedChanges(withinScope(changesSince(parseNameStatus(diff), untracked.split('\0').filter(Boolean)), stored.scope), stored.top, stored.rules)
  const wasDirty = flagged.filter(entry => entry.path in stored.dirty)
  const hashNow = wasDirty.length === 0 ? {} : await hashesOf($, stored.top, wasDirty.map(entry => ({ path: entry.path, op: entry.hits[0]!.op })))
  const fresh = newSinceStart(flagged, stored.dirty, hashNow, stored.top, stored.rules)
  const warning = backstopWarning(stored, fresh)
  if (warning !== undefined) $.ui.toast(backstopToast(stored.orderId, fresh))
  return warning
}

// Baselines of agents that never stopped (a crash, a closed session).
async function pruneBackstops($: EngineInterface): Promise<void> {
  const [now, keys] = await Promise.all([$.clock.now(), $.store.keys()])
  for (const key of keys.filter(key => key.startsWith(BACKSTOP_STORE_PREFIX))) {
    const startedAt = ((await $.store.get(key)) as { startedAt?: unknown } | undefined)?.startedAt
    if (typeof startedAt !== 'number' || now - startedAt > BACKSTOP_RETENTION_MS) await $.store.delete(key)
  }
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
  // Path rules are the person's own words: the review never suggests one.
  if (rule === undefined || rule.kind === 'forbid') return
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
      return [
        rules.length === 0
          ? 'No long-lived rules. The bar offers one after the scope guard blocks something; /rules add fence <folder>, /rules add exclusive <a> <b>, /rules add forbid <glob> [create,edit,delete] <reason> or /rules add policy <sentence> adds one.'
          : `Rules (in .claude/settings.local.json; policy sentences are for the guard's judge):\n${rules.map((rule, index) => `${index + 1}. ${describeRule(rule, root)}`).join('\n')}`,
        `Default policy (ships with sidekick): ${DEFAULT_POLICY.join(' ')}`,
      ].join('\n')
    case 'add': {
      const rule = parseRule(rest.join(' '), root)
      return rule === undefined ? 'Usage: /rules add fence <folder> | /rules add exclusive <folder> <folder> | /rules add forbid <glob> [create,edit,delete] <reason> | /rules add policy <sentence>' : addRule($, root, rule)
    }
    case 'remove': {
      const index = Number(rest[0]) - 1
      const removed = rules[index]
      if (removed === undefined) return 'Usage: /rules remove <number from /rules list>'
      await $.store.set(rulesStoreKey(root), rules.filter((_, position) => position !== index))
      return `Removed: ${describeRule(removed, root)}. ${await applyRules($, root)}`
    }
    default:
      return 'Usage: /rules [list | add fence <folder> | add exclusive <folder> <folder> | add forbid <glob> [ops] <reason> | add policy <sentence> | remove <n>]'
  }
}

async function scopeCommand($: EngineInterface, args: string): Promise<string> {
  const [action = 'show', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const argument = rest.join(' ')
  const root = await $.session.root()
  const scope = await read($, scopeAtom)

  switch (action) {
    case 'show': {
      const policy = assemblePolicy(standingPolicy(await readRules($, root)))
      return [
        `Scope: ${describeScope({ root, folders: scope.folders })}. Guard ${settings.isScopeGuardEnabled ? 'on' : 'off'}${scope.folders.length === 0 ? ', idle until /scope set or add' : ''}.`,
        `Inline-code ban ${settings.isInlineCodeBanEnabled ? 'on' : 'off'}. Policy judge: ${judgeStatusText()}.`,
        `Policy (${policy.length}): ${policy.map(rule => rule.text).join(' ')}`,
        metricsText(guardMetrics),
      ].join('\n')
    }
    case 'judge': {
      const word = rest[0]?.toLowerCase()
      if (word !== 'on' && word !== 'off') return `Usage: /scope judge on|off. Policy judge: ${judgeStatusText()}.`
      isJudgeOffForSession = word === 'off'
      const key = judgeOffStoreKey(await $.session.id())
      if (isJudgeOffForSession) await $.store.set(key, { savedAt: await $.clock.now() })
      else await $.store.delete(key)
      return `Policy judge: ${judgeStatusText()}.${isJudgeOffForSession ? ' The inline-code ban, the scope and the path rules still hold.' : ''}`
    }
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
    case 'usage':
      return scopeUsage($, rest)
    default:
      return 'Usage: /scope [show | set <folder> | add <folder> | remove <folder> | clear | judge on|off | usage [since YYYY-MM-DD]]'
  }
}

// ── Usage ─────────────────────────────────────────────────────────────────
//
// Every model call sidekick makes goes through completeModel, which records
// its purpose, model and tokens in the session's ledger (a `model` entry),
// after the call and without holding it up. Recording never fails the call:
// a failure is toasted once a session.

// What a call is for: judge, stop-review, tldr, heads-up, rule, brief or handoff.
type ModelUse = { purpose: string; agentId?: string; orderId?: string }

let usageSession: string | undefined
let isUsageFailureToasted = false

async function completeModel($: EngineInterface, use: ModelUse, request: ModelCompleteRequest): Promise<ModelCompleteResult> {
  const reply = await $.model.complete(request)
  void noteModelCall($, use, request.model, request.effort, reply.usage)
  return reply
}

async function noteModelCall($: EngineInterface, use: ModelUse, model: string, effort: string | number | undefined, usage: ModelUsage | undefined): Promise<void> {
  try {
    const [at, session] = await Promise.all([ledgerNow($), usageSession ?? $.session.id()])
    usageSession = session
    recordEntry($, modelEntry({ at, purpose: use.purpose, model, effort, session, usage, agentId: use.agentId, orderId: use.orderId }))
  } catch (error) {
    if (isUsageFailureToasted) return
    isUsageFailureToasted = true
    try {
      $.ui.toast(`Sidekick: a model call's usage could not be recorded (${error instanceof Error ? error.message : String(error)}); nothing else is affected.`)
    } catch {
      // Nothing more to do.
    }
  }
}

// /scope usage [since YYYY-MM-DD]: sidekick's own calls by purpose, read
// from every session's ledger on this machine (this session's written first).
async function scopeUsage($: EngineInterface, words: readonly string[]): Promise<string> {
  const now = await $.clock.now()
  const since = parseSince(words, now)
  if ('error' in since) return since.error
  const home = await readHome($)
  if (!home) return `Sidekick's usage is not recorded: ${NO_HOME}.`
  if (!settings.isSummaryEnabled) return "Sidekick's usage is not recorded: it is kept in the TL;DR record (the ledger), which is off. For the whole split, run /council usage."
  await flushLedger($)
  const base = `${home}/${LEDGER_FOLDER}`
  // Every session's folder (a folder's own time moves only when a file is added): its recent segments.
  const sessions = (await $.fs.list(base).catch(() => [])).filter(entry => entry.kind === 'dir' && !entry.isLink)
  const texts = await Promise.all(
    sessions.map(async session => {
      const folder = `${base}/${session.name}`
      const files = (await $.fs.list(folder).catch(() => [])).filter(file => file.kind === 'file' && !file.isLink && file.mtimeMs >= since.since && segmentIndex(file.name) !== undefined)
      return Promise.all(files.map(file => $.fs.read(`${folder}/${file.name}`).catch(() => '')))
    }),
  )
  return scopeUsageReport(texts.flat(2).flatMap(modelEntries), since, now)
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

// ── Asking Codex and Antigravity ──────────────────────────────────────────

// PATH and PATHEXT as the engine sees them (Windows spells it Path).
async function pathEnvironment($: EngineInterface): Promise<{ path: string | undefined; pathExt: string | undefined }> {
  const [upper, mixed, pathExt] = await Promise.all([
    $.env.get('PATH').catch(() => undefined),
    $.env.get('Path').catch(() => undefined),
    $.env.get('PATHEXT').catch(() => undefined),
  ])
  return { path: upper || mixed || undefined, pathExt: pathExt || undefined }
}

// Looks for each CLI once and registers a tool only for those found.
async function registerAskTools($: EngineInterface): Promise<void> {
  askPaths.clear()
  if (!settings.isAskToolsEnabled) return
  const environment = await pathEnvironment($)
  const host = { isFile: (path: string) => $.fs.stat(path, { resolve: true }).then(stat => stat.kind === 'file', () => false) }
  for (const cli of ASK_CLIS) {
    const found = await findOnPath(host, cli.command, environment).catch(() => undefined)
    if (found !== undefined) askPaths.set(cli.id, found)
  }
  // One literal call per tool: the engine reads the names off the source.
  if (askPaths.has('codex')) await $.tool.register({ name: 'ask_codex', description: askDescription(askCliFor('codex')), inputSchema: ASK_SCHEMA, isDeferred: false })
  if (askPaths.has('agy')) await $.tool.register({ name: 'ask_agy', description: askDescription(askCliFor('agy')), inputSchema: ASK_SCHEMA, isDeferred: false })
}

async function runAsk($: EngineInterface, id: AskCliId, input: Record<string, unknown>): Promise<AskOutcome> {
  const cwd = await $.session.cwd().catch(() => undefined)
  return askCli({ run: (argv, init) => $.process.run(argv, init) }, askCliFor(id), askPaths.get(id), promptOf(input), cwd)
}

const askResult = (outcome: AskOutcome) => (outcome.isError ? { result: outcome.text, isError: true as const } : { result: outcome.text })

// ── Hooks ─────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // One literal call per command: the engine reads the names off the source.
    if (settings.isReplayEnabled) await $.command.register({ name: 'replay', description: "Step through the last turn's file edits" })
    if (settings.isSummaryEnabled) await $.command.register({ name: 'tldr', description: 'Brief what happened: the last turn, since the last brief, or the whole session', argumentHint: '[last|since|full]' })
    await $.command.register({ name: 'heads-up', description: 'Review the last answer for something you should know, or list/forget topics marked known', argumentHint: '[now|known|forget]' })
    await $.command.register({ name: 'scope', description: "Show or change this session's target folders and its policy judge", argumentHint: '[show|set <folder>|add <folder>|remove <folder>|clear|judge on|off|usage [since YYYY-MM-DD]]' })
    // Looked for afresh each start (the council mod may have been turned off).
    await update($, hasCouncilAtom, () => false)
    void detectCouncil($)
      .then(isFound => (isFound ? true : $.clock.sleep(3000).then(() => detectCouncil($))))
      .catch(() => undefined)
    await $.command.register({ name: 'rules', description: "Long-lived rules in Claude Code's own settings: list, add or remove", argumentHint: '[list|add fence <folder>|add exclusive <a> <b>|add forbid <glob> [ops] <reason>|add policy <sentence>|remove <n>]' })
    if (settings.isSummaryEnabled) await openLedger($).catch(() => undefined)
    const root = await $.session.root()
    await restoreScope($, root)
    await restoreJudgeOff($).catch(() => undefined)
    hasSeenPreToolUse = false
    pendingOwnerAsks.clear()
    recentCommands.clear()
    judgeState = newJudgeState()
    agentOrders.clear()
    metricsChanges = 0
    await restoreMetrics($).catch(() => undefined)
    await pruneBackstops($).catch(() => undefined)
    // The rules are the source of truth; the settings file is made to match.
    await (async () => writeRules($, root, await readRules($, root), await storedStyle($, root)))().catch((error: unknown) =>
      $.ui.toast(`Sidekick could not sync its rules into .claude/settings.local.json, so they are not enforced: ${error instanceof Error ? error.message : String(error)}`),
    )
    await registerAskTools($).catch(() => undefined)
    return result
  })

  // ask_codex and ask_agy: every call waits for the person, in every mode.
  // A PreToolUse hook's ask is a floor the engine keeps even in auto mode (its
  // classifier can't approve past it, and an allow rule doesn't skip it); the
  // tool.check ask says the same to every other check of the call. Both carry
  // the full prompt, which the dialog shows. A failure still asks.
  on('classic.PreToolUse', { tool: 'mcp__sidekick__ask_codex' }, ($, e) => ({ ask: approvalText(askCliFor('codex'), promptOf(e as unknown as Record<string, unknown>)) })).catch(() => ({
    ask: approvalText(askCliFor('codex'), undefined),
  }))
  on('classic.PreToolUse', { tool: 'mcp__sidekick__ask_agy' }, ($, e) => ({ ask: approvalText(askCliFor('agy'), promptOf(e as unknown as Record<string, unknown>)) })).catch(() => ({
    ask: approvalText(askCliFor('agy'), undefined),
  }))
  on('tool.check', { tool: 'mcp__sidekick__ask_codex' }, ($, e) => ({ decision: 'ask' as const, reason: approvalText(askCliFor('codex'), promptOf(e as unknown as Record<string, unknown>)) })).catch(() => ({
    decision: 'ask' as const,
  }))
  on('tool.check', { tool: 'mcp__sidekick__ask_agy' }, ($, e) => ({ decision: 'ask' as const, reason: approvalText(askCliFor('agy'), promptOf(e as unknown as Record<string, unknown>)) })).catch(() => ({
    decision: 'ask' as const,
  }))
  on('tool.call', { tool: 'mcp__sidekick__ask_codex' }, async ($, e) => askResult(await runAsk($, 'codex', e as unknown as Record<string, unknown>))).catch(() => ({
    result: 'sidekick could not run Codex for this call; tell the person.',
    isError: true as const,
  }))
  on('tool.call', { tool: 'mcp__sidekick__ask_agy' }, async ($, e) => askResult(await runAsk($, 'agy', e as unknown as Record<string, unknown>))).catch(() => ({
    result: 'sidekick could not run Antigravity for this call; tell the person.',
    isError: true as const,
  }))

  // The owner's own shell calls: a question tool.call left for this call is
  // put here, before the tool runs (see leaveOwnerAsk). A failure here asks
  // anyway when a question was left, rather than letting the call through.
  on('classic.PreToolUse', { tool: 'Bash' }, ($, e, next) => preToolUseQuestion('Bash', e as unknown as Record<string, unknown>) ?? next(e)).catch(($, e, next) =>
    takeOwnerAsk('Bash', e as unknown as Record<string, unknown>) !== undefined ? { ask: 'Sidekick could not finish checking this command. Allow it?' } : next(e),
  )
  on('classic.PreToolUse', { tool: 'PowerShell' }, ($, e, next) => preToolUseQuestion('PowerShell', e as unknown as Record<string, unknown>) ?? next(e)).catch(($, e, next) =>
    takeOwnerAsk('PowerShell', e as unknown as Record<string, unknown>) !== undefined ? { ask: 'Sidekick could not finish checking this command. Allow it?' } : next(e),
  )

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
    const isGuarded = settings.isScopeGuardEnabled && (FILE_TOOLS.has(tool) || isShellTool(tool))
    const isRecorded = settings.isReplayEnabled && isEditTool(tool)
    const isLedgered = settings.isSummaryEnabled
    const agentId = typeof e.agentId === 'string' ? e.agentId : undefined
    // An order agent's first call (any tool, before it changes anything):
    // where its repo starts, for the path rules' backstop at its stop.
    if (agentId !== undefined && settings.isScopeGuardEnabled && !backstopsStarted.has(agentId)) await startBackstop($, agentId).catch(() => undefined)
    // With the TL;DR off, every other tool passes untouched, with no lookups.
    if (!isGuarded && !isRecorded && !isLedgered) return next(e)
    const input = e as unknown as Record<string, unknown>

    let context: ScopeContext | undefined
    let askedOwner = false
    if (isGuarded) {
      let denial: string | undefined
      try {
        context = await scopeContext($)
        // A council knight or scout is held to its order's folder instead,
        // and to its order's path rules beside the standing ones.
        const order = agentId !== undefined ? await councilOrder($, agentId) : undefined
        if (order !== undefined) context = { ...context, folders: [order.folder] }
        if (order !== undefined && agentId !== undefined && !agentOrders.has(agentId)) {
          if (agentOrders.size > 50) agentOrders.delete(agentOrders.keys().next().value!)
          agentOrders.set(agentId, order)
        }
        const rules = await activePathRules($, context.root, order)
        const verdict = await guardToolCall($, tool, input, context, rules, { agentId, order })
        if (typeof verdict === 'object') {
          // The owner's own call: asked by the PreToolUse hook inside next(e),
          // once that hook is known to fire; refused until then.
          if (hasSeenPreToolUse) {
            leaveOwnerAsk(tool, input, verdict.ask)
            askedOwner = true
          } else denial = verdict.deny
        } else denial = verdict
      } catch {
        // A guard that can't check fails closed. Claude can retry; if it keeps
        // failing, the user turns the guard off (scopeGuardEnabled) or clears the scope.
        denial =
          'The sidekick scope guard hit an internal error while checking this call and blocked it to be safe. Retry it once; if it is blocked again, stop and tell the user the scope guard is failing (they can run /scope clear or turn off scopeGuardEnabled).'
        $.ui.toast('Scope guard error: the call was blocked.')
      }
      const command = isShellTool(tool) ? shellCommandOf(input) : undefined
      if (command !== undefined) rememberCommand(agentId ?? 'owner', tool, command, denial === undefined ? 'ran' : 'refused')
      if (denial !== undefined) {
        if (isLedgered) await recordCall($, { tool, input, agentId, startedAt: undefined, steps: [], result: { deny: denial } }).catch(() => undefined)
        return { deny: denial }
      }
    }

    if (!isRecorded && !isLedgered && !askedOwner) return next(e)
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
    // The question was never put: the engine ran the call without its PreToolUse hook.
    if (askedOwner && takeOwnerAsk(tool, input) !== undefined) $.ui.toast(`Sidekick could not ask you about that ${tool} call before it ran (no PreToolUse hook fired).`)
    if (isRecorded && result.deny === undefined && result.isError !== true) pendingSteps.push(...steps)
    if (isLedgered) await recordCall($, { tool, input, agentId, startedAt, steps, result }).catch(() => undefined)
    return result
  }).catch(($, e, next) => {
    // The hook failed or ran out of time: a guarded call it hadn't let through
    // is refused (fail closed); anything else goes on.
    if (next.called) return next(e)
    const isGuarded = settings.isScopeGuardEnabled && (FILE_TOOLS.has(String(e.tool)) || isShellTool(String(e.tool)))
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
    // An order agent's stop: the path rules' backstop. Its warning goes to the
    // main session with the agent's report (and to the council's copy of it).
    // Beside it, the policy judge's review of its whole command log.
    if (e.agentId !== undefined) {
      const [backstop, review] = await Promise.all([finishBackstop($, e.agentId).catch(() => undefined), reviewAgentRun($, e.agentId).catch(() => undefined)])
      await flushMetrics($).catch(() => undefined)
      const warnings = [backstop, review].filter((note): note is string => note !== undefined)
      if (warnings.length === 0) return next(e)
      const warning = warnings.join('\n\n')
      const answer = 'answer' in e && typeof e.answer === 'string' ? e.answer : undefined
      const result = await next(answer !== undefined ? ({ ...e, answer: `${answer}\n\n${warning}` } as typeof e) : e)
      const text = (result as { text?: unknown }).text
      return typeof text === 'string' && !text.includes(BACKSTOP_MARK) && !text.includes(REVIEW_MARK) ? { ...result, text: `${text}\n\n${warning}` } : result
    }
    const result = await next(e)
    await flushMetrics($).catch(() => undefined)
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
