// council: a herald briefs, five advisors (security, money, reasonableness,
// legal, vibes) each weigh one concern, with animated pixel portraits.
// /council <question> briefs from this conversation (a fork); /council review
// [folder] <ref> briefs from a repo's work since the ref; /council reconsider
// adds context to an adjourned council. Settings: plugin.json's userConfig.
//
// Every function that touches `$` is declared at the top level of this file:
// the engine follows `$` only into functions declared in the hooks module
// itself. Everything else lives beside it as pure code.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteRequest, ModelCompleteResult, ModelForkRequest, ModelForkResult, ModelUsage, Register, RenderInput, Timer, TurnUsage } from 'claude-code'

import type { AdvisorId, AdvisorQuestion, AdvisorReport, AdvisorRun, AdvisorRunStatus, Council, Court, CourtSummons, DocketEntry, DocketFilter, DocketView, LearningView, Order, Roster, RulingSummons, Seat } from '../types'
import {
  ADVISOR_TYPE,
  SUMMONS_TIMEOUT_MS,
  advisorDigest,
  advisorTask,
  findingsContext,
  finishedRun,
  isAdvisorFinished,
  isClearable,
  isFoldable,
  isAdvisorPath,
  nextAdvisorNumber,
  parseCheck,
  readAdviseArgs,
  summonsDue,
  summonsQuestions,
  withAdvisorChanged,
  withStaleAdvisors,
  withUnstartedAdvisors,
} from './advisors'
import {
  advisorPrompt,
  advisorSystemPrompt,
  findAdvisor,
  followUpPrompt,
  heraldForkPrompt,
  newCouncil,
  seatsOf,
  REPORT_SYSTEM,
  councilRecord,
  reconsiderPrompt,
  CONSULT_DESCRIPTION,
  CONSULT_SCHEMA,
  consultText,
  readConsult,
  reportPrompt,
  withAdvisorsDeliberating,
  withFollowUpRecorded,
  withReconsidering,
  withVerdict,
} from './council'
import {
  EMPTY_TREE,
  FETCH_MARKERS,
  GIT,
  PICK_FILES_SYSTEM,
  REVIEW_BRIEF_SYSTEM,
  REVIEW_LIMITS,
  cap,
  contextFiles,
  describeRef,
  fetchAge,
  parsePickedFiles,
  parseReviewArgs,
  pickFilesPrompt,
  projectMap,
  reviewBriefPrompt,
  reviewFolderCandidate,
  type ReviewMaterial,
  type ReviewRequest,
} from './review'
import { readSettings, type CouncilSettings, type ModelEffort } from './settings'
import { TICK_MS, animatedSvg, moodFor, rasterCells, roadSvg, roadText, spriteFrame, type Appearance } from './sprites'
import {
  AGENT_TYPES,
  PROGRESS_DESCRIPTION,
  PROGRESS_SCHEMA,
  PROGRESS_TOOL,
  PROPOSE_ORDERS_DESCRIPTION,
  PROPOSE_ORDERS_SCHEMA,
  WITHDRAW_ORDERS_DESCRIPTION,
  WITHDRAW_ORDERS_SCHEMA,
  dispatchPrompt,
  emptyCourt,
  isFinished,
  isInside,
  isOpen,
  matchOrder,
  newOrders,
  progressOf,
  proposalBrief,
  readProposal,
  readTodos,
  readWithdrawal,
  withExpired,
  withOrdersAdded,
  withdrawOrders,
  withdrawalText,
  councilDigest,
  withFinishedFolded,
  namesWholeCouncil,
  parseTriage,
  triagePrompt,
  TRIAGE_SYSTEM,
  ruling,
  rulingText,
  arbiterPrompt,
  arbiterSeat,
  needsArbiter,
  parseArbiterReply,
  withArbiterReview,
  conditionAtOf,
  REFUSE_AT,
  SETTLE_ORDER_DESCRIPTION,
  SETTLE_ORDER_SCHEMA,
  claimHolderText,
  clashReason,
  holdsClaim,
  knightClash,
  moved,
  readSettlement,
  releaseOrder,
  settleOrder,
  turnEvent,
  unsettledLine,
  wakeVerdict,
  nextStatus,
  levelOf,
  orderAsk,
  orderLevels,
  relativeFolder,
  repoCandidates,
  setOrderLevel,
  withLostAgents,
  joinedReport,
  heldRefusal,
  heldText,
  summonsRuledLine,
  isLeavePending,
  leaveOnApproval,
  leaveRefusal,
  ruleOnLeave,
  type OrderEvent,
  type ArbiterDecision,
  type Place,
  type Proposal,
  type RulingResult,
} from './court'
import {
  AMEND_ORDER_DESCRIPTION,
  AMEND_ORDER_SCHEMA,
  RECALL_ALLOWED_TOOLS,
  RECALL_ORDER_DESCRIPTION,
  RECALL_ORDER_SCHEMA,
  amendRefusal,
  amendmentBrief,
  amendmentResultText,
  amendmentText,
  blockedSendReason,
  isUnderWay,
  messageRefusal,
  orderForRecipient,
  pendingAmendment,
  personMessageText,
  readAmendment,
  readRecall,
  recallDenial,
  recallNotice,
  recallOrder,
  recallReply,
  recallStep,
  recallText,
  recalledLine,
  recalledReport,
  withAmendmentRuled,
  withMessage,
  withTouched,
  withoutAmendment,
  type RecallRequest,
} from './control'
import { NO_HOME, homeFromEnvironment, joinUnder, pathStyleOf } from './paths'
import {
  DOCKET_LIMITS,
  DOCKET_LOCK,
  consultOutcome,
  dayFileName,
  docketDispatches,
  docketEntries,
  docketFile,
  docketId,
  docketPage,
  docketPaths,
  findingsSummary,
  formatLock,
  isDayFileName,
  isLockHeld,
  offsetOf,
  parseLock,
  projectKey,
  prunedFiles,
  sealEntry,
  sittingFields,
  withEntryAppended,
  type DocketPaths,
} from './docket'
import { docketView } from './views/docket'
import { carryCalls, creditCall, sitesOf } from './tally'
import { courtView } from './views/court'
import { lessonsView } from './views/lessons'
import {
  EVERYWHERE,
  SUMMARY_SYSTEM,
  formatGuidance,
  formatLessons,
  formatProposal,
  isSummaryDue,
  lessonFromReconsider,
  mergeGuidance,
  parseGuidance,
  parseLessons,
  parseProposal,
  parseSummary,
  standingContext,
  summaryPrompt,
} from './learning'
import { councilView, portraitFor, rosterView } from './views/council'
import { MAX_SEATS, memberId, mergeMembers, parseMemberFile, resolveReference, seatOf, seatedMembers, trimReferences, tuningFiles, tuningSummary, BUILT_IN_MEMBERS, type MemberDefinition } from './members'
import { conditionAt, mergeProfiles, parseProfile, profileContext, profileReport, type Profile, type ProfileFields, type ProfileSource } from './profile'
import { removeInside, type RemoveHost } from './remove'
import {
  SIDEKICK_LEDGERS,
  STEP_FLUSH_EVERY,
  USAGE_FOLDER,
  addTokens,
  callRecord,
  dayOf,
  expiredUsageFiles,
  foldCalls,
  isUsageFileName,
  parseSince,
  parseUsageFile,
  serializeUsage,
  sidekickRecords,
  stepKey,
  tokensOf,
  usageFileName,
  usageReport,
  withStepsAdded,
  ZERO,
  type AgentKind,
  type StepCategory,
  type StepTotal,
  type Tokens,
  type UsageRecord,
} from './usage'

const COUNCIL_PANE_ID = 'council-chamber'
const DEFAULT_COUNCIL_TOPIC = 'The work in progress in this session: is the current approach sound?'

const councilAtom = atom({ plugin: 'council', key: 'council' } as const, null as Council | null)
const isRosterOpenAtom = atom({ plugin: 'council', key: 'isRosterOpen' } as const, false)
const rosterAtom = atom({ plugin: 'council', key: 'roster' } as const, null as Roster | null)
const courtAtom = atom({ plugin: 'council', key: 'court' } as const, emptyCourt() as Court)
const isChamberShownAtom = atom({ plugin: 'council', key: 'isChamberShown' } as const, false)
const isLessonsOpenAtom = atom({ plugin: 'council', key: 'isLessonsOpen' } as const, false)
const learningAtom = atom({ plugin: 'council', key: 'learning' } as const, null as LearningView | null)
const openVerdictAtom = atom({ plugin: 'council', key: 'openVerdictId' } as const, null as string | null)
const isFinishedShownAtom = atom({ plugin: 'council', key: 'isFinishedShown' } as const, false)
const openOrderAtom = atom({ plugin: 'council', key: 'openOrderId' } as const, null as string | null)
const isDocketOpenAtom = atom({ plugin: 'council', key: 'isDocketOpen' } as const, false)
const docketAtom = atom({ plugin: 'council', key: 'docket' } as const, null as DocketView | null)

// Module state: rebuilt on every load (the council itself is in $.state).
let settings: CouncilSettings = readSettings({})
// Bumped by every convene, reconsider and dismissal: background work from an
// older council checks it before writing.
let councilGeneration = 0
let isCouncilWorking = false
let animationTimer: Timer | undefined
let animationTick = 0
let missedBlits = 0
let isBlitting = false
// Set while startAnimation awaits, so two overlapping starts make one timer.
let isStartingAnimation = false
const lastBlitCells = new Map<AdvisorId, string>()
// The seats whose portrait the terminal's chamber drew last: the only ones
// the timer repaints (a compact row has none).
const shownSprites = new Set<AdvisorId>()
// The effort each council agent's requests run at, by agent id (turn.step);
// rebuilt from the court's orders and runs after a reload.
const stepEfforts = new Map<string, string>()

// ── State ─────────────────────────────────────────────────────────────────

const updateCouncil = ($: EngineInterface, change: (council: Council) => Council) => update($, councilAtom, current => (current ? change(current) : current))

const updateAdvisor = ($: EngineInterface, id: AdvisorId, change: (report: AdvisorReport) => AdvisorReport) =>
  updateCouncil($, council => ({ ...council, advisors: { ...council.advisors, [id]: change(council.advisors[id]) } }))

// Terminal only (the desktop and other remote surfaces animate the SVG
// themselves); started by each terminal draw of the chamber, so a reload, a
// late-seated pane or a reopened one picks it up again.
function startAnimation($: EngineInterface): void {
  if (animationTimer !== undefined || isStartingAnimation) return
  isStartingAnimation = true
  missedBlits = 0
  lastBlitCells.clear()
  animationTimer = $.clock.every(TICK_MS, () => {
    animationTick++
    void blitSprites($).catch(() => undefined)
  })
  isStartingAnimation = false
}

function stopAnimation(): void {
  animationTimer?.cancel()
  animationTimer = undefined
}

// Repaints only the sprites whose frame changed, all at once, one pass at a time.
async function blitSprites($: EngineInterface): Promise<void> {
  if (isBlitting) return
  isBlitting = true
  try {
    const council = await read($, councilAtom)
    if (council === null || shownSprites.size === 0) return stopAnimation()
    const changed = seatsOf(council).flatMap(advisor => {
      const report = council.advisors[advisor.id]
      if (report === undefined || !shownSprites.has(advisor.id)) return []
      const cells = rasterCells(spriteFrame(advisor, moodFor(report, council.phase), animationTick))
      return lastBlitCells.get(advisor.id) === cells ? [] : [{ id: advisor.id, cells }]
    })
    const results = await Promise.all(
      changed.map(({ id, cells }) => $.ui.blit({ requestId: COUNCIL_PANE_ID, key: `sprite-${id}`, cells }).catch(() => ({ deny: 'failed' }))),
    )
    let isAnyDrawn = false
    results.forEach((result, index) => {
      if ('deny' in result && result.deny !== undefined) return
      isAnyDrawn = true
      lastBlitCells.set(changed[index]!.id, changed[index]!.cells)
    })
    // Pane closed, never drawn, or nothing moving (every advisor still): stop
    // after a few seconds; the next draw starts it again.
    missedBlits = isAnyDrawn ? 0 : missedBlits + 1
    if (missedBlits > 30) stopAnimation()
  } finally {
    isBlitting = false
  }
}

// The advisors' calls: the advisor model, or for a brain trust the deep one
// (with more room to answer, since higher effort thinks first).
const askAdvisorModel = ($: EngineInterface, use: ModelUse, isDeep: boolean | undefined, advisorSystem: string, prompt: string, maxTokens: number) =>
  completeModel($, use, {
    model: isDeep ? settings.deepModel : settings.advisorModel,
    effort: isDeep ? settings.deepEffort : settings.advisorEffort,
    system: advisorSystem,
    prompt,
    maxTokens: isDeep ? maxTokens * 4 : maxTokens,
    timeoutMs: isDeep ? 300000 : 120000,
  })

type BriefOutcome = { brief: string; notice?: string | null } | { failure: string }

// A plain council's brief: a fork of this conversation (main model, no tools,
// mostly served from the prompt cache).
async function forkBrief($: EngineInterface, topic: string): Promise<BriefOutcome> {
  const reply = await forkModel($, { purpose: 'herald' }, { prompt: heraldForkPrompt(topic) }).catch(() => undefined)
  if (reply?.isAnswered && reply.text.trim() !== '') return { brief: reply.text.trim() }
  return {
    failure:
      reply !== undefined && !reply.isAnswered && reply.reason === 'nothing-to-fork'
        ? 'there is no conversation to brief from yet (to review a repo, use /council review <ref>)'
        : 'the herald could not write a brief',
  }
}

// One git command in the repo; its output, or undefined when it failed.
async function git($: EngineInterface, cwd: string, argv: readonly string[]): Promise<string | undefined> {
  const result = await $.process.run(argv, { cwd, timeoutMs: 20000 }).catch(() => undefined)
  return result !== undefined && result.exitCode === 0 ? result.stdout : undefined
}

// A tracked file as committed at HEAD: what is being reviewed, never the
// working tree's edits, and never a symlink's target outside the repo.
async function readRepoFile($: EngineInterface, top: string, path: string, limit: number): Promise<string | undefined> {
  const text = await git($, top, GIT.showFile(path))
  return text === undefined ? undefined : cap(text, limit)
}

// A review's brief, from the repo alone: the commits and diff since the ref,
// a project map, the README and manifests, then up to five files the herald
// asks for, on the review model.
async function reviewBrief($: EngineInterface, project: string, request: ReviewRequest, isDeep = false): Promise<BriefOutcome> {
  const top = (await git($, project, GIT.topLevel))?.trim()
  if (!top) return { failure: `${project} is not a git repository (name the repo first: review <folder> <ref>)` }
  const base =
    request.ref.kind === 'commit'
      ? (await git($, top, GIT.verifyCommit(request.ref.ref)))?.trim()
      : // Nothing before that time: everything since the repo began counts.
        (await git($, top, GIT.baseBefore(request.ref.since)))?.trim() || ((await git($, top, GIT.firstCommit)) ? EMPTY_TREE : undefined)
  if (!base) return { failure: `git doesn't know "${describeRef(request.ref)}" in ${top}` }

  const [log, diffStat, patch, tracked, branch, commonDir] = await Promise.all([
    git($, top, GIT.log(base)),
    git($, top, GIT.diffStat(base)),
    git($, top, GIT.patch(base)),
    git($, top, GIT.trackedFiles),
    git($, top, GIT.branch),
    git($, top, GIT.commonDir),
  ])
  const trackedFiles = (tracked ?? '').split('\n').filter(Boolean)
  const context = (await Promise.all(contextFiles(trackedFiles).map(async path => ({ path, text: await readRepoFile($, top, path, 1500) })))).filter(
    (file): file is { path: string; text: string } => file.text !== undefined,
  )
  const material: ReviewMaterial = {
    question: request.question,
    ref: describeRef(request.ref),
    branch: branch?.trim() || 'HEAD',
    log: log ?? '',
    diffStat: diffStat ?? '',
    patch: '',
    map: projectMap(trackedFiles),
    context,
  }

  // The herald names the files it wants; the mod reads them, inside the repo only.
  const pick = await completeModel($, { purpose: 'brief' }, { model: isDeep ? settings.deepModel : settings.briefModel, effort: isDeep ? settings.deepEffort : 'low', system: PICK_FILES_SYSTEM, prompt: pickFilesPrompt(material), maxTokens: isDeep ? 2000 : 400, timeoutMs: isDeep ? 180000 : 60000 })
    .catch(() => undefined)
  const picked: Array<{ path: string; text: string }> = []
  let budget = REVIEW_LIMITS.files
  for (const path of pick?.isAnswered ? parsePickedFiles(pick.text, trackedFiles) : []) {
    if (budget <= 0) break
    const text = await readRepoFile($, top, path, Math.min(REVIEW_LIMITS.file, budget))
    if (text === undefined) continue
    budget -= text.length
    picked.push({ path, text })
  }

  const reply = await completeModel($, { purpose: 'brief' }, { model: isDeep ? settings.deepModel : settings.briefModel, effort: isDeep ? settings.deepEffort : 'medium', system: REVIEW_BRIEF_SYSTEM, prompt: reviewBriefPrompt(material, patch ?? '', picked), maxTokens: isDeep ? 3000 : 700, timeoutMs: isDeep ? 300000 : 120000 })
    .catch(() => undefined)
  if (!reply?.isAnswered || reply.text.trim() === '') return { failure: 'the herald could not write a brief' }
  const fetchTimes = commonDir
    ? await Promise.all(FETCH_MARKERS.map(marker => $.fs.stat(`${commonDir.trim()}/${marker}`).then(stat => stat.mtimeMs).catch(() => undefined)))
    : []
  const lastFetchMs = fetchTimes.filter((time): time is number => time !== undefined).sort((left, right) => right - left)[0]
  return { brief: reply.text.trim(), notice: fetchAge(lastFetchMs, await $.clock.now()) }
}

// The council's work, in the background: the brief, then all five advisors
// at once, each card turning as its verdict lands. Every write checks that
// this council is still the current one.
// `extra`: a sitting's own request beside the usual three lines (a ruling on
// orders: LEVEL and CHECK lines); `onReply`: each member's raw answer, for them.
// `use`: what its member calls are recorded as, when not a plain vote (member:<id>).
type Asking = { extra?: string; onReply?: (seatId: AdvisorId, text: string) => void; use?: ModelUse }

async function holdCouncil($: EngineInterface, generation: number, topic: string, seats: readonly Seat[], isDeep: boolean, produceBrief: () => Promise<BriefOutcome>, asking: Asking = {}): Promise<void> {
  const isCurrent = () => generation === councilGeneration
  const outcome = await produceBrief().catch((): BriefOutcome => ({ failure: 'the herald could not write a brief' }))
  if (!isCurrent()) return
  // A consult's options and the person's standing context, set on the council when it convened.
  const convened = await read($, councilAtom)
  const options = convened?.options
  const standing = convened?.standing
  if ('failure' in outcome) {
    await updateCouncil($, council => ({ ...council, phase: 'failed', notice: `Could not convene: ${outcome.failure}.` }))
    $.ui.toast(`The council could not convene: ${outcome.failure}.`)
    return
  }
  const { brief } = outcome
  await updateCouncil($, council => ({ ...withAdvisorsDeliberating(council, brief), notice: outcome.notice ?? null }))
  await Promise.all(
    seats.map(async advisor => {
      const verdict = await askAdvisorModel($, asking.use ?? { purpose: `member:${advisor.id}` }, isDeep, advisorSystemPrompt(advisor, standing), advisorPrompt(topic, brief, options, asking.extra), asking.extra ? 450 : 300).catch(() => undefined)
      if (verdict?.isAnswered) asking.onReply?.(advisor.id, verdict.text)
      if (isCurrent()) await updateCouncil($, council => withVerdict(council, advisor.id, verdict?.isAnswered ? verdict.text : undefined))
    }),
  )
}

async function startCouncil($: EngineInterface, topic: string, isDeep: boolean, produceBrief: () => Promise<BriefOutcome>): Promise<string> {
  const existing = await read($, councilAtom)
  if (isCouncilWorking && existing && (existing.phase === 'briefing' || existing.phase === 'deliberating')) {
    return 'The council is already in session. /council show opens the chamber; /council reset dismisses it.'
  }
  const { seats, problems } = await seatsForProject($)
  if (seats.length === 0) return 'No one is seated on this project\'s council. /council members to seat someone.'
  if (problems.length > 0) $.ui.toast(`Council: ${problems.length} member file problem${problems.length === 1 ? '' : 's'}; /council members shows them.`)
  const generation = ++councilGeneration
  const { standing, strictness, problems: profileProblems } = await councilContext($)
  if (profileProblems.length > 0) $.ui.toast(`Council: ${profileProblems.length} profile problem${profileProblems.length === 1 ? '' : 's'}; /council profile shows them.`)
  await update($, councilAtom, () => ({ ...newCouncil(topic, seats, isDeep), standing, ...(strictness !== 0 ? { strictness } : {}), source: 'person' as const }))
  await update($, isRosterOpenAtom, () => false)
  await update($, isDocketOpenAtom, () => false)
  // A council you convened opens to its chamber, even when the court has orders.
  await update($, isChamberShownAtom, () => true)
  await openCouncilPane($)
  isCouncilWorking = true
  void holdCouncil($, generation, topic, seats, isDeep, produceBrief)
    .then(async () => {
      // The sitting, recorded in the docket once it adjourns (or dissolves).
      const council = generation === councilGeneration ? await read($, councilAtom) : null
      if (council === null) return
      const id = await recordSitting($, { kind: 'council', question: topic, ...sittingFields(council), outcome: council.phase === 'done' ? 'adjourned' : 'dissolved' })
      await markCouncilDocket($, council.topic, id)
    })
    .catch(() => undefined)
    .finally(() => {
      if (generation === councilGeneration) isCouncilWorking = false
    })
  return `${isDeep ? 'The brain trust' : 'The council'} convenes on: ${topic}`
}

async function convene($: EngineInterface, topic: string, isDeep: boolean): Promise<string> {
  return startCouncil($, topic, isDeep, () => forkBrief($, topic))
}

// A leading folder names the repo to review (`review web main`), for a
// session whose root holds several; otherwise the working directory's repo.
async function reviewTarget($: EngineInterface, args: string): Promise<{ project: string; rest: string }> {
  const [root, cwd] = await Promise.all([$.session.root(), $.session.cwd()])
  const [first = '', ...others] = args.trim().split(/\s+/)
  if (first === '' || others.length === 0) return { project: cwd, rest: args }
  const candidate = reviewFolderCandidate(root, first)
  // A repo's own folder (holding .git), so `review main is it ready?` with a
  // plain main/ folder still reads main as the ref.
  const isFolder = await $.fs.exists(`${candidate}/.git`).catch(() => false)
  return isFolder ? { project: candidate, rest: others.join(' ') } : { project: cwd, rest: args }
}

// `review <ref> [question]`: judge the repo's work since the ref, with no
// conversation needed (work done in another session and pushed).
async function conveneReview($: EngineInterface, args: string, isDeep: boolean): Promise<string> {
  const { project, rest } = await reviewTarget($, args)
  const request = parseReviewArgs(rest)
  if (request === undefined) return 'Usage: /council review [folder] <ref> [question], e.g. review main, review web abc123 is the API safe?, review yesterday'
  return startCouncil($, `Review since ${describeRef(request.ref)}: ${request.question}`, isDeep, () => reviewBrief($, project, request, isDeep))
}

// /council takes either a question or `review [folder] <ref> …`.
const conveneFromText = ($: EngineInterface, text: string, isDeep = false) =>
  /^review\b/i.test(text) ? conveneReview($, text.replace(/^review\b/i, ''), isDeep) : convene($, text, isDeep)

// New context for an adjourned council: every advisor reconsiders its own
// verdict in its light. Five advisor calls; the herald's brief is reused.
// `isDeep`: this round (and the council's later ones) as a brain trust.
async function reconsider($: EngineInterface, context: string, isDeep = false): Promise<string> {
  const council = await read($, councilAtom)
  if (council === null) return 'The council has not convened. /council <question> first.'
  if (council.phase !== 'done') return 'The council can reconsider once it has adjourned.'
  if (context === '') return 'Usage: /council reconsider <new context>'
  const generation = ++councilGeneration
  const isCurrent = () => generation === councilGeneration
  const reconsidering = isDeep ? { ...withReconsidering(council, context), isDeep: true } : withReconsidering(council, context)
  await update($, councilAtom, () => reconsidering)
  await openCouncilPane($)
  isCouncilWorking = true
  void Promise.all(
    seatsOf(reconsidering).map(async advisor => {
      const report = reconsidering.advisors[advisor.id]
      if (report === undefined) return
      const prompt = reconsiderPrompt(reconsidering, report)
      const verdict = await askAdvisorModel($, { purpose: `member:${advisor.id}` }, reconsidering.isDeep, advisorSystemPrompt(advisor, reconsidering.standing), prompt, 300).catch(() => undefined)
      if (isCurrent()) await updateCouncil($, current => withVerdict(current, advisor.id, verdict?.isAnswered ? verdict.text : undefined))
    }),
  )
    .then(async () => {
      // The finished reconsideration becomes a lesson.
      if (isCurrent()) await recordLesson($)
    })
    .catch(() => undefined)
    .finally(() => {
      if (isCurrent()) isCouncilWorking = false
    })
  return 'The council reconsiders with your new context.'
}

// One advisor, asked a follow-up on its own verdict: one more model call.
async function askAdvisor($: EngineInterface, query: string, question: string): Promise<string> {
  const council = await read($, councilAtom)
  if (council === null) return 'The council has not convened. /council <topic> first.'
  const advisor = findAdvisor(seatsOf(council), query)
  if (advisor === undefined) return `No advisor "${query}". Ask one of: ${seatsOf(council).map(entry => entry.id).join(', ')}.`
  const report = council.advisors[advisor.id]
  if (report === undefined || report.status !== 'done') return `${advisor.title} has not given a verdict yet.`
  if (report.followUp?.status === 'asking') return `${advisor.title} is still considering the last question.`
  if (question === '') return 'Usage: /council ask <advisor> <question>'

  await updateAdvisor($, advisor.id, current => ({ ...current, isExpanded: true, followUp: { question, answer: '', status: 'asking' } }))
  await openCouncilPane($)
  const generation = councilGeneration
  // In the background: the command returns now, the answer fills in under the card.
  void askAdvisorModel($, { purpose: `member:${advisor.id}` }, council.isDeep, advisorSystemPrompt(advisor, council.standing), followUpPrompt(council.topic, council.brief, report, question), 400)
    .catch(() => undefined)
    .then(reply =>
      generation !== councilGeneration
        ? undefined
        : (async () => {
            await updateAdvisor($, advisor.id, current => ({
              ...current,
              followUp: reply?.isAnswered ? { question, answer: reply.text.trim(), status: 'done' } : { question, answer: '', status: 'failed' },
            }))
            if (reply?.isAnswered) await updateCouncil($, current => withFollowUpRecorded(current, { advisor: advisor.id, question, answer: reply.text.trim() }))
          })(),
    )
    .catch(() => undefined)
  return `${advisor.title} considers your question.`
}

// A report of the council, written by one model call, put in the prompt box
// ahead of the person's draft to edit and send: nothing reaches the main
// conversation unless they send it. If the call fails, the plain record goes
// in instead.
async function reportCouncil($: EngineInterface): Promise<string> {
  const council = await read($, councilAtom)
  if (council === null) return 'The council has not convened. /council <question> first.'
  if (council.phase !== 'done') return 'The council can report once it has adjourned.'
  const generation = councilGeneration
  void askAdvisorModel($, { purpose: 'report' }, council.isDeep, REPORT_SYSTEM, reportPrompt(council), 500)
    .catch(() => undefined)
    .then(async reply => {
      if (generation !== councilGeneration) return
      const report = reply?.isAnswered && reply.text.trim() !== '' ? reply.text.trim() : `Council record:\n${councilRecord(council)}`
      const draft = (await $.prompt.read()).text.trim()
      await $.prompt.fill({ text: draft === '' ? `${report}\n\n` : `${report}\n\n${draft}`, mode: 'replace' })
      $.ui.toast(reply?.isAnswered ? 'The council report is in your prompt box: edit it, then send.' : 'The report could not be written; the council record is in your prompt box instead.')
    })
    .catch(() => undefined)
  return 'The council report is being written; it will appear in your prompt box.'
}

// The terminal's animation starts with the chamber's first terminal draw
// (drawCouncil), so a desktop never runs the timer.
async function openCouncilPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: COUNCIL_PANE_ID, title: 'The Council', rows: 30 })
}

async function dismissCouncil($: EngineInterface): Promise<void> {
  councilGeneration++
  isCouncilWorking = false
  await update($, councilAtom, () => null)
  stopAnimation()
  await $.ui.close({ id: COUNCIL_PANE_ID }).catch(() => undefined)
}

// Puts a /council command in front of the prompt box's draft (replacing one
// already there), so the rest is typed at full width and sent with Enter.
async function fillCommand($: EngineInterface, command: string): Promise<void> {
  const draft = (await $.prompt.read()).text.replace(/^\/council(?: deep)?(?: ask \S+| reconsider)?\s*/, '')
  await $.prompt.fill({ text: `${command}${draft}`, mode: 'replace' })
}

// After a reload no work is in flight (it was dropped with the old module),
// but the state may still say "briefing", "deliberating" or "asking": mark
// that work interrupted, so the council isn't stuck.
async function settleInterruptedWork($: EngineInterface): Promise<void> {
  const council = await read($, councilAtom)
  if (council === null) return
  const isStuck = council.phase === 'briefing' || council.phase === 'deliberating' || seatsOf(council).some(advisor => council.advisors[advisor.id]?.followUp?.status === 'asking')
  if (!isStuck) return
  await update($, councilAtom, current => {
    if (current === null) return current
    const advisors = Object.fromEntries(
      seatsOf(current).flatMap(advisor => {
        const report = current.advisors[advisor.id]
        if (report === undefined) return []
        const followUp = report.followUp?.status === 'asking' ? { ...report.followUp, status: 'failed' as const, answer: 'Interrupted by a reload; ask again.' } : report.followUp
        const isUnfinished = report.status === 'waiting' || report.status === 'deliberating'
        return [[advisor.id, isUnfinished ? { ...report, status: 'failed' as const, verdict: 'Interrupted.', detail: '', followUp } : { ...report, followUp }]]
      }),
    ) as Council['advisors']
    const phase = current.phase === 'briefing' ? ('failed' as const) : current.phase === 'deliberating' ? ('done' as const) : current.phase
    return { ...current, phase, advisors, notice: current.phase === 'done' ? current.notice : 'Interrupted by a reload: /council reconsider or ask again.' }
  })
}

async function drawCouncil($: EngineInterface, e: RenderInput<'Pane'>) {
  const table = $.ui.resolve(e)
  // Whatever this draw shows, the portraits drawn before are gone from the pane.
  if (e.surface === 'terminal') shownSprites.clear()
  const [council, isRosterOpen, roster, isLessonsOpen, learning, isDocketOpen, docket] = await Promise.all([
    read($, councilAtom),
    read($, isRosterOpenAtom),
    read($, rosterAtom),
    read($, isLessonsOpenAtom),
    read($, learningAtom),
    read($, isDocketOpenAtom),
    read($, docketAtom),
  ])
  if (isDocketOpen) {
    if (docket === null) {
      void refreshDocket($).catch(() => undefined)
      return <table.Text dimColor>Reading the docket…</table.Text>
    }
    return docketView(table, {
      view: docket,
      onFilter: filter => refreshDocket($, { filter, offset: 0, openId: null }),
      onToggle: id => update($, docketAtom, current => (current === null ? current : { ...current, openId: current.openId === id ? null : id })),
      onMore: () => refreshDocket($, { offset: docket.offset + DOCKET_LIMITS.page }),
      onLess: () => refreshDocket($, { offset: Math.max(0, docket.offset - DOCKET_LIMITS.page) }),
      onClose: () => update($, isDocketOpenAtom, () => false),
    })
  }
  if (isLessonsOpen) {
    if (learning === null) {
      void refreshLearning($).catch(() => undefined)
      return <table.Text dimColor>Reading the lessons…</table.Text>
    }
    return lessonsView(table, {
      view: learning,
      onForget: id => forgetLesson($, id),
      onDraft: () => draftSummary($, learning.project),
      onApprove: () => approveSummary($),
      onReject: () => rejectSummary($),
      onClose: () => update($, isLessonsOpenAtom, () => false),
    })
  }
  if (isRosterOpen) {
    if (roster === null) {
      void refreshRoster($).catch(() => undefined)
      return <table.Text dimColor>Reading the members…</table.Text>
    }
    return rosterView(table, {
      roster,
      onToggle: id => toggleSeat($, id),
      onClose: () => update($, isRosterOpenAtom, () => false),
    })
  }
  await expireOrders($).catch(() => undefined)
  const [court, isChamberShown] = await Promise.all([read($, courtAtom), read($, isChamberShownAtom)])
  const hasCourt = court.orders.length > 0 || court.isInSession || (court.advisors ?? []).some(run => !run.isFolded)
  if (hasCourt && !isChamberShown) {
    return courtView(table, {
      court,
      council,
      bodyColumns: e.props.bodyColumns,
      road: order => {
        const state = order.status === 'done' ? 'done' : order.status === 'failed' ? 'failed' : 'travelling'
        const { fraction } = progressOf(order)
        // The callTally setting turns the work sites and tents off, leaving the plain road.
        const sites = settings.isTallyShown ? sitesOf(order) : undefined
        const elements = table as unknown as Record<string, ((props: Record<string, unknown>) => unknown) | undefined>
        return e.surface !== 'terminal' && elements.Svg
          ? // No width: the strip takes its own (320px) up to the slot, so a narrow sidebar scales it down rather than clipping the house.
            elements.Svg({ key: `road-${order.id}`, source: roadSvg(AGENT_LOOK[order.role], fraction, state, 2, sites), alt: `${order.role} on the road to ${order.relFolder}` })
          : <table.Text key={`road-${order.id}`} color={order.status === 'failed' ? 'error' : order.status === 'done' ? 'success' : 'claude'}>{roadText(order.role === 'knight' ? '♞' : '♟', fraction, state, undefined, sites)}</table.Text>
      },
      onChamber: () => update($, isChamberShownAtom, () => true),
      openVerdictId: await read($, openVerdictAtom),
      isFinishedShown: await read($, isFinishedShownAtom),
      openOrderId: await read($, openOrderAtom),
      onToggleOrder: id => update($, openOrderAtom, current => (current === id ? null : id)),
      // The person's press in the pane: the same as /council grant or deny-leave.
      onGrantLeave: async id => $.ui.toast(await leaveAction($, id, 'grant')),
      onDenyLeave: async id => $.ui.toast(await leaveAction($, id, 'deny')),
      portrait: (seat, report) => {
        const elements = table as unknown as Record<string, ((props: Record<string, unknown>) => unknown) | undefined>
        if (e.surface === 'terminal' || !elements.Svg || council === null) return null
        const mood = moodFor(report, council.phase)
        return elements.Svg({ key: `mini-${seat.id}-${mood}`, source: animatedSvg(seat, mood), alt: `${seat.title}, ${mood}`, width: 40, height: 44, isInteractive: true })
      },
      onToggleVerdict: id => update($, openVerdictAtom, current => (current === id ? null : id)),
      onToggleFinished: () => update($, isFinishedShownAtom, current => !current),
      onToggleSession: () => setCourtSession($, !court.isInSession),
      onClearFinished: () => update($, courtAtom, current => ({ ...current, orders: current.orders.filter(order => !isFinished(order)), advisors: (current.advisors ?? []).filter(run => !isClearable(run, current)) })),
      onOpenDocket: id => openDocket($, id),
    })
  }
  if (council === null) return <table.Text dimColor>The council has not convened. /council &lt;question&gt; to summon it; /council members to choose who sits.</table.Text>
  const isTerminal = e.surface === 'terminal'
  // The portraits this draw holds: compact rows have none, so the timer
  // repaints only these, and doesn't run when there are none.
  const portraits = new Set<AdvisorId>()
  const tree = councilView(table, {
    council,
    bodyColumns: e.props.bodyColumns,
    bodyRows: (e.props as { scroll?: { bodyRows?: number } }).scroll?.bodyRows,
    isTerminal,
    hasHotkeys: isTerminal,
    portrait: (seat, report) => {
      portraits.add(seat.id)
      return portraitFor(table, e.surface, seat, report, council, animationTick)
    },
    onToggleBrief: () => updateCouncil($, current => ({ ...current, isBriefExpanded: !current.isBriefExpanded })),
    onToggleAdvisor: id => updateAdvisor($, id, report => ({ ...report, isExpanded: !report.isExpanded })),
    // One card open at a time among the compact rows.
    onOpenAdvisor: id =>
      updateCouncil($, current => ({
        ...current,
        advisors: Object.fromEntries(Object.entries(current.advisors).map(([seatId, report]) => [seatId, { ...report, isExpanded: seatId === id ? !report.isExpanded : false }])),
      })),
    // Fills the prompt box in front of the draft: the question is finished there and sent with Enter.
    onAsk: id => fillCommand($, `/council ask ${id} `),
    onReconsider: () => fillCommand($, '/council reconsider '),
    onReconsiderDeep: () => fillCommand($, '/council deep reconsider '),
    onAskDeep: () => fillCommand($, '/council deep '),
    onReport: async () => $.ui.toast(await reportCouncil($)),
    onMembers: () => openRoster($),
    onLessons: () => openLessons($),
    ...(council.docketId !== undefined ? { onDocket: () => openDocket($, council.docketId ?? null) } : {}),
    ...(hasCourt ? { onCourt: () => update($, isChamberShownAtom, () => false) } : {}),
  })
  if (isTerminal) {
    for (const id of portraits) shownSprites.add(id)
    if (shownSprites.size > 0) startAnimation($)
    else stopAnimation()
  }
  return tree
}

// ── Members ───────────────────────────────────────────────────────────────

let homeFolder: string | undefined

// The home folder ('' when neither HOME nor USERPROFILE is set), read once.
async function home($: EngineInterface): Promise<string> {
  if (homeFolder === undefined) {
    const [fromHome, fromProfile] = await Promise.all([$.env.get('HOME').catch(() => undefined), $.env.get('USERPROFILE').catch(() => undefined)])
    homeFolder = homeFromEnvironment(fromHome, fromProfile) ?? ''
  }
  return homeFolder
}

const rosterStoreKey = (root: string) => `roster:${root}`

async function unseatedIds($: EngineInterface, root: string): Promise<string[]> {
  const stored = (await $.store.get(rosterStoreKey(root))) as { off?: unknown } | undefined
  return Array.isArray(stored?.off) ? stored.off.filter((id): id is string => typeof id === 'string') : []
}

// The member files in one folder, parsed, with their references resolved.
// `bases`: the members a file of the same id takes the fields it leaves out
// from (for a project's files, the person's own, then the built-ins).
async function readMemberFolder($: EngineInterface, folder: string, source: 'user' | 'project', homePath: string, spareStart: number, bases: readonly MemberDefinition[] = BUILT_IN_MEMBERS) {
  const entries = await $.fs.list(folder).catch(() => [])
  const files = entries.filter(entry => entry.kind === 'file' && entry.name.toLowerCase().endsWith('.md')).sort((left, right) => left.name.localeCompare(right.name))
  const members: MemberDefinition[] = []
  const problems: string[] = []
  for (const [index, entry] of files.entries()) {
    const text = await $.fs.read(`${folder}/${entry.name}`).catch(() => undefined)
    if (typeof text !== 'string') {
      problems.push(`${entry.name}: could not be read`)
      continue
    }
    const base = bases.find(member => member.id === memberId(entry.name))
    const parsed = parseMemberFile(entry.name, text, source, base, spareStart + index)
    const label = `${source === 'user' ? '~/.claude' : '.claude'}/council/members/`
    if ('problem' in parsed) {
      problems.push(`${label}${parsed.problem}`)
      continue
    }
    // Tuning that doesn't hold is left out and listed; the member still sits.
    problems.push(...(parsed.problems ?? []).map(problem => `${label}${problem}`))
    const resolved = parsed.member.referencePaths.map(path => resolveReference(path, folder, homePath))
    resolved.forEach((path, position) => {
      if (path === undefined) problems.push(`${entry.name}: can't resolve reference ${parsed.member.referencePaths[position]}`)
    })
    members.push({ ...parsed.member, referencePaths: resolved.filter((path): path is string => path !== undefined) })
  }
  return { members, problems }
}

// Everyone this project could seat, from the built-ins and both member folders.
async function loadMembers($: EngineInterface): Promise<{ members: MemberDefinition[]; problems: string[]; root: string }> {
  const [root, homePath] = await Promise.all([$.session.root(), home($)])
  const user = homePath === '' ? { members: [], problems: [`Your own member files were not read: ${NO_HOME}.`] } : await readMemberFolder($, `${homePath}/.claude/council/members`, 'user', homePath, 0)
  const project = await readMemberFolder($, `${root}/.claude/council/members`, 'project', homePath, user.members.length, [...user.members, ...BUILT_IN_MEMBERS])
  return { members: mergeMembers(user.members, project.members), problems: [...user.problems, ...project.problems], root }
}

// The seats for a new council: who is seated here, references read in.
async function seatsForProject($: EngineInterface): Promise<{ seats: Seat[]; problems: string[] }> {
  const { members, problems, root } = await loadMembers($)
  const seated = seatedMembers(members, await unseatedIds($, root)).slice(0, MAX_SEATS)
  const seats = await Promise.all(
    seated.map(async member => {
      const read = await Promise.all(
        member.referencePaths.map(async path => {
          const text = await $.fs.read(path).catch(() => undefined)
          if (typeof text !== 'string') problems.push(`${member.title}: could not read reference ${path}`)
          return typeof text === 'string' ? { source: path.split(/[\\/]/).pop() ?? path, text } : undefined
        }),
      )
      return seatOf(member, trimReferences(read.filter((entry): entry is { source: string; text: string } => entry !== undefined)))
    }),
  )
  return { seats, problems }
}

async function refreshRoster($: EngineInterface): Promise<Roster> {
  const [{ members, problems, root }, loaded] = await Promise.all([loadMembers($), loadProfile($).catch(() => undefined)])
  const off = await unseatedIds($, root)
  const seated = seatedMembers(members, off).slice(0, MAX_SEATS).map(member => member.id)
  const roster: Roster = {
    entries: members.map(member => {
      const summary = tuningSummary(member.tuning)
      return { id: member.id, title: member.title, concern: member.concern, color: member.color, source: member.source, isSeated: seated.includes(member.id), ...(summary !== undefined ? { tuning: { summary, files: tuningFiles(member) } } : {}) }
    }),
    // The profile's problems beside the member files' (/council profile has the rest of it).
    problems: [...problems, ...(loaded?.profile.problems ?? []), ...(members.length - off.length > MAX_SEATS ? [`At most ${MAX_SEATS} sit at once; the rest wait until a seat is free.`] : [])],
  }
  await update($, rosterAtom, () => roster)
  return roster
}

async function setSeated($: EngineInterface, id: string, isSeated: boolean): Promise<void> {
  const root = await $.session.root()
  const off = (await unseatedIds($, root)).filter(entry => entry !== id)
  await $.store.set(rosterStoreKey(root), { off: isSeated ? off : [...off, id] })
}

async function toggleSeat($: EngineInterface, id: string): Promise<void> {
  const roster = await read($, rosterAtom)
  const entry = roster?.entries.find(candidate => candidate.id === id)
  if (entry === undefined) return
  await setSeated($, id, !entry.isSeated)
  await refreshRoster($)
}

async function openRoster($: EngineInterface): Promise<void> {
  await refreshRoster($)
  await update($, isDocketOpenAtom, () => false)
  await update($, isRosterOpenAtom, () => true)
  await $.ui.open({ id: COUNCIL_PANE_ID, title: 'The Council', rows: 30 })
}

// `/council members` opens the list; `/council members on|off <id>` seats or unseats one.
async function membersCommand($: EngineInterface, action: string, id: string): Promise<string> {
  if (action === '') {
    await openRoster($)
    return 'The members list is open in the chamber.'
  }
  if (action !== 'on' && action !== 'off') return 'Usage: /council members [on|off <member>]'
  const roster = await refreshRoster($)
  const entry = roster.entries.find(candidate => candidate.id === id.trim().toLowerCase())
  if (entry === undefined) return `No member "${id}". Members: ${roster.entries.map(candidate => candidate.id).join(', ')}.`
  await setSeated($, entry.id, action === 'on')
  await refreshRoster($)
  return `${entry.title} is ${action === 'on' ? 'seated on' : 'off'} this project's council from its next sitting.`
}

// ── The court: orders, dispatches, court mode ─────────────────────────────

// How each role looks on its road.
const AGENT_LOOK: Record<Order['role'], Appearance> = {
  scout: { color: '#c9ced6', accessory: 'antenna' },
  knight: { color: '#d4a017', accessory: 'shield' },
}

// The latest petition put to the council in court mode: the context for the
// orders Claude then proposes.
let lastPetition: string | null = null

const updateOrder = ($: EngineInterface, matches: (order: Order) => boolean, change: (order: Order) => Order) =>
  update($, courtAtom, court => ({ ...court, orders: court.orders.map(order => (matches(order) ? change(order) : order)) }))

// Convenes the council and waits for it to adjourn: the finished council, or
// undefined if no one is seated or another council replaced it meanwhile.
async function conveneAndWait(
  $: EngineInterface,
  topic: string,
  produceBrief: () => Promise<BriefOutcome>,
  sitting: { onlySeat?: string; options?: string[]; isChamber?: boolean; source?: 'person' | 'claude'; isDeep?: boolean } & Asking = {},
): Promise<Council | undefined> {
  const { seats: seated } = await seatsForProject($)
  // Asked of one member: only it sits.
  const seats = sitting.onlySeat === undefined ? seated : seated.filter(seat => seat.id === sitting.onlySeat)
  if (seats.length === 0) return undefined
  const generation = ++councilGeneration
  const { standing, strictness } = await councilContext($)
  const council: Council = { ...newCouncil(topic, seats, sitting.isDeep === true), standing, ...(strictness !== 0 ? { strictness } : {}), source: sitting.source ?? 'person' }
  await update($, councilAtom, () => (sitting.options && sitting.options.length > 0 ? { ...council, options: sitting.options } : council))
  // The court's sittings show the court; a consult shows its chamber.
  await update($, isChamberShownAtom, () => sitting.isChamber === true)
  await openCouncilPane($)
  isCouncilWorking = true
  try {
    await holdCouncil($, generation, topic, seats, sitting.isDeep === true, produceBrief, { extra: sitting.extra, onReply: sitting.onReply, use: sitting.use })
  } finally {
    if (generation === councilGeneration) isCouncilWorking = false
  }
  return generation === councilGeneration ? ((await read($, councilAtom)) ?? undefined) : undefined
}

// The consult tool: Claude asks the council mid-task, with its own brief.
async function consultCouncil($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const consult = readConsult(input)
  if ('error' in consult) return consult.error
  const council = await conveneAndWait($, consult.question, async () => ({ brief: consult.context }), { options: consult.options, isChamber: true, source: 'claude', isDeep: consult.isDeep })
  if (council === undefined) return 'The council could not sit (no one is seated, or another council replaced it). Ask the person instead.'
  const docketEntryId = await recordSitting($, { kind: 'consult', question: consult.question, ...sittingFields(council), outcome: consultOutcome(council) })
  await markCouncilDocket($, council.topic, docketEntryId)
  if (council.phase !== 'done') return `The council could not answer: ${council.notice ?? 'it dissolved'}. Ask the person instead.`
  return consultText(council)
}

// The propose_orders tool: the council rules on Claude's plan; approved
// dispatches become orders. When members ask CHECK questions, the orders are
// held and the tool answers at once; the second round runs when the advisor
// reports (ruleSummons), and the main session is told.
async function proposeOrders($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const root = await $.session.root()
  const proposal = readProposal(input, root)
  if ('error' in proposal) return proposal.error
  for (const dispatch of proposal.dispatches) {
    const isFolder = await $.fs
      .stat(joinUnder(root, dispatch.folder))
      .then(stat => stat.kind === 'dir')
      .catch(() => false)
    if (!isFolder) return `There is no folder ${dispatch.folder}/ under ${root}.`
  }
  // No model spend on a plan whose knight would clash with one at work.
  const clash = await proposalClash($, proposal, root)
  if (clash !== undefined) return clash
  // Each member's raw answers, newest round first, for the LEVEL lines.
  const replies = new Map<AdvisorId, string>()
  const onReply = (seatId: AdvisorId, text: string) => replies.set(seatId, replies.has(seatId) ? `${text}\n${replies.get(seatId)}` : text)
  // The person's strictness sets which concerns may ask a CHECK.
  const threshold = conditionAt((await loadProfile($).catch(() => undefined))?.profile.strictness)
  const council = await conveneAndWait($, `Orders: ${proposal.plan}`, async () => ({ brief: proposalBrief(proposal, lastPetition) }), {
    source: 'claude',
    extra: orderAsk(proposal.dispatches.length, settings.isSummonsOn, hasLeave(proposal), threshold),
    onReply,
  })
  if (council === undefined) return 'The council could not sit (no one is seated, or another council replaced it). Ask the person.'
  const questions = settings.isSummonsOn ? summonsChecks(council, proposal, replies) : undefined
  if (questions !== undefined) return holdForAdvisor($, council, proposal, root, replies, questions)
  const { result, levels } = await finalRuling($, council, proposal, lastPetition, replies)
  const now = await $.clock.now()
  const base = await docketBase($)
  // Numbered inside the update, from the court as it is then, so an id is never
  // handed out twice; the court's counter moves past it and clearing never frees it.
  let orders: Order[] = []
  await update($, courtAtom, current => {
    orders = result.isApproved ? newOrders(current, proposal, root, result.conditions, now, levels, 'approved', settings.leaveApproval) : []
    return { ...withOrdersAdded(current, orders), rulings: [...current.rulings.slice(-9), rulingRecord(result, base?.id)] }
  })
  recordDocket($, base, {
    kind: 'orders',
    plan: proposal.plan,
    dispatches: docketDispatches(proposal.dispatches),
    ...sittingFields(council, replies, proposal.dispatches.length),
    outcome: result.isApproved ? 'approved' : 'refused',
    ...rulingFields(result),
    orderIds: orders.map(order => order.id),
  })
  await markCouncilDocket($, council.topic, base?.id)
  toastPendingLeave($, orders)
  return rulingText(result, orders)
}

// What a ruling adds to its docket entry: why it was refused, the conditions
// and the arbiter's notes.
const rulingFields = (result: RulingResult): Pick<DocketEntry, 'reason' | 'conditions' | 'notes'> => ({
  ...(!result.isApproved && result.reason !== '' ? { reason: result.reason } : {}),
  ...(result.conditions.length > 0 ? { conditions: [...result.conditions] } : {}),
  ...(result.notes && result.notes.length > 0 ? { notes: [...result.notes] } : {}),
})

const hasLeave = (proposal: Proposal) => proposal.dispatches.some(dispatch => (dispatch.leave ?? []).length > 0)

// The person hears at once of leave only they can grant.
function toastPendingLeave($: EngineInterface, orders: readonly Order[]): void {
  const pending = orders.filter(isLeavePending).map(order => order.id)
  if (pending.length > 0) $.ui.toast(`Council: ${pending.join(', ')} ${pending.length === 1 ? 'asks' : 'ask'} for leave. /council grant <id> or /council deny-leave <id>; the court shows it.`)
}

// A ruling as the court records it, with its docket entry's id.
const rulingRecord = (result: RulingResult, docketEntryId?: string) => ({
  plan: result.plan,
  isApproved: result.isApproved,
  gravest: result.gravest,
  reason: result.reason,
  ...(result.notes ? { notes: result.notes } : {}),
  ...(result.summons ? { summons: result.summons } : {}),
  ...(docketEntryId !== undefined ? { docketId: docketEntryId } : {}),
})

// The ruling on a council's verdicts, its conditions reviewed by the arbiter,
// and each dispatch's level from every member's answers.
async function finalRuling($: EngineInterface, council: Council, proposal: Proposal, petition: string | null, replies: ReadonlyMap<AdvisorId, string>, summons?: RulingSummons) {
  const ruled = { ...ruling(council, proposal.plan), ...(summons ? { summons } : {}) }
  const result = needsArbiter(ruled) ? await arbitrate($, council, proposal, ruled, petition) : ruled
  const levels = orderLevels(
    seatsOf(council).flatMap(seat => replies.get(seat.id) ?? []),
    proposal.dispatches.map(dispatch => dispatch.role),
  )
  return { result, levels }
}

// ── Advisor agents (council:advisor) ──────────────────────────────────────

type AdvisorOutcome = { status: AdvisorRunStatus; report: string }
// What a spawn token is for: the run, its folders and model. The secret itself
// is never saved: a token lost with the module can't be used, so nothing
// un-tokened gets through after a reload.
type PendingAdvisor = { runId: string; folders: string[]; model: string }

// The advisor spawns this plugin is about to make, by the one-time token at
// the end of their prompt: the only council:advisor spawns allowed. Claude and
// subagents never see a token, so they can't start one.
const pendingAdvisors = new Map<string, PendingAdvisor>()
// Runs whose spawn is under way in this module (a run with no agent and no
// spawn under way has lost its start: advisors.ts withUnstartedAdvisors).
const spawningRuns = new Set<string>()
// Each advisor agent's folders, by agent id (the court's runs hold them too).
const advisorAgents = new Map<string, string[]>()

const TOKEN_LINE = /\s*\[council-advisor-token ([0-9a-f]{16,})\]\s*$/
const ADVISOR_DENIED = "The council's advisor (council:advisor) is started only by the person (/council advise) or by the council itself; it can't be dispatched. Use a council:scout with an approved order to read a folder."
const ADVISOR_TOOLS = new Set(['Read', 'Grep', 'Glob'])

// The agent type a spawn names. A plugin's own $.agent.spawn has reached the
// hooks spelled as the Agent tool's input (subagent_type) in some engine
// builds, so both spellings are read.
const spawnTypeOf = (e: { subagentType?: string }) => e.subagentType ?? (e as { subagent_type?: unknown }).subagent_type

function newToken(): string {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.()
  return uuid ? uuid.replace(/-/g, '') : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

// A new advisor run in the court, numbered inside the update.
async function addAdvisorRun($: EngineInterface, fields: Pick<AdvisorRun, 'origin' | 'relFolders' | 'questions' | 'isDeep' | 'model' | 'effort'>): Promise<AdvisorRun> {
  const now = await $.clock.now()
  let added: AdvisorRun | undefined
  await update($, courtAtom, current => {
    const number = nextAdvisorNumber(current)
    added = { ...fields, id: `A${number}`, status: 'running', agentId: null, report: '', startedAt: now, endedAt: null }
    // Running ones are kept; of the rest, the last ten.
    const kept = (current.advisors ?? []).filter((run, index, all) => run.status === 'running' || index >= all.length - 10)
    return { ...current, advisors: [...kept, added], nextAdvisorId: number + 1 }
  })
  return added!
}

// Starts the advisor agent ($.agent.spawn; the engine refuses a plugin's own
// Agent tool call) and returns once it started: undefined, or why it could
// not. Nothing waits for its answer: its turn.complete finishes the run
// (finishAdvisorAgent). The agent.spawn hook knows the spawn by its token and
// sets its model and folder; turn.step reads its effort from the court.
async function startAdvisorAgent($: EngineInterface, runId: string, folders: string[], task: string, level: ModelEffort): Promise<string | undefined> {
  const token = newToken()
  pendingAdvisors.set(token, { runId, folders, model: level.model })
  spawningRuns.add(runId)
  try {
    const started = await $.agent
      .spawn({ subagentType: ADVISOR_TYPE, description: `${runId} council advisor`, prompt: `${task}\n\n[council-advisor-token ${token}]`, model: level.model })
      .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))
    return 'deny' in started && typeof started.deny === 'string' ? started.deny : undefined
  } finally {
    pendingAdvisors.delete(token)
    spawningRuns.delete(runId)
  }
}

// The advisor's spawn went through: its agent id noted (its effort is the run's, in the court).
async function advisorStarted($: EngineInterface, pending: PendingAdvisor, agentId: string): Promise<void> {
  advisorAgents.set(agentId, pending.folders)
  usageAgents.set(agentId, { category: 'advisor' })
  await update($, courtAtom, current => withAdvisorChanged(current, pending.runId, run => ({ ...run, agentId })))
}

async function finishAdvisor($: EngineInterface, runId: string, outcome: AdvisorOutcome): Promise<void> {
  const now = await $.clock.now()
  const before = (await read($, courtAtom)).advisors?.find(run => run.id === runId)
  await update($, courtAtom, current => withAdvisorChanged(current, runId, run => finishedRun(run, outcome.status, outcome.report, now)))
  if (before?.origin === 'owner' && before.status === 'running') {
    $.ui.toast(
      outcome.status === 'done'
        ? `${runId}: the advisor is back from ${before.relFolders.join(', ')}/; its report goes to Claude with your next message.`
        : `${runId}: the advisor ${outcome.status === 'timed-out' ? 'timed out' : 'failed'} in ${before.relFolders.join(', ')}/.`,
    )
    // The person's own advisor goes in the docket: where, what, and what it found.
    await recordSitting($, {
      kind: 'advise',
      question: before.questions.map(entry => entry.question).join('\n'),
      folders: [...before.relFolders],
      ...(before.isDeep ? { isDeep: true } : {}),
      outcome: outcome.status,
      findings: findingsSummary(outcome.report),
      runId,
      by: 'person',
    })
  }
}

// An advisor agent's last answer finishes its run; a summoned one's starts
// its ruling's second round (in the background: kickSummonses).
async function finishAdvisorAgent($: EngineInterface, agentId: string, answer: string, isFailed: boolean): Promise<void> {
  const run = (await read($, courtAtom)).advisors?.find(candidate => candidate.agentId === agentId && candidate.status === 'running')
  if (run === undefined) return
  await finishAdvisor($, run.id, { status: isFailed ? 'failed' : 'done', report: answer })
  if (run.origin === 'council') await kickSummonses($)
}

// The folders an advisor agent may read, or undefined for any other agent.
async function advisorFoldersOf($: EngineInterface, agentId: string): Promise<string[] | undefined> {
  const known = advisorAgents.get(agentId)
  if (known !== undefined) return known
  const run = (await read($, courtAtom)).advisors?.find(candidate => candidate.agentId === agentId)
  if (run === undefined) return undefined
  const root = await $.session.root()
  return run.relFolders.map(folder => joinUnder(root, folder))
}

// `/council advise [deep] <folder> <question>`: the person sends the advisor
// (Opus by default) to read one folder; its report goes to Claude with their
// next message. The command returns once the run is recorded.
async function adviseCommand($: EngineInterface, args: string): Promise<string> {
  const parsed = readAdviseArgs(args)
  if ('error' in parsed) return parsed.error
  const root = await $.session.root()
  const relFolder = relativeFolder(root, parsed.folder)
  if (relFolder === undefined) return `"${parsed.folder}" must be a subfolder of ${root}.`
  const folder = joinUnder(root, relFolder)
  const isFolder = await $.fs
    .stat(folder)
    .then(stat => stat.kind === 'dir')
    .catch(() => false)
  if (!isFolder) return `There is no folder ${relFolder}/ under ${root}.`
  const level = settings.advisorAgentLevels[parsed.isDeep ? 1 : 0]!
  const questions: AdvisorQuestion[] = [{ question: parsed.question, askedBy: ['you'] }]
  const run = await addAdvisorRun($, { origin: 'owner', relFolders: [relFolder], questions, isDeep: parsed.isDeep, model: level.model, effort: level.effort })
  await update($, isChamberShownAtom, () => false)
  await openCouncilPane($)
  void startAdvisorAgent($, run.id, [folder], advisorTask([folder], questions), level)
    .then(failure => (failure === undefined ? undefined : finishAdvisor($, run.id, { status: 'failed', report: `It could not start: ${failure}` })))
    .catch(() => undefined)
  return `The council's advisor (${run.id}: ${level.model} at ${level.effort} effort, read-only) is looking into ${relFolder}/. Its report goes to Claude with your next message.`
}

// The person's finished advisors, not yet sent: their reports, for Claude
// beside the person's prompt (hidden from the transcript), marked sent.
async function takeAdvisorReports($: EngineInterface): Promise<string[]> {
  const ready = ((await read($, courtAtom)).advisors ?? []).filter(run => run.origin === 'owner' && isAdvisorFinished(run) && run.isDelivered !== true)
  if (ready.length === 0) return []
  const ids = ready.map(run => run.id)
  await update($, courtAtom, current => ({ ...current, advisors: (current.advisors ?? []).map(run => (ids.includes(run.id) ? { ...run, isDelivered: true } : run)) }))
  return ready.map(advisorDigest)
}

// ── Council summons: one advisor per ruling on orders ─────────────────────

// When members whose concern is 3 or 4 ask CHECK questions, the council holds
// the plan's orders and sends one advisor (never one per member) to its
// folders with every question, deduped. propose_orders answers at once; when
// the advisor reports, the members sit a second round with its findings,
// which releases or refuses the held orders, and the main session is told. A
// plan already refused by a 5 summons no one. On a timeout or a failure the
// council rules on its first round. Everything the second round needs is in
// the court (CourtSummons), so a reload never loses a summons.

// The members' CHECK questions, deduped, or undefined when none apply.
function summonsChecks(council: Council, proposal: Proposal, replies: ReadonlyMap<AdvisorId, string>): AdvisorQuestion[] | undefined {
  if (ruling(council, proposal.plan).gravest >= REFUSE_AT) return undefined
  const checks = seatsOf(council).flatMap(seat => {
    const report = council.advisors[seat.id]
    const reply = replies.get(seat.id)
    if (report?.status !== 'done' || report.concern < conditionAtOf(council) || report.concern >= REFUSE_AT || reply === undefined) return []
    const question = parseCheck(reply)
    return question === undefined ? [] : [{ title: seat.title, question }]
  })
  return checks.length === 0 ? undefined : summonsQuestions(checks)
}

// Holds the plan's orders, records the summons, starts the advisor and
// answers at once. An advisor that can't start leaves the council to rule on
// its first round now, and that ruling is the answer.
async function holdForAdvisor($: EngineInterface, council: Council, proposal: Proposal, root: string, replies: ReadonlyMap<AdvisorId, string>, questions: AdvisorQuestion[]): Promise<string> {
  const level = settings.advisorAgentLevels[0]!
  const relFolders = [...new Set(proposal.dispatches.map(dispatch => dispatch.folder))]
  const folders = relFolders.map(folder => joinUnder(root, folder))
  const run = await addAdvisorRun($, { origin: 'council', relFolders, questions, isDeep: false, model: level.model, effort: level.effort })
  const now = await $.clock.now()
  // The first round's levels show on the held orders; the second round's replace them.
  const levels = orderLevels(
    seatsOf(council).flatMap(seat => replies.get(seat.id) ?? []),
    proposal.dispatches.map(dispatch => dispatch.role),
  )
  let orders: Order[] = []
  const base = await docketBase($)
  await update($, courtAtom, current => {
    orders = newOrders(current, proposal, root, [], now, levels, 'held', settings.leaveApproval)
    const summons: CourtSummons = {
      ...(base !== undefined ? { docketId: base.id } : {}),
      runId: run.id,
      phase: 'checking',
      orderIds: orders.map(order => order.id),
      proposal,
      root,
      petition: lastPetition,
      council,
      replies: Object.fromEntries(replies),
      questions,
      startedAt: now,
      deadline: now + SUMMONS_TIMEOUT_MS,
    }
    return { ...withOrdersAdded(current, orders), summonses: [...(current.summonses ?? []), summons] }
  })
  // The first round, held: its second round's entry follows it (by the run id too).
  recordDocket($, base, {
    kind: 'orders',
    plan: proposal.plan,
    dispatches: docketDispatches(proposal.dispatches),
    ...sittingFields(council, replies, proposal.dispatches.length),
    outcome: 'held',
    orderIds: orders.map(order => order.id),
    runId: run.id,
  })
  await markCouncilDocket($, council.topic, base?.id)
  const failure = await startAdvisorAgent($, run.id, folders, advisorTask(folders, questions, proposal.plan), level)
  if (failure !== undefined) {
    await finishAdvisor($, run.id, { status: 'failed', report: `It could not start: ${failure}` })
    rulingSummonses.add(run.id)
    try {
      return (await ruleSummons($, run.id, false)) ?? 'The council could not rule on the plan; ask the person.'
    } finally {
      rulingSummonses.delete(run.id)
    }
  }
  armSummonsTimer($, run.id, SUMMONS_TIMEOUT_MS)
  $.ui.toast(`The council holds ${orders.map(order => order.id).join(', ')} while its advisor (${run.id}) checks ${questions.length === 1 ? 'a question' : `${questions.length} questions`}.`)
  return heldText(orders, run.id, questions, SUMMONS_TIMEOUT_MS)
}

// The summonses this module is ruling on now, and each one's deadline timer.
const rulingSummonses = new Set<string>()
const summonsTimers = new Map<string, Timer>()

// When the deadline passes, look again (the timer only starts the check).
function armSummonsTimer($: EngineInterface, runId: string, ms: number): void {
  summonsTimers.get(runId)?.cancel()
  summonsTimers.set(
    runId,
    $.clock.after(ms, () => {
      summonsTimers.delete(runId)
      void kickSummonses($).catch(() => undefined)
    }),
  )
}

// Starts the second round of every summons that is due (advisor back, failed
// or out of time, or a round a reload dropped), each from a timer of its own
// so no hook waits on it; and arms the deadline timer of any summons still
// out that has none (after a reload). Cheap: run wherever the court is acted on.
async function kickSummonses($: EngineInterface): Promise<void> {
  const court = await read($, courtAtom)
  const summonses = court.summonses ?? []
  if (summonses.length === 0) return
  const now = await $.clock.now()
  for (const runId of summonsDue(summonses, court.advisors ?? [], now, rulingSummonses)) {
    rulingSummonses.add(runId)
    $.clock.after(0, () => {
      void ruleSummons($, runId)
        .catch(() => undefined)
        .finally(() => rulingSummonses.delete(runId))
    })
  }
  for (const summons of summonses) {
    if (summons.phase === 'checking' && !rulingSummonses.has(summons.runId) && !summonsTimers.has(summons.runId)) armSummonsTimer($, summons.runId, Math.max(0, summons.deadline - now))
  }
}

// The second round of a held ruling, then the release or refusal of its held
// orders, recorded as the court's ruling; the main session is told (`isTold`),
// and the line is returned. Run outside any hook (a timer), or awaited by
// propose_orders only when the advisor could not start.
async function ruleSummons($: EngineInterface, runId: string, isTold = true): Promise<string | undefined> {
  const now = await $.clock.now()
  let summons: CourtSummons | undefined
  await update($, courtAtom, current => {
    summons = current.summonses?.find(candidate => candidate.runId === runId)
    if (summons === undefined) return current
    // A round a reload dropped starts again from the outcome it saved.
    if (summons.phase === 'ruling' && summons.outcome !== undefined) return current
    // Past its deadline, an advisor still out has timed out.
    const found = current.advisors?.find(candidate => candidate.id === runId)
    const timedOut = found?.status === 'running' && now >= summons.deadline ? withAdvisorChanged(current, runId, candidate => finishedRun(candidate, 'timed-out', '', now)) : current
    const run = timedOut.advisors?.find(candidate => candidate.id === runId)
    if (run?.status === 'running') {
      summons = undefined
      return current
    }
    // The outcome is saved with the summons, so the round never needs the run again.
    const status: AdvisorRunStatus = run?.status === 'done' || run?.status === 'timed-out' ? run.status : 'failed'
    const outcome = { status, findings: status === 'done' ? (run?.report ?? '').trim() : '' }
    summons = { ...summons, phase: 'ruling', outcome }
    const marked = summons
    return { ...timedOut, summonses: (current.summonses ?? []).map(candidate => (candidate.runId === runId ? marked : candidate)) }
  })
  const held = summons as CourtSummons | undefined
  if (held === undefined || held.outcome === undefined) return undefined
  summonsTimers.get(runId)?.cancel()
  summonsTimers.delete(runId)
  const { status, findings } = held.outcome
  const record: RulingSummons = { advisorId: runId, questions: held.questions, status, findings }
  const proposal: Proposal = held.proposal
  // Orders Claude withdrew meanwhile are left alone; with none left, no second round.
  const stillHeld = (await read($, courtAtom)).orders.filter(order => held.orderIds.includes(order.id) && order.status === 'held')
  if (stillHeld.length === 0) {
    await update($, courtAtom, current => ({ ...current, summonses: (current.summonses ?? []).filter(candidate => candidate.runId !== runId) }))
    return undefined
  }
  const replies = new Map(Object.entries(held.replies))
  let council = held.council
  if (status === 'done') {
    const onReply = (seatId: AdvisorId, text: string) => replies.set(seatId, replies.has(seatId) ? `${text}\n${replies.get(seatId)}` : text)
    // Shown in the chamber only while it still holds this ruling's first round.
    const isShown = !isCouncilWorking && (await read($, councilAtom))?.topic === held.council.topic
    council = await secondRound($, held.council, findingsContext(held.questions, record.findings), orderAsk(proposal.dispatches.length, false, hasLeave(proposal)), onReply, isShown)
  }
  const { result, levels } = await finalRuling($, council, proposal, held.petition, replies, record)
  // Held knights claimed no place: one whose place a knight now holds must wait.
  const waits: string[] = []
  if (result.isApproved && stillHeld.some(order => order.role === 'knight')) {
    await expireOrders($)
    const working = await workingKnights($, (await read($, courtAtom)).orders)
    for (const order of stillHeld.filter(candidate => candidate.role === 'knight')) {
      const place = await placeOf($, order.folder)
      const clash = knightClash(place, working, order.id)
      if (clash !== undefined) waits.push(`${order.id} must wait: ${clash.order.id} holds ${clashReason(place, clash.place)}.`)
    }
  }
  const ruledAt = await $.clock.now()
  const refusal = `refused after the advisor's check (gravest concern ${result.gravest}/5)`
  const base = await docketBase($)
  let settled: Order[] = []
  await update($, courtAtom, current => {
    settled = []
    const orders = current.orders.map(order => {
      const index = held.orderIds.indexOf(order.id)
      if (index < 0) return order
      const level = levels[index]
      const next = result.isApproved
        ? moved(order, 'approve', ruledAt, { conditions: result.conditions, approvedAt: ruledAt, ...(level !== undefined ? { level } : {}), ...leaveOnApproval(order, settings.leaveApproval) })
        : moved(order, 'refuse', ruledAt, { withdrawnReason: refusal })
      if (next === undefined) return order
      settled.push(next)
      return next
    })
    return { ...current, orders, summonses: (current.summonses ?? []).filter(candidate => candidate.runId !== runId), rulings: [...current.rulings.slice(-9), rulingRecord(result, base?.id)] }
  })
  // The second round, linked to the first by its entry and the run id.
  recordDocket($, base, {
    kind: 'summons',
    plan: proposal.plan,
    dispatches: docketDispatches(proposal.dispatches),
    ...sittingFields(council, replies, proposal.dispatches.length),
    outcome: result.isApproved ? 'approved' : 'refused',
    ...rulingFields(result),
    orderIds: settled.length > 0 ? settled.map(order => order.id) : stillHeld.map(order => order.id),
    runId,
    ...(held.docketId !== undefined ? { follows: held.docketId } : {}),
    findings: status === 'done' ? findingsSummary(findings) : `The advisor ${status === 'timed-out' ? 'timed out' : 'failed'}; the council ruled on its first round.`,
  })
  await markCouncilDocket($, held.council.topic, base?.id)
  if (settled.length === 0) return undefined
  const line = summonsRuledLine(result, settled, waits)
  $.ui.toast(`Council: ${settled.map(order => order.id).join(', ')} ${result.isApproved ? 'released' : 'refused'} after its advisor (${runId}).`)
  if (result.isApproved) toastPendingLeave($, settled)
  if (isTold) await tellMain($, line)
  return line
}

// The members reconsider once, with `context` (the advisor's findings) added:
// the second round of a ruling. Shown in the chamber when `isShown`.
async function secondRound($: EngineInterface, council: Council, context: string, extra: string, onReply: (seatId: AdvisorId, text: string) => void, isShown: boolean): Promise<Council> {
  let current = withReconsidering(council, context)
  const generation = isShown ? ++councilGeneration : undefined
  const isMirrored = () => generation !== undefined && generation === councilGeneration
  const mirror = async () => {
    if (isMirrored()) await update($, councilAtom, () => current)
  }
  await mirror()
  if (isMirrored()) isCouncilWorking = true
  try {
    await Promise.all(
      seatsOf(current).map(async seat => {
        const report = current.advisors[seat.id]
        if (report === undefined) return
        const reply = await askAdvisorModel($, { purpose: 'summons-round2' }, current.isDeep, advisorSystemPrompt(seat, current.standing), reconsiderPrompt(current, report, extra), 450).catch(() => undefined)
        if (reply?.isAnswered) onReply(seat.id, reply.text)
        current = withVerdict(current, seat.id, reply?.isAnswered ? reply.text : undefined)
        await mirror()
      }),
    )
  } finally {
    if (isMirrored()) isCouncilWorking = false
  }
  return current
}

// ── Knight overlap ────────────────────────────────────────────────────────

// Each folder's git repository (the nearest folder at or above it holding a
// .git file or folder), found once per session.
const repoCache = new Map<string, string | null>()

async function repoOf($: EngineInterface, folder: string): Promise<string | null> {
  const cached = repoCache.get(folder)
  if (cached !== undefined) return cached
  let found: string | null = null
  for (const candidate of repoCandidates(folder)) {
    if (await $.fs.exists(joinUnder(candidate, '.git')).catch(() => false)) {
      found = candidate
      break
    }
  }
  repoCache.set(folder, found)
  return found
}

async function placeOf($: EngineInterface, folder: string): Promise<Place> {
  return { folder, repo: await repoOf($, folder) }
}

// The knights holding a place now (dispatched, unsettled or waiting), each with its place.
async function workingKnights($: EngineInterface, orders: readonly Order[]): Promise<Array<{ order: Order; place: Place }>> {
  return Promise.all(orders.filter(holdsClaim).map(async order => ({ order, place: await placeOf($, order.folder) })))
}

// A proposal's knight that would work where a knight holds its place now:
// refused before the council sits. Knights within one proposal, or beside
// orders only approved, are not refused here: the dispatch check holds them
// to one at a time.
async function proposalClash($: EngineInterface, proposal: Proposal, root: string): Promise<string | undefined> {
  if (!proposal.dispatches.some(dispatch => dispatch.role === 'knight')) return undefined
  await expireOrders($)
  const working = await workingKnights($, (await read($, courtAtom)).orders)
  if (working.length === 0) return undefined
  for (const [index, dispatch] of proposal.dispatches.entries()) {
    if (dispatch.role !== 'knight') continue
    const place = await placeOf($, joinUnder(root, dispatch.folder))
    const clash = knightClash(place, working)
    if (clash !== undefined) {
      return `Dispatch ${index + 1} (a knight in ${dispatch.folder}/) would work in ${clashReason(place, clash.place)} as ${clash.order.id}, ${claimHolderText(clash.order)}. Two knights never work in overlapping places at once: wait for ${clash.order.id} to finish, then propose again (knights one after another in one repository are fine).`
    }
  }
  return undefined
}

// Knight dispatches are checked one at a time, and a knight whose spawn is
// under way counts as at work, so two dispatched together can't both pass.
let knightQueue: Promise<unknown> = Promise.resolve()
const startingKnights = new Map<string, Order>()

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = knightQueue.then(work, work)
  knightQueue = run.catch(() => undefined)
  return run
}

// ── Orders whose agent is gone ────────────────────────────────────────────

// Every agent the engine lists, in any status (a waiting or idle agent is not
// gone); undefined when the list can't be read, so nothing is released.
async function listedAgents($: EngineInterface): Promise<Set<string> | undefined> {
  const agents = await $.agent.list().catch(() => undefined)
  return Array.isArray(agents) ? new Set(agents.map(agent => agent.id)) : undefined
}

// Orders approved long ago and never dispatched expire: withdrawn as
// "expired" (court.ts withExpired). A dispatched, unsettled or waiting order
// whose agent the engine no longer lists becomes lost (court.ts
// withLostAgents), and a running advisor whose agent is gone fails. Run
// wherever the court is looked at or acted on, so no timer is needed (the
// agent list is read only while an agent is out).
async function expireOrders($: EngineInterface): Promise<void> {
  const [now, court] = await Promise.all([$.clock.now(), read($, courtAtom)])
  const hasAgents = court.orders.some(order => order.agentId !== null && nextStatus(order.status, 'gone') !== undefined) || (court.advisors ?? []).some(run => run.status === 'running' && run.agentId !== null)
  let listed: Set<string> | undefined
  if (hasAgents) listed = await listedAgents($)
  // A knight whose spawn is under way has no agent id yet, and is never lost.
  const release = (current: Court): Court => {
    const orders = withExpired(current.orders, now)
    const released = listed === undefined ? orders : withLostAgents(orders, listed, now)
    const started = current.advisors === undefined ? undefined : withUnstartedAdvisors(current.advisors, spawningRuns, now)
    const advisors = listed === undefined || started === undefined ? started : withStaleAdvisors(started, listed, now)
    return released === current.orders && advisors === current.advisors ? current : { ...current, orders: [...released], ...(advisors ? { advisors: [...advisors] } : {}) }
  }
  if (release(court) !== court) await update($, courtAtom, release)
  // A summons whose advisor is back, gone or out of time is ruled on (in the background).
  await kickSummonses($)
}

// The withdraw_orders tool: Claude retires approved orders it won't dispatch.
async function withdrawOrdersTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const withdrawal = readWithdrawal(input)
  if ('error' in withdrawal) return withdrawal.error
  await expireOrders($)
  const [now, court] = await Promise.all([$.clock.now(), read($, courtAtom)])
  const outcome = withdrawOrders(court.orders, withdrawal.ids, withdrawal.reason, now)
  if (outcome.withdrawn.length > 0) {
    await update($, courtAtom, current => ({ ...current, orders: withdrawOrders(current.orders, withdrawal.ids, withdrawal.reason, now).orders }))
  }
  return withdrawalText(outcome, withdrawal.reason)
}

// The arbiter's review of an approved plan's conditions: one low-effort call
// on the advisor model, as the member itself (its own system prompt, with the
// arbiter's request added). With no arbiter, or one not seated, the ruling
// stands as it is; a failed call keeps every condition, with a note saying so.
async function arbitrate($: EngineInterface, council: Council, proposal: Proposal, result: RulingResult, petition: string | null): Promise<RulingResult> {
  if (settings.arbiter === null) return result
  const seat = arbiterSeat(council, settings.arbiter)
  if (seat === undefined) {
    $.ui.toast(`Council: the arbiter "${settings.arbiter}" is not seated here, so the conditions stand unreviewed.`)
    return result
  }
  let review: ArbiterDecision[] | { failure: string }
  try {
    const reply = await completeModel($, { purpose: 'arbiter' }, {
      model: settings.advisorModel,
      effort: 'low',
      system: advisorSystemPrompt(seat, council.standing, true),
      prompt: arbiterPrompt(proposal, petition, result.proposed),
      maxTokens: 800,
      timeoutMs: 60000,
    })
    review = reply.isAnswered
      ? parseArbiterReply(reply.text, result.proposed.length)
      : { failure: reply.reason === 'aborted' ? 'the call timed out or was cut short' : reply.reason === 'api-error' ? 'the call failed' : 'it gave no answer' }
  } catch {
    review = { failure: 'the call failed' }
  }
  return withArbiterReview(result, seat, review)
}

// A council agent's dispatch: refused without an approved order; otherwise
// given its order's scope, todos, conditions and the folder's CLAUDE.md.
async function dispatchOrder($: EngineInterface, e: { subagentType: string; description: string; prompt: string }): Promise<{ deny: string } | { order: Order; prompt: string; description: string } | undefined> {
  const isCouncilAgent = Object.values(AGENT_TYPES).includes(e.subagentType)
  // An order that has expired is no longer open to this dispatch.
  if (isCouncilAgent) await expireOrders($)
  const court = await read($, courtAtom)
  if (!isCouncilAgent) {
    if (court.isInSession && e.subagentType !== 'fork') {
      return { deny: `Court mode is on: dispatch work as ${AGENT_TYPES.scout} or ${AGENT_TYPES.knight} with an order from mcp__council__propose_orders.` }
    }
    return undefined
  }
  const order = matchOrder(court.orders, e.subagentType, e.description, e.prompt)
  if (order === undefined) {
    const held = heldRefusal(court.orders, e.subagentType, e.description, e.prompt)
    if (held !== undefined) return { deny: held }
    const open = court.orders.filter(isOpen).map(candidate => `${candidate.id} (${candidate.role}, ${candidate.relFolder}/)`)
    return {
      deny: open.length > 0 ? `Name the order this carries in the description: open orders are ${open.join(', ')}.` : 'No approved order for this dispatch. Propose it with mcp__council__propose_orders first.',
    }
  }
  // Leave the person has yet to grant holds the order back.
  const leaveDenial = leaveRefusal(order)
  if (leaveDenial !== undefined) return { deny: leaveDenial }
  // A knight waits while another works in an overlapping place.
  if (order.role === 'knight') {
    const refusal = await oneAtATime(async () => {
      if (startingKnights.has(order.id)) return `${order.id} is already being dispatched.`
      const working = [...(await workingKnights($, (await read($, courtAtom)).orders)), ...(await Promise.all([...startingKnights.values()].map(async other => ({ order: { ...other, status: 'dispatched' as const }, place: await placeOf($, other.folder) }))))]
      const place = await placeOf($, order.folder)
      const clash = knightClash(place, working, order.id)
      if (clash !== undefined) {
        return `${order.id} (a knight in ${order.relFolder}/) would work in ${clashReason(place, clash.place)} as ${clash.order.id}, ${claimHolderText(clash.order)}. Two knights never work in overlapping places at once: wait for ${clash.order.id} to finish, then dispatch ${order.id}.`
      }
      startingKnights.set(order.id, order)
      return undefined
    })
    if (refusal !== undefined) return { deny: refusal }
  }
  const instructions = await $.fs.read(joinUnder(order.folder, 'CLAUDE.md')).catch(() => undefined)
  return {
    order,
    prompt: dispatchPrompt(order, typeof instructions === 'string' ? instructions : null, e.prompt),
    description: e.description.includes(order.id) ? e.description : `${order.id} ${e.description}`.slice(0, 60),
  }
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// A council agent's tool call: its todos move it along, its edits are counted,
// and a knight's file change outside its folder is refused.
async function followAgentCall($: EngineInterface, agentId: string, tool: string, input: Record<string, unknown>): Promise<{ deny: string } | { order: Order } | undefined> {
  const court = await read($, courtAtom)
  const order = court.orders.find(candidate => candidate.agentId === agentId && candidate.status === 'dispatched')
  if (order === undefined) return undefined
  if (FILE_TOOLS.has(tool)) {
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
    // Only an absolute path the check can place inside the folder passes.
    if (!isInside(order, path)) {
      return {
        deny: `Order ${order.id} is scoped to ${order.relFolder}/; ${path || 'that path'} is outside it, or can't be placed inside it (give the full absolute path, e.g. ${order.folder}). Work inside the folder, or report that the order needs a change.`,
      }
    }
  }
  const todos = tool === 'TodoWrite' || tool === PROGRESS_TOOL ? readTodos(input) : undefined
  await updateOrder(
    $,
    candidate => candidate.id === order.id,
    // A new list keeps the calls already credited; any other call is credited to the task in progress.
    current => ({ ...current, steps: current.steps + 1, todos: todos ? carryCalls(current.todos, todos) : creditCall(current.todos) }),
  )
  return { order }
}

// Moves one order through the lifecycle (court.ts moved), inside the update;
// the order as moved, or undefined when the table refused the event (its
// status changed meanwhile) or there is no such order.
async function moveOrder($: EngineInterface, id: string, event: OrderEvent, fields: Parameters<typeof moved>[3] = {}): Promise<Order | undefined> {
  const now = await $.clock.now()
  let result: Order | undefined
  await update($, courtAtom, current => {
    result = undefined
    const order = current.orders.find(candidate => candidate.id === id)
    const next = order === undefined ? undefined : moved(order, event, now, fields)
    if (next === undefined) return current
    result = next
    return { ...current, orders: current.orders.map(candidate => (candidate.id === id ? next : candidate)) }
  })
  return result
}

// A line for the main session: appended to its conversation as a row the
// model reads on its loop's next request (hidden from the person), or, when
// that is refused, kept for the person's next prompt.
async function tellMain($: EngineInterface, line: string): Promise<void> {
  const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: line }] } }).catch(() => undefined)
  if (appended !== undefined && appended.deny === undefined) return
  await update($, courtAtom, current => ({ ...current, notices: [...(current.notices ?? []).slice(-9), line] }))
}

// The lines kept for the person's next prompt, taken once.
async function takeNotices($: EngineInterface): Promise<string[]> {
  const notices = (await read($, courtAtom)).notices ?? []
  if (notices.length === 0) return []
  await update($, courtAtom, current => {
    const { notices: _taken, ...rest } = current
    return rest
  })
  return notices
}

const ENDINGS: Partial<Record<Order['status'], string>> = { done: 'is back from', unsettled: 'paused with todos open in', failed: 'fell in' }

// An agent's turn ended: its order is done (every todo checked off, or none
// listed), unsettled (todos open: the main session is told, and settles it),
// or failed (the turn ended other than by answering). A lost order's late
// answer is kept as its report; its status stays.
async function finishOrder($: EngineInterface, agentId: string, answer: string, reason: string): Promise<void> {
  const court = await read($, courtAtom)
  const order = court.orders.find(candidate => candidate.agentId === agentId && (candidate.status === 'dispatched' || candidate.status === 'lost'))
  if (order === undefined) return
  // The whole report (it opens in full in the court), line breaks kept; after a
  // wake, the earlier report comes first.
  const answered = answer.replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000)
  const report = joinedReport(order.wakes !== undefined || order.status === 'lost' ? order.report : '', answered)
  if (order.status === 'lost') {
    await updateOrder($, candidate => candidate.id === order.id, current => ({ ...current, report }))
    return
  }
  // A recalled agent's turn end recalls its order, whatever its todos.
  if (order.recall !== undefined) {
    const recalled = await moveOrder($, order.id, 'recall', { report: recalledReport(order, report) })
    if (recalled === undefined) return
    $.ui.toast(`${order.id}: the ${order.role} is recalled from ${order.relFolder}/.`)
    await tellMain($, recalledLine(recalled))
    return
  }
  const finished = await moveOrder($, order.id, turnEvent(order, reason), { report })
  if (finished === undefined) return
  $.ui.toast(`${order.id}: the ${order.role} (L${levelOf(order)}) ${ENDINGS[finished.status] ?? 'is back from'} ${order.relFolder}/.`)
  if (finished.status === 'unsettled') await tellMain($, unsettledLine(finished))
}

// The effort a council agent's request runs at, or undefined for any other
// agent. Read from the court when this module doesn't know it (after a reload).
async function stepEffortFor($: EngineInterface, agentId: string): Promise<string | undefined> {
  const known = stepEfforts.get(agentId)
  if (known !== undefined) return known
  const court = await read($, courtAtom)
  const effort = court.orders.find(order => order.agentId === agentId)?.effort ?? court.advisors?.find(run => run.agentId === agentId)?.effort
  if (effort !== undefined) stepEfforts.set(agentId, effort)
  return effort
}

// `/council level <order> <1-3>`: the person changes an approved order's level.
async function levelCommand($: EngineInterface, id: string, value: string): Promise<string> {
  await expireOrders($)
  const outcome = setOrderLevel((await read($, courtAtom)).orders, id, value)
  if ('error' in outcome) return outcome.error
  await update($, courtAtom, current => {
    const again = setOrderLevel(current.orders, id, value)
    return 'error' in again ? current : { ...current, orders: again.orders }
  })
  return outcome.message
}

// What an order's level runs on (settings scoutLevels, knightLevels).
const levelSetting = (order: Order): ModelEffort => (order.role === 'knight' ? settings.knightLevels : settings.scoutLevels)[levelOf(order) - 1]!

// An agent woke (a timer, a background task, a message). With no order behind
// it, or an order on the road, nothing changes. An unsettled or waiting order
// still holds its place, so it goes back on the road; so does a scout's. A
// settled or lost knight order goes back only while its place is free:
// otherwise the wake is denied (which parks the agent) and the person is told
// why. Knight wakes are checked in the dispatch queue, so a wake and a
// dispatch can't both take one place.
async function wakeOrder($: EngineInterface, agentId: string): Promise<{ deny: string } | undefined> {
  const found = (await read($, courtAtom)).orders.find(candidate => candidate.agentId === agentId)
  if (found === undefined) return undefined
  if (found.effort !== undefined) stepEfforts.set(agentId, found.effort)
  if (found.status === 'dispatched') return undefined
  // A recalled order never goes back on the road.
  if (found.status === 'recalled') {
    const verdict = wakeVerdict(found, undefined)
    if ('deny' in verdict) {
      $.ui.toast(`Council: ${verdict.deny} Its agent stays parked.`)
      return verdict
    }
  }
  const needsClaim = found.role === 'knight' && !holdsClaim(found)
  if (!needsClaim) {
    await moveOrder($, found.id, 'wake')
    return undefined
  }
  // Holders whose agent is gone are lost first, so a stale claim never parks this one.
  await expireOrders($)
  return oneAtATime(async () => {
    const orders = (await read($, courtAtom)).orders
    const order = orders.find(candidate => candidate.id === found.id) ?? found
    const place = await placeOf($, order.folder)
    const starting = await Promise.all([...startingKnights.values()].map(async other => ({ order: { ...other, status: 'dispatched' as const }, place: await placeOf($, other.folder) })))
    const clash = knightClash(place, [...(await workingKnights($, orders)), ...starting], order.id)
    const verdict = wakeVerdict(order, clash, clash === undefined ? undefined : clashReason(place, clash.place))
    if ('deny' in verdict) {
      $.ui.toast(`Council: ${verdict.deny} Its agent stays parked.`)
      return verdict
    }
    await moveOrder($, order.id, 'wake')
    return undefined
  })
}

// The settle_order tool: the main session says how an unsettled or waiting order ended.
async function settleOrderTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const settlement = readSettlement(input)
  if ('error' in settlement) return settlement.error
  await expireOrders($)
  const now = await $.clock.now()
  const outcome = settleOrder((await read($, courtAtom)).orders, settlement, now)
  if ('error' in outcome) return outcome.error
  await update($, courtAtom, current => {
    const again = settleOrder(current.orders, settlement, now)
    return 'error' in again ? current : { ...current, orders: again.orders }
  })
  return outcome.message
}

// `/council grant <order>` or `/council deny-leave <order>` (or the court's
// buttons): the person rules on an order's leave. Never a tool: Claude can't
// grant leave. Claude is told, so it can dispatch the order.
async function leaveAction($: EngineInterface, id: string, verdict: 'grant' | 'deny'): Promise<string> {
  await expireOrders($)
  let outcome = { error: `No order ${id}.` } as ReturnType<typeof ruleOnLeave>
  let asked = undefined as Order | undefined
  await update($, courtAtom, current => {
    outcome = ruleOnLeave(current.orders, id, verdict)
    asked = current.orders.find(candidate => candidate.id === id.trim().toUpperCase())
    return 'error' in outcome ? current : { ...current, orders: outcome.orders }
  })
  if ('error' in outcome) return outcome.error
  const { order } = outcome
  // The leave as it was asked (a denial drops it from the order).
  await recordSitting($, {
    kind: 'leave',
    dispatches: [{ folder: order.relFolder, role: order.role, ...(asked?.leave ? { leave: [...asked.leave] } : {}) }],
    outcome: verdict === 'grant' ? 'granted' : 'denied',
    orderIds: [order.id],
    by: 'person',
  })
  await tellMain($, verdict === 'grant' ? `Council: the person granted ${order.id}'s leave; it can be dispatched.` : `Council: the person denied ${order.id}'s leave; it can be dispatched without it.`)
  return outcome.message
}

// `/council release <order>`: the person marks an unsettled or waiting order lost, freeing its place.
async function releaseCommand($: EngineInterface, id: string): Promise<string> {
  await expireOrders($)
  const now = await $.clock.now()
  const outcome = releaseOrder((await read($, courtAtom)).orders, id, now)
  if ('error' in outcome) return outcome.error
  await update($, courtAtom, current => {
    const again = releaseOrder(current.orders, id, now)
    return 'error' in again ? current : { ...current, orders: again.orders }
  })
  return outcome.message
}

// ── Steering orders under way: messages, amendments, recalls ──────────────

// The order whose agent a model's SendMessage names: by agent id, the name the
// dispatch gave it, or its order id; else, through the engine's agent list, a
// teammate address (`name@team`) or its name alone.
async function orderAddressed($: EngineInterface, to: string): Promise<Order | undefined> {
  const orders = (await read($, courtAtom)).orders.filter(order => order.agentId !== null)
  if (orders.length === 0) return undefined
  const direct = orderForRecipient(orders, to)
  if (direct !== undefined) return direct
  const agents = await $.agent.list().catch(() => [])
  const wanted = to.trim().toLowerCase()
  const agent = agents.find(entry => entry.teammateId !== undefined && (entry.teammateId.toLowerCase() === wanted || entry.teammateId.toLowerCase().split('@')[0] === wanted))
  return agent === undefined ? undefined : orders.find(order => order.agentId === agent.id)
}

// `/council message <order> <text>`: the person's own word to an order's agent,
// sent by the plugin (a wake follows the wake rules), recorded on the order.
async function messageCommand($: EngineInterface, id: string, text: string): Promise<string> {
  await expireOrders($)
  const order = (await read($, courtAtom)).orders.find(candidate => candidate.id === id.trim().toUpperCase())
  const refusal = messageRefusal(order, id, text)
  if (refusal !== undefined || order === undefined || order.agentId === null) return refusal ?? `No order ${id}.`
  const sent = await $.session.send({ to: { agentId: order.agentId }, text: personMessageText(order, text) }).catch((error: unknown) => ({ isDelivered: false as const, reason: error instanceof Error ? error.message : String(error) }))
  const now = await $.clock.now()
  await updateOrder($, candidate => candidate.id === order.id, current => withMessage(current, text, now, sent))
  return sent.isDelivered ? `Sent to ${order.id}'s agent (${order.role} in ${order.relFolder}/).` : `Could not reach ${order.id}'s agent: ${sent.reason}`
}

// The amend_order tool: refusals in code first (no model call); otherwise the
// seated council rules on it as on a plan (no summons, no levels, no arbiter),
// and an approved amendment is sent to the agent. The pending entry holds the
// slot while the council sits, so it counts toward the cap at once.
async function amendOrderTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const amendment = readAmendment(input)
  if ('error' in amendment) return amendment.error
  await expireOrders($)
  const at = await $.clock.now()
  let refusal = undefined as string | undefined
  let order = undefined as Order | undefined
  let index = -1
  await update($, courtAtom, current => {
    const found = current.orders.find(candidate => candidate.id === amendment.id)
    refusal = amendRefusal(found, amendment, settings.amendmentsPerOrder)
    if (refusal !== undefined || found === undefined) return current
    index = (found.amendments ?? []).length
    order = { ...found, amendments: [...(found.amendments ?? []), pendingAmendment(amendment, at)] }
    return { ...current, orders: current.orders.map(candidate => (candidate.id === found.id ? order! : candidate)) }
  })
  if (refusal !== undefined || order === undefined) return refusal ?? `No order ${amendment.id}.`
  const asked = order
  const changeOne = (change: (current: Order) => Order) => updateOrder($, candidate => candidate.id === asked.id, change)
  let council: Council | undefined
  try {
    council = await conveneAndWait($, `Amendment to ${asked.id}: ${amendment.change}`, async () => ({ brief: amendmentBrief(asked, amendment, lastPetition) }), { source: 'claude', use: { purpose: 'amend', orderId: asked.id, level: levelOf(asked) } })
  } catch {
    council = undefined
  }
  if (council === undefined) {
    await changeOne(current => withoutAmendment(current, index))
    return 'The council could not sit on the amendment (no one is seated, or another council replaced it); it does not count. Try again, or ask the person.'
  }
  const result = ruling(council, `Amend ${asked.id}: ${amendment.change}`)
  const now = await $.clock.now()
  const base = await docketBase($)
  const current = (await read($, courtAtom)).orders.find(candidate => candidate.id === asked.id) ?? asked
  // Sent only while the order is still under way and not recalled meanwhile.
  const canSend = result.isApproved && current.agentId !== null && isUnderWay(current) && current.recall === undefined
  const delivery = canSend
    ? await $.session
        .send({ to: { agentId: current.agentId! }, text: amendmentText(current, amendment, result.conditions) })
        .catch((error: unknown) => ({ isDelivered: false as const, reason: error instanceof Error ? error.message : String(error) }))
    : undefined
  await update($, courtAtom, court => ({
    ...court,
    orders: court.orders.map(candidate =>
      candidate.id === asked.id
        ? withAmendmentRuled(candidate, index, {
            status: result.isApproved ? 'approved' : 'refused',
            gravest: result.gravest,
            ...(result.isApproved ? { conditions: result.conditions, isDelivered: delivery?.isDelivered === true } : { refusal: result.reason }),
            at: now,
          })
        : candidate,
    ),
    rulings: [...court.rulings.slice(-9), { plan: result.plan, isApproved: result.isApproved, gravest: result.gravest, reason: result.reason, ...(base !== undefined ? { docketId: base.id } : {}) }],
  }))
  recordDocket($, base, {
    kind: 'amendment',
    plan: `Amend ${asked.id}: ${amendment.change}\nWhy: ${amendment.reason}`,
    ...sittingFields(council),
    outcome: result.isApproved ? 'approved' : 'refused',
    ...rulingFields(result),
    orderIds: [asked.id],
  })
  await markCouncilDocket($, council.topic, base?.id)
  const ruled = (await read($, courtAtom)).orders.find(candidate => candidate.id === asked.id) ?? current
  return amendmentResultText(ruled, result, delivery, settings.amendmentsPerOrder)
}

// A recall, by Claude's tool or the person's command: no ruling. A running
// agent is told in its own conversation (its changing calls are refused from
// now on); an unsettled or waiting order is recalled at once.
async function recallOrderAction($: EngineInterface, request: RecallRequest, by: 'claude' | 'person'): Promise<string> {
  await expireOrders($)
  const now = await $.clock.now()
  let outcome = { error: `No order ${request.id}.` } as ReturnType<typeof recallOrder>
  await update($, courtAtom, current => {
    outcome = recallOrder(current.orders, request, by, now)
    return 'error' in outcome ? current : { ...current, orders: outcome.orders }
  })
  if ('error' in outcome) return outcome.error
  const { order } = outcome
  await recordSitting($, {
    kind: 'recall',
    dispatches: [{ folder: order.relFolder, role: order.role }],
    outcome: order.status === 'recalled' ? 'recalled' : 'recalling',
    reason: request.reason,
    orderIds: [order.id],
    by,
  })
  if (order.status === 'recalled') {
    $.ui.toast(`${order.id}: recalled from ${order.relFolder}/.`)
    // Claude hears of a recall the person made; its own tool's answer says it.
    if (by === 'person') await tellMain($, recalledLine(order))
  } else if (order.agentId !== null) {
    await $.session.append({ agentId: order.agentId, message: { type: 'user', content: [{ type: 'text', text: recallNotice(order) }] } }).catch(() => undefined)
  }
  return recallText(order)
}

// A council agent's model request after its order was recalled: counted, and
// once it has had RECALL_STEPS, answered with the council's final reply (the
// text), which ends its turn between steps. Undefined: let it through.
async function recallCeiling($: EngineInterface, agentId: string): Promise<string | undefined> {
  const found = (await read($, courtAtom)).orders.find(order => order.agentId === agentId && order.status === 'dispatched' && order.recall !== undefined)
  if (found === undefined) return undefined
  let reply = undefined as string | undefined
  await updateOrder(
    $,
    order => order.id === found.id,
    order => {
      if (order.recall === undefined) return order
      const step = recallStep(order)
      reply = step.isAnswered ? recallReply(step.order) : undefined
      return step.order
    },
  )
  return reply
}

// The recalled order a council agent's tool call belongs to, if any.
async function recalledOrderOf($: EngineInterface, agentId: string): Promise<Order | undefined> {
  return (await read($, courtAtom)).orders.find(order => order.agentId === agentId && order.status === 'dispatched' && order.recall !== undefined)
}

async function setCourtSession($: EngineInterface, isInSession: boolean): Promise<void> {
  await update($, courtAtom, court => ({ ...court, isInSession, heldPrompt: isInSession ? court.heldPrompt : null }))
  if (isInSession) {
    await update($, isChamberShownAtom, () => false)
    await $.ui.open({ id: COUNCIL_PANE_ID, title: 'The Council', rows: 30 })
  }
}

// Court mode: does this prompt need the council? A quick triage call; a
// failed one sends it to the council.
// 'asked': the prompt names the council (every verdict goes to Claude);
// 'review': triage sent it; 'pass': straight to Claude.
// 'asked': the prompt names the whole council (every verdict goes to Claude);
// a seat: the triage read it as asking that one member; 'review': the triage
// sent it to the council; 'pass': straight to Claude.
type Route = 'asked' | 'review' | 'pass' | { seat: string }

async function triage($: EngineInterface, petition: string): Promise<Route> {
  if (namesWholeCouncil(petition)) return 'asked'
  const { members, root } = await loadMembers($)
  const seated = seatedMembers(members, await unseatedIds($, root)).slice(0, MAX_SEATS)
  const reply = await completeModel($, { purpose: 'triage' }, { model: settings.triageModel, system: TRIAGE_SYSTEM, prompt: triagePrompt(petition, seated), maxTokens: 12, timeoutMs: 15000 })
    .catch(() => undefined)
  const sorted = parseTriage(reply?.isAnswered ? reply.text : undefined, seated.map(member => member.id))
  return sorted.route === 'seat' ? { seat: sorted.id } : sorted.route === 'pass' ? 'pass' : 'review'
}

// Court mode: the council sits on the prompt (briefed from this conversation),
// and its digest goes to Claude beside it, out of the transcript's sight.
async function petitionDigest($: EngineInterface, petition: string, isAsked: boolean, onlySeat?: string): Promise<string> {
  lastPetition = petition
  const council = await conveneAndWait($, petition, () => forkBrief($, petition), { onlySeat })
  if (council !== undefined) {
    const id = await recordSitting($, { kind: 'court', question: petition, ...sittingFields(council), outcome: council.phase === 'done' ? 'adjourned' : 'dissolved' })
    await markCouncilDocket($, council.topic, id)
  }
  return council !== undefined && council.phase === 'done'
    ? councilDigest(council, isAsked)
    : "[Court mode: the person's council could not sit on this prompt; go ahead with care.]"
}

// `/council court [on|off|clear]`.
async function courtCommand($: EngineInterface, action: string): Promise<string> {
  if (action === 'on' || action === 'off') {
    await setCourtSession($, action === 'on')
    return action === 'on' ? 'Court mode is on: your prompts go to the council before Claude, and work is dispatched through approved orders.' : 'Court mode is off.'
  }
  if (action === 'clear') {
    await update($, courtAtom, court => ({ ...court, orders: court.orders.filter(order => !isFinished(order)), advisors: (court.advisors ?? []).filter(run => !isClearable(run, court)) }))
    return 'Finished orders cleared.'
  }
  await update($, isChamberShownAtom, () => false)
  await update($, isDocketOpenAtom, () => false)
  await $.ui.open({ id: COUNCIL_PANE_ID, title: 'The Council', rows: 30 })
  return 'The court is open.'
}

// ── Learning from reconsiders ─────────────────────────────────────────────

async function learningFiles($: EngineInterface) {
  const homePath = await home($)
  if (homePath === '') throw new Error(NO_HOME)
  const folder = `${homePath}/.claude/council/learning`
  return { lessons: `${folder}/lessons.json`, guidance: `${folder}/guidance.md`, proposal: `${folder}/proposed-guidance.md` }
}

const readFileText = ($: EngineInterface, path: string) =>
  $.fs
    .read(path)
    .then(text => (typeof text === 'string' ? text : undefined))
    .catch(() => undefined)

async function readLearning($: EngineInterface) {
  const files = await learningFiles($)
  const [lessons, guidance, proposal] = await Promise.all([readFileText($, files.lessons), readFileText($, files.guidance), readFileText($, files.proposal)])
  return { files, lessons: parseLessons(lessons), guidance: parseGuidance(guidance), proposal: parseProposal(proposal) }
}

// What every advisor of a new council in this project is given.
async function standingFor($: EngineInterface): Promise<string | null> {
  const [project, learning] = await Promise.all([$.session.root(), readLearning($)])
  return standingContext(learning.guidance, learning.lessons, project)
}

// ── The person's profile ──────────────────────────────────────────────────

async function profilePaths($: EngineInterface): Promise<Record<ProfileSource, string> & { home: string }> {
  const [root, homePath] = await Promise.all([$.session.root(), home($)])
  return { home: homePath, user: homePath === '' ? '' : `${homePath}/.claude/council/profile.md`, project: `${root}/.claude/council/profile.md` }
}

// The profile in effect here: the project's file over the person's own, field
// by field; no file is the default (balanced, no scale). Problems name the
// fields left out.
async function loadProfile($: EngineInterface): Promise<{ profile: Profile; paths: Record<ProfileSource, string>; found: Record<ProfileSource, boolean> }> {
  const paths = await profilePaths($)
  const readOne = async (path: string, label: string) => {
    const text = path === '' ? undefined : await readFileText($, path)
    return text === undefined ? undefined : parseProfile(text, label)
  }
  const [user, project] = await Promise.all([readOne(paths.user, '~/.claude/council/profile.md'), readOne(paths.project, '.claude/council/profile.md')])
  const problems = [...(user?.problems ?? []), ...(project?.problems ?? [])]
  const fields = (parsed: { fields: ProfileFields } | undefined) => parsed?.fields
  return {
    profile: mergeProfiles(fields(user), fields(project), problems),
    paths: { user: paths.user || '~/.claude/council/profile.md (no home folder)', project: paths.project },
    found: { user: user !== undefined, project: project !== undefined },
  }
}

// A new council's context, fixed when it convenes: the profile and the
// standing context as every member reads them, and the strictness that sets
// its condition threshold. A failure reads as no profile, no standing.
async function councilContext($: EngineInterface): Promise<{ standing: string | null; strictness: number; problems: string[] }> {
  const [loaded, standing] = await Promise.all([loadProfile($).catch(() => undefined), standingFor($).catch(() => null)])
  const profile = loaded === undefined ? null : profileContext(loaded.profile)
  const parts = [profile, standing].filter((part): part is string => part !== null && part !== '')
  return { standing: parts.length > 0 ? parts.join('\n\n') : null, strictness: loaded?.profile.strictness ?? 0, problems: loaded?.profile.problems ?? [] }
}

// `/council profile`: the profile in effect, each field's file, and any problems.
async function profileCommand($: EngineInterface): Promise<string> {
  const { profile, paths, found } = await loadProfile($)
  return profileReport(profile, paths, found)
}

const rejectedKey = (project: string) => `learning-rejected:${project}`

async function refreshLearning($: EngineInterface): Promise<void> {
  const project = await $.session.root()
  let view: LearningView
  try {
    const { files, lessons, guidance, proposal } = await readLearning($)
    view = {
      project,
      lessons: lessons.filter(lesson => lesson.project === project),
      guidance: guidance.filter(section => section.scope === EVERYWHERE || section.scope === project),
      proposal: proposal !== undefined && proposal.project === project ? proposal.guidance : null,
      proposalPath: files.proposal,
      guidancePath: files.guidance,
      error: null,
    }
  } catch (error) {
    view = { project, lessons: [], guidance: [], proposal: null, proposalPath: '', guidancePath: '', error: `Could not read the lessons: ${error instanceof Error ? error.message : String(error)}` }
  }
  await update($, learningAtom, () => view)
}

async function openLessons($: EngineInterface): Promise<void> {
  await refreshLearning($)
  await update($, isDocketOpenAtom, () => false)
  await update($, isLessonsOpenAtom, () => true)
  await $.ui.open({ id: COUNCIL_PANE_ID, title: 'The Council', rows: 30 })
}

// A finished reconsideration in this project, as a lesson; a summary is
// drafted once enough have gathered.
async function recordLesson($: EngineInterface): Promise<void> {
  const council = await read($, councilAtom)
  if (council === null) return
  const [project, now] = await Promise.all([$.session.root(), $.clock.now()])
  const id = `${new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`
  const lesson = lessonFromReconsider(council, project, new Date(now).toISOString(), id, council.source !== 'claude')
  if (lesson === undefined) return
  const { files, lessons, proposal } = await readLearning($)
  const updated = [...lessons, lesson]
  await $.fs.write(files.lessons, formatLessons(updated))
  if ((await read($, isLessonsOpenAtom))) await refreshLearning($)
  const rejectedAt = (await $.store.get(rejectedKey(project))) as number | undefined
  if (proposal === undefined && isSummaryDue(updated, project, typeof rejectedAt === 'number' ? rejectedAt : undefined)) await draftSummary($, project)
}

// One call drafts guidance from this project's lessons; the person reviews it.
async function draftSummary($: EngineInterface, project: string): Promise<void> {
  const { files, lessons, guidance } = await readLearning($)
  const mine = lessons.filter(lesson => lesson.project === project)
  if (mine.length === 0) return
  const existing = guidance.filter(section => section.scope === EVERYWHERE || section.scope === project).flatMap(section => section.items)
  const reply = await completeModel($, { purpose: 'guidance' }, { model: settings.advisorModel, effort: settings.advisorEffort, system: SUMMARY_SYSTEM, prompt: summaryPrompt(mine, existing, project), maxTokens: 800, timeoutMs: 120000 })
    .catch(() => undefined)
  const draft = reply?.isAnswered ? parseSummary(reply.text) : []
  if (draft.length === 0) {
    $.ui.toast('Council: the guidance summary could not be drafted; the lessons stay as they are.')
    return
  }
  await $.fs.write(files.proposal, formatProposal(project, draft, mine.map(lesson => lesson.id)))
  await refreshLearning($)
  $.ui.toast('Council: a guidance summary of your reconsiders is ready for you to approve (/council lessons).')
}

async function approveSummary($: EngineInterface): Promise<void> {
  const { files, lessons, guidance, proposal } = await readLearning($)
  if (proposal === undefined) return
  // As the person left it (they may have edited the file).
  await $.fs.write(files.guidance, formatGuidance(mergeGuidance(guidance, proposal.guidance)))
  await $.fs.write(files.lessons, formatLessons(lessons.filter(lesson => !proposal.covers.includes(lesson.id))))
  await $.fs.write(files.proposal, '')
  await $.store.delete(rejectedKey(proposal.project))
  await refreshLearning($)
  $.ui.toast('Council: the guidance is updated.')
}

async function rejectSummary($: EngineInterface): Promise<void> {
  const { files, lessons, proposal } = await readLearning($)
  if (proposal === undefined) return
  await $.fs.write(files.proposal, '')
  await $.store.set(rejectedKey(proposal.project), lessons.filter(lesson => lesson.project === proposal.project).length)
  await refreshLearning($)
}

async function forgetLesson($: EngineInterface, id: string): Promise<void> {
  const { files, lessons } = await readLearning($)
  await $.fs.write(files.lessons, formatLessons(lessons.filter(lesson => lesson.id !== id)))
  await refreshLearning($)
}

// ── The docket: every sitting, recorded (docket.ts) ───────────────────────

type DocketBase = Pick<DocketEntry, 'id' | 'time' | 'session' | 'project'>
type DocketFields = Omit<DocketEntry, 'v' | 'id' | 'time' | 'session' | 'project'>

// One session's writes, one after another (sessions take turns through the lock).
let docketQueue: Promise<unknown> = Promise.resolve()
// Entries recorded and not yet written, which the view shows meanwhile.
let docketPending: DocketEntry[] = []
// The project's entries as last read, until a new one is written.
let docketCache: { folder: string; entries: DocketEntry[] } | null = null
// Once per session: the folder made owner-only, the docket pruned, a failure toasted.
const securedDockets = new Set<string>()
const prunedDockets = new Set<string>()
let isDocketFailureToasted = false

// An entry's id, time, session and project; undefined when they can't be
// read (the sitting goes on unrecorded). Fast: no file is touched.
async function docketBase($: EngineInterface): Promise<DocketBase | undefined> {
  try {
    const [now, session, project] = await Promise.all([$.clock.now(), $.session.id(), $.session.root()])
    return { id: docketId(now, Math.random()), time: new Date(now).toISOString(), session, project }
  } catch {
    return undefined
  }
}

// Queues a sitting's entry (redacted and capped) for writing and returns its
// id at once. Nothing waits on the write: a failure is toasted once, and the
// sitting never sees it.
function recordDocket($: EngineInterface, base: DocketBase | undefined, fields: DocketFields): string | undefined {
  if (base === undefined) return undefined
  try {
    const entry = sealEntry({ v: 1, ...base, ...fields })
    docketPending = [...docketPending, entry]
    docketQueue = docketQueue
      .then(() => writeDocketEntry($, entry))
      .catch(error => docketFailed($, error))
      .finally(() => {
        docketPending = docketPending.filter(pending => pending.id !== entry.id)
      })
    return entry.id
  } catch (error) {
    docketFailed($, error)
    return undefined
  }
}

const recordSitting = async ($: EngineInterface, fields: DocketFields) => recordDocket($, await docketBase($), fields)

function docketFailed($: EngineInterface, error: unknown): void {
  if (isDocketFailureToasted) return
  isDocketFailureToasted = true
  try {
    $.ui.toast(`Council: the docket could not be written (${error instanceof Error ? error.message : String(error)}); sittings go on unrecorded.`)
  } catch {
    // Nothing more to do: the sitting goes on.
  }
}

// The sitting's entry, linked from its council (the chamber's docket button).
async function markCouncilDocket($: EngineInterface, topic: string, id: string | undefined): Promise<void> {
  if (id === undefined) return
  await updateCouncil($, current => (current.topic === topic ? { ...current, docketId: id } : current)).catch(() => undefined)
}

async function docketPathsFor($: EngineInterface, project: string): Promise<DocketPaths> {
  const homePath = await home($)
  if (homePath === '') throw new Error(NO_HOME)
  const paths = docketPaths(homePath, projectKey(project))
  if (paths === undefined) throw new Error('its folder could not be placed under the home folder')
  return paths
}

// POSIX: the docket's folders owner-only (0700), once per session. $.fs
// creates folders and files with the default mode, so this runs chmod; on
// Windows the folder keeps the home folder's own access list.
async function secureDocketFolder($: EngineInterface, paths: DocketPaths): Promise<void> {
  if (securedDockets.has(paths.folder)) return
  securedDockets.add(paths.folder)
  if (pathStyleOf(paths.root) === 'windows') return
  await $.process.run(['mkdir', '-p', '-m', '700', paths.folder], { timeoutMs: 5000 }).catch(() => undefined)
  await $.process.run(['chmod', '700', paths.root, paths.folder], { timeoutMs: 5000 }).catch(() => undefined)
}

// POSIX: a new day file owner-only (0600).
async function secureDocketFile($: EngineInterface, path: string): Promise<void> {
  if (pathStyleOf(path) === 'windows') return
  await $.process.run(['chmod', '600', path], { timeoutMs: 5000 }).catch(() => undefined)
}

// Runs `work` holding the project's lock file: written with this call's
// token, held if the token is still there after DOCKET_LOCK.settleMs (a
// session writing at the same moment overwrote it otherwise, and waits). A
// lock older than DOCKET_LOCK.staleMs is taken over; after waitMs it gives up.
async function withDocketLock<T>($: EngineInterface, paths: DocketPaths, work: () => Promise<T>): Promise<T> {
  const token = newToken()
  const started = await $.clock.now()
  for (;;) {
    const now = await $.clock.now()
    if (now - started > DOCKET_LOCK.waitMs) throw new Error('another session held its lock too long')
    if (isLockHeld(parseLock(await readFileText($, paths.lock)), token, now)) {
      await $.clock.sleep(DOCKET_LOCK.retryMs)
      continue
    }
    await $.fs.write(paths.lock, formatLock({ token, at: now }))
    await $.clock.sleep(DOCKET_LOCK.settleMs)
    if (parseLock(await readFileText($, paths.lock))?.token === token) break
  }
  try {
    return await work()
  } finally {
    if (parseLock(await readFileText($, paths.lock))?.token === token) await $.fs.write(paths.lock, '').catch(() => undefined)
  }
}

// The project's day files, read (only those: never another file in the folder).
async function readDocketFiles($: EngineInterface, paths: DocketPaths): Promise<Array<{ name: string; text: string }>> {
  const listed = await $.fs.list(paths.folder).catch(() => [])
  const names = listed.filter(entry => entry.kind === 'file' && !entry.isLink && entry.size > 0 && isDayFileName(entry.name)).map(entry => entry.name)
  const files = await Promise.all(
    names.map(async name => {
      const path = docketFile(paths, name)
      const text = path === undefined ? undefined : await readFileText($, path)
      return text === undefined ? undefined : { name, text }
    }),
  )
  return files.filter((file): file is { name: string; text: string } => file !== undefined)
}

// Retention, under the lock: lines past 180 days or the newest 2,000 dropped.
async function pruneDocket($: EngineInterface, paths: DocketPaths): Promise<void> {
  const [files, now] = await Promise.all([readDocketFiles($, paths), $.clock.now()])
  for (const file of prunedFiles(files, now)) {
    const path = docketFile(paths, file.name)
    if (path !== undefined) await $.fs.write(path, file.text)
  }
}

// One entry onto its day's file, under the lock; the first write of the
// session prunes the docket first.
async function writeDocketEntry($: EngineInterface, entry: DocketEntry): Promise<void> {
  const paths = await docketPathsFor($, entry.project)
  await secureDocketFolder($, paths)
  await withDocketLock($, paths, async () => {
    if (!prunedDockets.has(paths.folder)) {
      prunedDockets.add(paths.folder)
      await pruneDocket($, paths).catch(() => undefined)
    }
    const path = docketFile(paths, dayFileName(entry.time))
    if (path === undefined) throw new Error('its day file could not be named')
    const isThere = await $.fs.exists(path)
    const existing = isThere ? await readFileText($, path) : ''
    // A file that is there but can't be read is never overwritten.
    if (existing === undefined) throw new Error(`${path} could not be read`)
    await $.fs.write(path, withEntryAppended(existing, entry))
    if (!isThere) await secureDocketFile($, path)
  })
  if (docketCache?.folder === paths.folder) docketCache = null
  if (await read($, isDocketOpenAtom)) await refreshDocket($).catch(() => undefined)
}

// This project's entries, newest first: read when the view needs them and
// kept until a new entry is written, with this session's unwritten ones.
async function loadDocket($: EngineInterface): Promise<{ project: string; entries: DocketEntry[] }> {
  const project = await $.session.root()
  const paths = await docketPathsFor($, project)
  let cache = docketCache
  if (cache === null || cache.folder !== paths.folder) {
    const [files, now] = await Promise.all([readDocketFiles($, paths), $.clock.now()])
    cache = { folder: paths.folder, entries: docketEntries(files.map(file => file.text), now) }
    docketCache = cache
  }
  const written = new Set(cache.entries.map(entry => entry.id))
  const pending = docketPending.filter(entry => entry.project === project && !written.has(entry.id)).reverse()
  return { project, entries: [...pending, ...cache.entries] }
}

// The docket view, redrawn: a new filter, page or open entry (an open entry
// moves to the page that holds it).
async function refreshDocket($: EngineInterface, change: { filter?: DocketFilter; offset?: number; openId?: string | null } = {}): Promise<void> {
  const current = await read($, docketAtom)
  const filter = change.filter ?? current?.filter ?? 'all'
  const openId = change.openId !== undefined ? change.openId : (current?.openId ?? null)
  let view: DocketView
  try {
    const { project, entries } = await loadDocket($)
    const offset = change.offset ?? (change.openId ? offsetOf(entries, filter, change.openId) : (current?.offset ?? 0))
    const page = docketPage(entries, filter, offset)
    view = { project, filter, offset: page.offset, total: page.total, entries: page.entries, openId, error: null }
  } catch (error) {
    const project = await $.session.root().catch(() => '')
    view = { project, filter, offset: 0, total: 0, entries: [], openId: null, error: `Could not read the docket: ${error instanceof Error ? error.message : String(error)}` }
  }
  await update($, docketAtom, () => view)
}

// `/council docket`, or a ruling's or the chamber's docket button (`openId`: that entry, open).
async function openDocket($: EngineInterface, openId: string | null = null): Promise<void> {
  await refreshDocket($, openId === null ? { filter: 'all', offset: 0, openId: null } : { filter: 'all', openId })
  await update($, isLessonsOpenAtom, () => false)
  await update($, isRosterOpenAtom, () => false)
  await update($, isDocketOpenAtom, () => true)
  await openCouncilPane($)
}

// Who typed the command: the person at the prompt (or through Remote Control),
// or anything else (a model, a plugin, a schedule).
const isPersonOrigin = (origin: { kind: string } | undefined) => origin?.kind === 'composer' || origin?.kind === 'bridge'

async function councilCommand($: EngineInterface, args: string, origin?: { kind: string }): Promise<string> {
  const trimmed = args.trim()
  const [action = '', target = '', ...words] = trimmed.split(/\s+/)
  // A subcommand only when it's used as one, so "reset the DB first?" or
  // "ask users for consent?" are still questions for the council.
  const isAlone = trimmed.split(/\s+/).length === 1
  // The advisor agent and order levels are the person's alone.
  if (action === 'advise') return isPersonOrigin(origin) ? adviseCommand($, trimmed.replace(/^advise\b/, '')) : "Only the person can send the council's advisor: type /council advise at the prompt."
  if (action === 'level' && /^O\d+$/i.test(target) && words.length === 1) return isPersonOrigin(origin) ? levelCommand($, target, words[0]!) : "Only the person can change an order's level: type /council level at the prompt."
  if ((action === 'grant' || action === 'deny-leave') && (target === '' || /^O\d+$/i.test(target)) && words.length === 0) {
    return isPersonOrigin(origin) ? leaveAction($, target, action === 'grant' ? 'grant' : 'deny') : `Only the person can rule on an order's leave: type /council ${action} at the prompt.`
  }
  if (action === 'release' && (target === '' || /^O\d+$/i.test(target)) && words.length === 0) return isPersonOrigin(origin) ? releaseCommand($, target) : 'Only the person can release an order: type /council release at the prompt.'
  if (action === 'message' && /^O\d+$/i.test(target)) {
    return isPersonOrigin(origin) ? messageCommand($, target, trimmed.replace(/^message\s+\S+\s*/, '')) : "Only the person can message an order's agent: type /council message at the prompt."
  }
  if (action === 'recall' && /^O\d+$/i.test(target)) {
    if (!isPersonOrigin(origin)) return 'Only the person can recall an order this way: type /council recall at the prompt.'
    const reason = trimmed.replace(/^recall\s+\S+\s*/, '').replace(/\s+/g, ' ').slice(0, 200) || 'recalled by the person'
    return recallOrderAction($, { id: target.toUpperCase(), reason }, 'person')
  }
  if (action === 'show' && isAlone) {
    if ((await read($, councilAtom)) === null) return 'The council has not convened. /council <topic> to summon it.'
    await update($, isDocketOpenAtom, () => false)
    await openCouncilPane($)
    return 'The council chamber is open.'
  }
  if (action === 'reset' && isAlone) {
    await dismissCouncil($)
    return 'The council is dismissed.'
  }
  if (action === 'members') return membersCommand($, target, words.join(' '))
  if (action === 'profile' && isAlone) return profileCommand($)
  // Only as a subcommand: "usage of the API?" is still a question for the council.
  if (action === 'usage' && (isAlone || /^usage(\s+since)?\s+\d{4}-\d{2}-\d{2}$/.test(trimmed))) return usageCommand($, trimmed.replace(/^usage\b/, ''))
  if (action === 'court') return courtCommand($, target)
  if (action === 'lessons' && isAlone) {
    await openLessons($)
    return 'The lessons are open in the chamber.'
  }
  if (action === 'docket' && isAlone) {
    await openDocket($)
    return 'The docket is open in the chamber.'
  }
  if (action === 'deep' && target === 'reconsider') return reconsider($, trimmed.replace(/^deep\s+reconsider\b/, '').trim(), true)
  if (action === 'deep') return conveneFromText($, trimmed.replace(/^deep\b/, '').trim() || DEFAULT_COUNCIL_TOPIC, true)
  const current = await read($, councilAtom)
  if (action === 'ask' && current !== null && findAdvisor(seatsOf(current), target) !== undefined) return askAdvisor($, target, words.join(' '))
  if (action === 'reconsider') return reconsider($, trimmed.replace(/^reconsider\b/, '').trim())
  if (action === 'report' && isAlone) return reportCouncil($)
  return conveneFromText($, trimmed || DEFAULT_COUNCIL_TOPIC)
}

// ── Usage ─────────────────────────────────────────────────────────────────
//
// Every model call the council makes goes through completeModel or forkModel,
// which record its purpose, model and tokens; turn.step sums the session's
// model requests by category. Both land in ~/.claude/council/usage/<session>.jsonl,
// written only by this session, through one queue, never awaited by the call
// or the request it records. A failure is toasted once and changes nothing else.

// What a model call is for: `member:<id>`, `herald`, `brief`, `triage`,
// `arbiter`, `summons-round2`, `amend`, `report` or `guidance`.
type ModelUse = { purpose: string; orderId?: string; level?: number }

// Call records not yet written.
let pendingCalls: Array<Omit<UsageRecord, 'at' | 'session'>> = []
// Model requests not yet written, summed by agent ('' for main) and model.
const stepDeltas = new Map<string, { agentId?: string; model: string; tokens: Tokens; requests: number }>()
let unflushedSteps = 0
// Turns whose requests turn.step saw (a turn it didn't see counts from its turn.complete).
const steppedTurns = new Set<string>()
// Agents known by their spawn: an order's, or the council's advisor.
const usageAgents = new Map<string, AgentKind>()
// The file as last read or written: its call records and step totals.
let usageFile: { path: string; calls: UsageRecord[]; steps: Map<string, StepTotal> } | null = null
let usageWrites: Promise<void> = Promise.resolve()
let isUsageFlushQueued = false
let isUsageFailureToasted = false
let isUsagePruned = false
// The main loop's model, for a fork's record (a fork runs on it).
let mainModel: string | undefined

async function completeModel($: EngineInterface, use: ModelUse, request: ModelCompleteRequest): Promise<ModelCompleteResult> {
  const reply = await $.model.complete(request)
  noteModelCall($, use, request.model, request.effort, reply.usage)
  return reply
}

async function forkModel($: EngineInterface, use: ModelUse, request: ModelForkRequest): Promise<ModelForkResult> {
  const reply = await $.model.fork(request)
  if ('usage' in reply) noteModelCall($, use, mainModel ?? 'main model', undefined, reply.usage)
  return reply
}

// Queues a call's record; never throws.
function noteModelCall($: EngineInterface, use: ModelUse, model: string, effort: string | number | undefined, usage: ModelUsage | undefined): void {
  try {
    const { at: _at, session: _session, ...record } = callRecord({ at: 0, plugin: 'council', purpose: use.purpose, model, effort, session: '', usage, orderId: use.orderId, level: use.level })
    if (pendingCalls.length < 500) pendingCalls.push(record)
    void flushUsage($)
  } catch (error) {
    usageFailed($, error)
  }
}

// One model request's usage, summed in memory; never throws, never waits.
function noteStep($: EngineInterface, agentId: string | undefined, turnId: string, usage: TurnUsage | null | undefined): void {
  try {
    if (steppedTurns.size > 500) steppedTurns.delete(steppedTurns.values().next().value!)
    steppedTurns.add(turnId)
    if (usage === null || usage === undefined) return
    addStepDelta(agentId, usage.model, tokensOf(usage), 1)
    if (++unflushedSteps >= STEP_FLUSH_EVERY) void flushUsage($)
  } catch (error) {
    usageFailed($, error)
  }
}

function addStepDelta(agentId: string | undefined, model: string, tokens: Tokens, requests: number): void {
  const key = `${agentId ?? ''}|${model}`
  const existing = stepDeltas.get(key)
  stepDeltas.set(key, { ...(agentId !== undefined ? { agentId } : {}), model, tokens: addTokens(existing?.tokens ?? ZERO, tokens), requests: (existing?.requests ?? 0) + requests })
}

// A turn's end: a subagent's turn whose requests turn.step never saw counts
// from the turn's own usage; a main turn's end writes the totals.
function noteTurnEnd($: EngineInterface, e: { turnId: string; agentId?: string; usage?: TurnUsage }): void {
  try {
    const wasStepped = steppedTurns.delete(e.turnId)
    if (!wasStepped && e.agentId !== undefined && e.usage !== undefined) addStepDelta(e.agentId, e.usage.model, tokensOf(e.usage), 1)
    if (e.agentId === undefined) void flushUsage($)
  } catch (error) {
    usageFailed($, error)
  }
}

function flushUsage($: EngineInterface): Promise<void> {
  if (isUsageFlushQueued) return usageWrites
  isUsageFlushQueued = true
  usageWrites = usageWrites
    .then(() => {
      isUsageFlushQueued = false
      return writeUsage($)
    })
    .catch(error => usageFailed($, error))
  return usageWrites
}

function usageFailed($: EngineInterface, error: unknown): void {
  if (isUsageFailureToasted) return
  isUsageFailureToasted = true
  try {
    $.ui.toast(`Council: usage could not be recorded (${error instanceof Error ? error.message : String(error)}); nothing else is affected.`)
  } catch {
    // Nothing more to do.
  }
}

// Who an agent's requests belong to: an order's (with its level), the
// council's advisor, or (undefined) another subagent.
function agentKindOf(court: Court | undefined, agentId: string): AgentKind | undefined {
  const order = court?.orders.find(candidate => candidate.agentId === agentId)
  if (order !== undefined) return { category: 'dispatch', orderId: order.id, level: levelOf(order), role: order.role, folder: order.relFolder }
  if (advisorAgents.has(agentId) || court?.advisors?.some(run => run.agentId === agentId)) return { category: 'advisor' }
  return usageAgents.get(agentId)
}

// Writes what is pending into this session's file: the file read first once
// (a reload or a resume continues it), then rewritten whole. With no home
// folder nothing is recorded. The first write deletes files past retention.
async function writeUsage($: EngineInterface): Promise<void> {
  const calls = pendingCalls
  const deltas = [...stepDeltas.values()]
  if (calls.length === 0 && deltas.length === 0) return
  pendingCalls = []
  stepDeltas.clear()
  unflushedSteps = 0
  try {
    const homePath = await home($)
    if (homePath === '') return
    const [now, session] = await Promise.all([$.clock.now(), $.session.id()])
    const folder = `${homePath}/${USAGE_FOLDER}`
    const name = usageFileName(session)
    const path = `${folder}/${name}`
    if (usageFile === null || usageFile.path !== path) {
      const isThere = await $.fs.exists(path).catch(() => false)
      const text = isThere ? await readFileText($, path) : ''
      // A file that is there but can't be read is never overwritten.
      if (text === undefined) throw new Error(`${path} could not be read`)
      const parsed = parseUsageFile(text)
      usageFile = { path, calls: parsed.calls, steps: new Map(parsed.steps.map(total => [stepKey(total), total])) }
    }
    const court = deltas.some(delta => delta.agentId !== undefined) ? await read($, courtAtom).catch(() => undefined) : undefined
    const day = dayOf(now)
    let steps = usageFile.steps
    const orderTotals = new Map<string, Tokens & { requests: number }>()
    for (const delta of deltas) {
      const agent = delta.agentId === undefined ? undefined : agentKindOf(court, delta.agentId)
      const category: StepCategory = delta.agentId === undefined ? 'main' : (agent?.category ?? 'other')
      steps = withStepsAdded(steps, { day, at: now, session, category, model: delta.model, tokens: delta.tokens, requests: delta.requests, ...(agent ? { agent } : {}) })
      if (agent?.category === 'dispatch') {
        const sum = orderTotals.get(agent.orderId)
        orderTotals.set(agent.orderId, { ...addTokens(sum ?? ZERO, delta.tokens), requests: (sum?.requests ?? 0) + delta.requests })
      }
    }
    const records = foldCalls([...usageFile.calls, ...calls.map(call => ({ ...call, at: now, session }) as UsageRecord)])
    await $.fs.write(path, serializeUsage(records, steps.values()))
    usageFile = { path, calls: records, steps }
    for (const [orderId, sum] of orderTotals) {
      await updateOrder($, order => order.id === orderId, order => ({ ...order, usage: { ...addTokens(order.usage ?? ZERO, sum), requests: (order.usage?.requests ?? 0) + sum.requests } })).catch(() => undefined)
    }
    if (!isUsagePruned) {
      isUsagePruned = true
      void pruneUsage($, folder, name, now).catch(() => undefined)
    }
  } catch (error) {
    // Kept for the next write (bounded): one failure loses no counts.
    pendingCalls = [...calls, ...pendingCalls].slice(-500)
    for (const delta of deltas) addStepDelta(delta.agentId, delta.model, delta.tokens, delta.requests)
    throw error
  }
}

// Retention: usage files past 60 days deleted, each on its own, only in the
// usage folder. One that can't be deleted stays, noted in the debug log.
async function pruneUsage($: EngineInterface, folder: string, current: string, now: number): Promise<void> {
  const files = await $.fs.list(folder).catch(() => [])
  const homePath = await home($)
  for (const name of expiredUsageFiles(files.filter(file => !file.isLink), current, now)) {
    await removeInside(removeHostOf($), `${folder}/${name}`, folder, homePath || undefined).catch(error => {
      try {
        $.ui.log(`council: kept an expired usage file: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
      } catch {
        // A log line is best effort.
      }
    })
  }
}

// remove.ts's engine calls, spelled here: the engine follows `$` into no other file.
const removeHostOf = ($: EngineInterface): RemoveHost => ({
  stat: (path, options) => $.fs.stat(path, options),
  list: path => $.fs.list(path),
  exists: path => $.fs.exists(path),
  run: (argv, init) => $.process.run(argv, init),
})

// Every file of a folder modified since `since` (an older one holds no newer
// line), read; a file that can't be read is skipped.
async function readRecentFiles($: EngineInterface, folder: string, since: number, isWanted: (name: string) => boolean): Promise<string[]> {
  const entries = await $.fs.list(folder).catch(() => [])
  const texts = await Promise.all(
    entries.filter(entry => entry.kind === 'file' && !entry.isLink && entry.mtimeMs >= since && isWanted(entry.name)).map(entry => readFileText($, `${folder}/${entry.name}`)),
  )
  return texts.filter((text): text is string => text !== undefined)
}

// Sidekick's records, read loosely from its ledgers (one folder per session,
// segment files holding every kind of entry): null when it recorded none.
async function readSidekickUsage($: EngineInterface, homePath: string, since: number): Promise<UsageRecord[] | null> {
  const base = `${homePath}/${SIDEKICK_LEDGERS}`
  const sessions = (await $.fs.list(base).catch(() => undefined))?.filter(entry => entry.kind === 'dir' && !entry.isLink)
  if (sessions === undefined || sessions.length === 0) return null
  // Every session's folder (a folder's own time moves only when a file is added): its recent segments.
  const texts = await Promise.all(sessions.map(entry => readRecentFiles($, `${base}/${entry.name}`, since, name => /^\d{6}\.jsonl$/.test(name))))
  const records = texts.flat().flatMap(sidekickRecords)
  return records.length === 0 ? null : records
}

// /council usage [since YYYY-MM-DD]: one short table, from every session's
// usage file on this machine and sidekick's ledgers.
async function usageCommand($: EngineInterface, args: string): Promise<string> {
  const now = await $.clock.now()
  const since = parseSince(args, now)
  if ('error' in since) return since.error
  const homePath = await home($)
  if (homePath === '') return `Usage is not recorded: ${NO_HOME}.`
  await flushUsage($).catch(() => undefined)
  const texts = await readRecentFiles($, `${homePath}/${USAGE_FOLDER}`, since.since, isUsageFileName)
  const parsed = texts.map(parseUsageFile)
  const sidekick = await readSidekickUsage($, homePath, since.since)
  return usageReport({ label: since.label, steps: parsed.flatMap(file => file.steps), calls: parsed.flatMap(file => file.calls), sidekick, sinceDay: since.day, since: since.since, now })
}

// ── Hooks ─────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'council',
      description: 'Convene the council of five on a question, or on a repo\'s work since a ref',
      argumentHint: '[<question>|deep <question>|deep reconsider <context>|review [folder] <ref> [question]|reconsider <context>|ask <advisor> <question>|advise [deep] <folder> <question>|level <order> <1-3>|grant <order>|deny-leave <order>|release <order>|message <order> <text>|recall <order> <reason>|report|members|profile|lessons|docket|usage [since YYYY-MM-DD]|court [on|off|clear]|show|reset]',
    })
    await settleInterruptedWork($)
    await expireOrders($).catch(() => undefined)
    await $.tool.register({
      name: 'propose_orders',
      description: PROPOSE_ORDERS_DESCRIPTION,
      inputSchema: PROPOSE_ORDERS_SCHEMA,
      isDeferred: false,
    })
    await $.tool.register({ name: 'withdraw_orders', description: WITHDRAW_ORDERS_DESCRIPTION, inputSchema: WITHDRAW_ORDERS_SCHEMA, isDeferred: false })
    await $.tool.register({ name: 'settle_order', description: SETTLE_ORDER_DESCRIPTION, inputSchema: SETTLE_ORDER_SCHEMA, isDeferred: false })
    await $.tool.register({ name: 'amend_order', description: AMEND_ORDER_DESCRIPTION, inputSchema: AMEND_ORDER_SCHEMA, isDeferred: false })
    await $.tool.register({ name: 'recall_order', description: RECALL_ORDER_DESCRIPTION, inputSchema: RECALL_ORDER_SCHEMA, isDeferred: false })
    await $.tool.register({ name: 'progress', description: PROGRESS_DESCRIPTION, inputSchema: PROGRESS_SCHEMA, isDeferred: false })
    await $.tool.register({ name: 'consult', description: CONSULT_DESCRIPTION, inputSchema: CONSULT_SCHEMA, isDeferred: false })
    return result
  })

  on('session.end', async ($, e, next) => {
    stopAnimation()
    await flushUsage($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'council' }, async ($, e) => ({ text: await councilCommand($, e.args, e.origin) }))

  on('ui.render', { component: 'Pane', requestId: COUNCIL_PANE_ID }, ($, e) => drawCouncil($, e))

  // The council's own tool: it only convenes the council, so it needs no prompt.
  on('tool.check', { tool: 'mcp__council__propose_orders' }, () => ({ decision: 'allow' as const }))
  on('tool.check', { tool: 'mcp__council__progress' }, () => ({ decision: 'allow' as const }))
  on('tool.check', { tool: 'mcp__council__withdraw_orders' }, () => ({ decision: 'allow' as const }))
  on('tool.check', { tool: 'mcp__council__settle_order' }, () => ({ decision: 'allow' as const }))
  on('tool.check', { tool: 'mcp__council__consult' }, () => ({ decision: 'allow' as const }))
  on('tool.check', { tool: 'mcp__council__amend_order' }, () => ({ decision: 'allow' as const }))
  on('tool.check', { tool: 'mcp__council__recall_order' }, () => ({ decision: 'allow' as const }))

  // Convening the council is the main session's call: a subagent can't put
  // questions or plans to it (only the person and Claude can).
  on('tool.call', { tool: 'mcp__council__consult' }, async ($, e) =>
    e.agentId !== undefined ? { deny: "Subagents can't consult the council; report to Claude instead." } : { result: await consultCouncil($, e as unknown as Record<string, unknown>) },
  ).catch(() => ({
    deny: 'The council could not be consulted; ask the person instead.',
  }))
  on('tool.call', { tool: 'mcp__council__propose_orders' }, async ($, e) =>
    e.agentId !== undefined ? { deny: "Subagents can't propose orders; report to Claude instead." } : { result: await proposeOrders($, e as unknown as Record<string, unknown>) },
  ).catch(() => ({
    deny: 'The council could not rule on the plan; ask the person.',
  }))

  // Withdrawing is the main session's call: an agent carrying an order can't retire orders.
  on('tool.call', { tool: 'mcp__council__withdraw_orders' }, async ($, e) =>
    e.agentId !== undefined ? { deny: 'Council scouts and knights cannot withdraw orders; report to Claude instead.' } : { result: await withdrawOrdersTool($, e as unknown as Record<string, unknown>) },
  ).catch(() => ({ deny: 'The council could not withdraw the orders; try again.' }))

  // Settling is the main session's call: an agent can't settle its own order.
  on('tool.call', { tool: 'mcp__council__settle_order' }, async ($, e) =>
    e.agentId !== undefined ? { deny: 'Only the main session settles orders; report to Claude instead.' } : { result: await settleOrderTool($, e as unknown as Record<string, unknown>) },
  ).catch(() => ({ deny: 'The council could not settle the order; try again.' }))

  // Amending and recalling are the main session's calls.
  on('tool.call', { tool: 'mcp__council__amend_order' }, async ($, e) =>
    e.agentId !== undefined ? { deny: 'Only the main session amends orders; report to Claude instead.' } : { result: await amendOrderTool($, e as unknown as Record<string, unknown>) },
  ).catch(() => ({ deny: 'The council could not rule on the amendment; try again, or ask the person.' }))
  on('tool.call', { tool: 'mcp__council__recall_order' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Only the main session recalls orders; report to Claude instead.' }
    const request = readRecall(e as unknown as Record<string, unknown>)
    return { result: 'error' in request ? request.error : await recallOrderAction($, request, 'claude') }
  }).catch(() => ({ deny: 'The council could not recall the order; try again.' }))

  // A model's message to an order's agent is refused, from the main session
  // or a subagent, whatever the order's status: Claude amends or recalls
  // instead, and the person has /council message. The plugins' own sends pass.
  on('session.send', async ($, e, next) => {
    if (e.origin.kind !== 'model') return next(e)
    const order = await orderAddressed($, e.to)
    return order === undefined ? next(e) : { isDelivered: false as const, reason: blockedSendReason(order, e.agentId !== undefined) }
  }).catch(($, e, next) => next(e))

  // The advisor is never offered to the model: only the plugin starts it.
  on('agent.offer', { agent: 'council:advisor' }, () => ({ isOffered: false }))

  // Every dispatch: council agents carry an approved order, on their level's
  // model; the advisor only when the plugin started it; in court mode,
  // nothing else is dispatched. A wake is refused only for a settled knight
  // order whose place another knight now holds.
  on('agent.spawn', async ($, e, next) => {
    // An agent waking (a timer, a background task, a message) continues under
    // its own id; the engine ignores a rewrite, and a deny parks it.
    if (e.resume !== undefined) {
      const refusal = await wakeOrder($, e.resume.agentId)
      return refusal ?? next(e)
    }
    if (spawnTypeOf(e) === ADVISOR_TYPE) {
      const token = TOKEN_LINE.exec(e.prompt)?.[1]
      const pending = token === undefined ? undefined : pendingAdvisors.get(token)
      if (token === undefined || pending === undefined) return { deny: ADVISOR_DENIED }
      pendingAdvisors.delete(token)
      const result = await next({ ...e, prompt: e.prompt.replace(TOKEN_LINE, ''), model: pending.model, ...(pending.folders[0] ? { cwd: pending.folders[0] } : {}) })
      if (result.agentId !== undefined) await advisorStarted($, pending, result.agentId)
      return result
    }
    const outcome = await dispatchOrder($, e)
    if (outcome === undefined) return next(e)
    if ('deny' in outcome) return { deny: outcome.deny }
    const level = levelSetting(outcome.order)
    try {
      const result = await next({ ...e, prompt: outcome.prompt, description: outcome.description, model: level.model })
      if (result.agentId !== undefined) {
        stepEfforts.set(result.agentId, level.effort)
        usageAgents.set(result.agentId, { category: 'dispatch', orderId: outcome.order.id, level: levelOf(outcome.order), role: outcome.order.role, folder: outcome.order.relFolder })
        await moveOrder($, outcome.order.id, 'spawn', { agentId: result.agentId, model: level.model, effort: level.effort, ...(e.name ? { agentName: e.name } : {}) })
      }
      return result
    } finally {
      startingKnights.delete(outcome.order.id)
    }
  }).catch(($, e, next) =>
    // A wake whose check failed goes on: a deny would park it on a fault of ours.
    next.called || e.resume !== undefined
      ? next(e)
      : spawnTypeOf(e) === ADVISOR_TYPE
        ? { deny: ADVISOR_DENIED }
        : Object.values(AGENT_TYPES).includes(e.subagentType)
          ? { deny: 'The council could not check this dispatch against its orders; try again.' }
          : next(e),
  )

  // A council agent's model requests run at its level's effort; everything
  // else passes untouched. A model that takes no effort is left alone. Every
  // request's usage is summed for /council usage (no wait, no change).
  // A recalled agent's request past its ceiling is answered here, without
  // next: a final reply that ends its turn between steps, never mid-tool.
  on('turn.step', async function* ($, e, next) {
    const reply = e.agentId === undefined ? undefined : await recallCeiling($, e.agentId).catch(() => undefined)
    if (reply !== undefined) {
      yield { kind: 'text' as const, index: 0, text: reply }
      yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
      return { turnId: e.turnId, index: e.index, answer: reply, toolUses: [], stopReason: 'end_turn' as const, usage: null }
    }
    if (e.agentId === undefined) mainModel = e.model
    const effort = e.agentId === undefined || e.effort === undefined ? undefined : await stepEffortFor($, e.agentId)
    // The response streams through untouched; its usage is summed once it is whole.
    const result = yield* next(effort === undefined || effort === e.effort ? e : { ...e, effort: effort as typeof e.effort })
    noteStep($, e.agentId, e.turnId, result?.usage)
    return result
  })

  // A council agent's calls: progress, edits, and its folder's bounds; the
  // advisor reads only, and only in its folders.
  // (The progress tool is answered here too, so its list is always folded in.)
  on('tool.call', async ($, e, next) => {
    const isProgress = e.tool === PROGRESS_TOOL
    if (e.agentId === undefined) return isProgress ? { deny: 'The progress tool is for council scouts and knights carrying an order.' } : next(e)
    const advisorFolders = await advisorFoldersOf($, e.agentId)
    if (advisorFolders !== undefined) {
      const tool = String(e.tool)
      if (!ADVISOR_TOOLS.has(tool)) return { deny: "The council's advisor only reads (Read, Grep, Glob)." }
      const input = e as unknown as { file_path?: unknown; path?: unknown }
      const path = tool === 'Read' ? input.file_path : input.path
      if (!isAdvisorPath(advisorFolders, typeof path === 'string' ? path : undefined)) {
        return { deny: `The council's advisor reads only in ${advisorFolders.join(', ')}; ${String(path)} is outside.` }
      }
      return next(e)
    }
    // A recalled agent may still read and report progress; nothing else.
    const recalled = await recalledOrderOf($, e.agentId)
    if (recalled !== undefined && !RECALL_ALLOWED_TOOLS.has(String(e.tool))) return { deny: recallDenial(recalled.recall!) }
    const outcome = await followAgentCall($, e.agentId, String(e.tool), e as unknown as Record<string, unknown>)
    if (isProgress) return { result: outcome === undefined ? 'No order of yours is in progress; nothing noted.' : 'Noted.' }
    if (outcome !== undefined && 'deny' in outcome) return { deny: outcome.deny }
    const result = await next(e)
    if (outcome !== undefined && FILE_TOOLS.has(String(e.tool)) && result.deny === undefined && result.isError !== true) {
      const input = e as unknown as { file_path?: unknown; notebook_path?: unknown }
      const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
      await updateOrder($, order => order.id === outcome.order.id, order => withTouched({ ...order, edits: order.edits + 1 }, path))
    }
    return result
  }).catch(($, e, next) => (next.called ? next(e) : FILE_TOOLS.has(String(e.tool)) && e.agentId !== undefined ? { deny: 'The council could not check this edit against its order; try again.' } : next(e)))

  // A council agent's last answer is its report; an advisor's, its findings.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    noteTurnEnd($, e)
    if (e.agentId !== undefined) {
      const answer = 'answer' in e ? e.answer : ''
      await finishOrder($, e.agentId, answer, e.reason).catch(() => undefined)
      await finishAdvisorAgent($, e.agentId, answer, e.reason !== 'answer').catch(() => undefined)
    }
    return result
  })

  // Court mode: what you type goes to the council first.
  // The prompt waits here while the council sits (the model calls in flight
  // don't count against the hook's time), then enters as typed, with the
  // council's digest beside it for Claude only. A report from the person's
  // own advisor goes beside their next prompt the same way, court mode or not.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer') return next(e)
    // Your next message folds away the orders and advisors that have finished since.
    await expireOrders($).catch(() => undefined)
    const before = await read($, courtAtom)
    if (before.orders.some(order => isFinished(order) && !order.isFolded) || (before.advisors ?? []).some(isFoldable)) {
      await update($, courtAtom, current => ({ ...current, orders: withFinishedFolded(current.orders), ...(current.advisors ? { advisors: current.advisors.map(run => (isFoldable(run) ? { ...run, isFolded: true } : run)) } : {}) }))
    }
    if (e.text.trim().startsWith('/')) return next(e)
    const reports = [...(await takeNotices($).catch(() => [])), ...(await takeAdvisorReports($).catch(() => []))]
    const withReports = reports.length > 0 ? { ...e, context: [...(e.context ?? []), ...reports] } : e
    const court = await read($, courtAtom)
    if (!court.isInSession) return next(withReports)
    const route = await triage($, e.text)
    if (route === 'pass') return next(withReports)
    const onlySeat = typeof route === 'object' ? route.seat : undefined
    await update($, courtAtom, current => ({ ...current, heldPrompt: e.text }))
    try {
      const digest = await petitionDigest($, e.text, route !== 'review', onlySeat)
      return await next({ ...withReports, context: [...(withReports.context ?? []), digest] })
    } finally {
      await update($, courtAtom, current => ({ ...current, heldPrompt: null }))
    }
  }).catch(($, e, next) => (next.called ? next(e) : next({ ...e, context: [...(e.context ?? []), "[Court mode: the person's council could not sit on this prompt; go ahead with care.]"] })))

  // The person closed the chamber (Escape, the close mark): stop animating.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === COUNCIL_PANE_ID) stopAnimation()
    return result
  })
}
