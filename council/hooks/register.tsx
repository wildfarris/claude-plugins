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
import type { EngineInterface, Register, RenderInput, Timer } from 'claude-code'

import type { AdvisorId, AdvisorReport, Council, Court, LearningView, Order, Roster, Seat } from '../types'
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
  type ReviewMaterial,
  type ReviewRequest,
} from './review'
import { readSettings, type CouncilSettings } from './settings'
import { TICK_MS, animatedSvg, moodFor, rasterCells, roadSvg, roadText, spriteFrame, type Appearance } from './sprites'
import {
  AGENT_TYPES,
  PROGRESS_DESCRIPTION,
  PROGRESS_SCHEMA,
  PROGRESS_TOOL,
  PROPOSE_ORDERS_DESCRIPTION,
  PROPOSE_ORDERS_SCHEMA,
  dispatchPrompt,
  emptyCourt,
  isInside,
  matchOrder,
  newOrders,
  progressOf,
  proposalBrief,
  readProposal,
  readTodos,
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
  type ArbiterDecision,
  type Proposal,
  type RulingResult,
} from './court'
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
import { MAX_SEATS, mergeMembers, parseMemberFile, resolveReference, seatedMembers, trimReferences, BUILT_IN_MEMBERS, type MemberDefinition } from './members'

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
    if (council === null) return stopAnimation()
    const changed = seatsOf(council).flatMap(advisor => {
      const report = council.advisors[advisor.id]
      if (report === undefined) return []
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
const askAdvisorModel = ($: EngineInterface, isDeep: boolean | undefined, advisorSystem: string, prompt: string, maxTokens: number) =>
  $.model.complete({
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
  const reply = await $.model.fork({ prompt: heraldForkPrompt(topic) }).catch(() => undefined)
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
  const pick = await $.model
    .complete({ model: isDeep ? settings.deepModel : settings.briefModel, effort: isDeep ? settings.deepEffort : 'low', system: PICK_FILES_SYSTEM, prompt: pickFilesPrompt(material), maxTokens: isDeep ? 2000 : 400, timeoutMs: isDeep ? 180000 : 60000 })
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

  const reply = await $.model
    .complete({ model: isDeep ? settings.deepModel : settings.briefModel, effort: isDeep ? settings.deepEffort : 'medium', system: REVIEW_BRIEF_SYSTEM, prompt: reviewBriefPrompt(material, patch ?? '', picked), maxTokens: isDeep ? 3000 : 700, timeoutMs: isDeep ? 300000 : 120000 })
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
async function holdCouncil($: EngineInterface, generation: number, topic: string, seats: readonly Seat[], isDeep: boolean, produceBrief: () => Promise<BriefOutcome>): Promise<void> {
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
      const verdict = await askAdvisorModel($, isDeep, advisorSystemPrompt(advisor, standing), advisorPrompt(topic, brief, options), 300).catch(() => undefined)
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
  const standing = await standingFor($).catch(() => null)
  await update($, councilAtom, () => ({ ...newCouncil(topic, seats, isDeep), standing, source: 'person' as const }))
  await update($, isRosterOpenAtom, () => false)
  // A council you convened opens to its chamber, even when the court has orders.
  await update($, isChamberShownAtom, () => true)
  await openCouncilPane($)
  isCouncilWorking = true
  void holdCouncil($, generation, topic, seats, isDeep, produceBrief)
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
  const candidate = first.startsWith('/') ? first.replace(/\/$/, '') : `${root}/${first.replace(/^\.\//, '').replace(/\/$/, '')}`
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
      const verdict = await askAdvisorModel($, reconsidering.isDeep, advisorSystemPrompt(advisor, reconsidering.standing), prompt, 300).catch(() => undefined)
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
  void askAdvisorModel($, council.isDeep, advisorSystemPrompt(advisor, council.standing), followUpPrompt(council.topic, council.brief, report, question), 400)
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
  void askAdvisorModel($, council.isDeep, REPORT_SYSTEM, reportPrompt(council), 500)
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
  const [council, isRosterOpen, roster, isLessonsOpen, learning] = await Promise.all([
    read($, councilAtom),
    read($, isRosterOpenAtom),
    read($, rosterAtom),
    read($, isLessonsOpenAtom),
    read($, learningAtom),
  ])
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
  const [court, isChamberShown] = await Promise.all([read($, courtAtom), read($, isChamberShownAtom)])
  const hasCourt = court.orders.length > 0 || court.isInSession
  if (hasCourt && !isChamberShown) {
    return courtView(table, {
      court,
      council,
      bodyColumns: e.props.bodyColumns,
      road: order => {
        const state = order.status === 'done' ? 'done' : order.status === 'failed' ? 'failed' : 'travelling'
        const { fraction } = progressOf(order)
        const elements = table as unknown as Record<string, ((props: Record<string, unknown>) => unknown) | undefined>
        return e.surface !== 'terminal' && elements.Svg
          ? // No width: the strip takes its own (320px) up to the slot, so a narrow sidebar scales it down rather than clipping the house.
            elements.Svg({ key: `road-${order.id}`, source: roadSvg(AGENT_LOOK[order.role], fraction, state), alt: `${order.role} on the road to ${order.relFolder}` })
          : <table.Text key={`road-${order.id}`} color={order.status === 'failed' ? 'error' : order.status === 'done' ? 'success' : 'claude'}>{roadText(order.role === 'knight' ? '♞' : '♟', fraction, state)}</table.Text>
      },
      onChamber: () => update($, isChamberShownAtom, () => true),
      openVerdictId: await read($, openVerdictAtom),
      isFinishedShown: await read($, isFinishedShownAtom),
      openOrderId: await read($, openOrderAtom),
      onToggleOrder: id => update($, openOrderAtom, current => (current === id ? null : id)),
      portrait: (seat, report) => {
        const elements = table as unknown as Record<string, ((props: Record<string, unknown>) => unknown) | undefined>
        if (e.surface === 'terminal' || !elements.Svg || council === null) return null
        const mood = moodFor(report, council.phase)
        return elements.Svg({ key: `mini-${seat.id}-${mood}`, source: animatedSvg(seat, mood), alt: `${seat.title}, ${mood}`, width: 40, height: 44, isInteractive: true })
      },
      onToggleVerdict: id => update($, openVerdictAtom, current => (current === id ? null : id)),
      onToggleFinished: () => update($, isFinishedShownAtom, current => !current),
      onToggleSession: () => setCourtSession($, !court.isInSession),
      onClearFinished: () => update($, courtAtom, current => ({ ...current, orders: current.orders.filter(order => order.status !== 'done' && order.status !== 'failed') })),
    })
  }
  if (e.surface === 'terminal' && council !== null) startAnimation($)
  if (council === null) return <table.Text dimColor>The council has not convened. /council &lt;question&gt; to summon it; /council members to choose who sits.</table.Text>
  return councilView(table, {
    council,
    bodyColumns: e.props.bodyColumns,
    hasHotkeys: e.surface === 'terminal',
    portrait: (seat, report) => portraitFor(table, e.surface, seat, report, council, animationTick),
    onToggleBrief: () => updateCouncil($, current => ({ ...current, isBriefExpanded: !current.isBriefExpanded })),
    onToggleAdvisor: id => updateAdvisor($, id, report => ({ ...report, isExpanded: !report.isExpanded })),
    // Fills the prompt box in front of the draft: the question is finished there and sent with Enter.
    onAsk: id => fillCommand($, `/council ask ${id} `),
    onReconsider: () => fillCommand($, '/council reconsider '),
    onReconsiderDeep: () => fillCommand($, '/council deep reconsider '),
    onAskDeep: () => fillCommand($, '/council deep '),
    onReport: async () => $.ui.toast(await reportCouncil($)),
    onMembers: () => openRoster($),
    onLessons: () => openLessons($),
    ...(hasCourt ? { onCourt: () => update($, isChamberShownAtom, () => false) } : {}),
  })
}

// ── Members ───────────────────────────────────────────────────────────────

let homeFolder: string | undefined

async function home($: EngineInterface): Promise<string> {
  if (homeFolder === undefined) {
    const result = await $.process.run(['printenv', 'HOME'], { timeoutMs: 3000 }).catch(() => undefined)
    homeFolder = result?.exitCode === 0 ? result.stdout.trim() : ''
  }
  return homeFolder
}

const rosterStoreKey = (root: string) => `roster:${root}`

async function unseatedIds($: EngineInterface, root: string): Promise<string[]> {
  const stored = (await $.store.get(rosterStoreKey(root))) as { off?: unknown } | undefined
  return Array.isArray(stored?.off) ? stored.off.filter((id): id is string => typeof id === 'string') : []
}

// The member files in one folder, parsed, with their references resolved.
async function readMemberFolder($: EngineInterface, folder: string, source: 'user' | 'project', homePath: string, spareStart: number) {
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
    const base = BUILT_IN_MEMBERS.find(member => member.id === entry.name.replace(/\.md$/i, '').toLowerCase())
    const parsed = parseMemberFile(entry.name, text, source, base, spareStart + index)
    if ('problem' in parsed) {
      problems.push(`${source === 'user' ? '~/.claude' : '.claude'}/council/members/${parsed.problem}`)
      continue
    }
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
  const user = homePath === '' ? { members: [], problems: [] } : await readMemberFolder($, `${homePath}/.claude/council/members`, 'user', homePath, 0)
  const project = await readMemberFolder($, `${root}/.claude/council/members`, 'project', homePath, user.members.length)
  return { members: mergeMembers(user.members, project.members), problems: [...user.problems, ...project.problems], root }
}

// The seats for a new council: who is seated here, references read in.
async function seatsForProject($: EngineInterface): Promise<{ seats: Seat[]; problems: string[] }> {
  const { members, problems, root } = await loadMembers($)
  const seated = seatedMembers(members, await unseatedIds($, root)).slice(0, MAX_SEATS)
  const seats = await Promise.all(
    seated.map(async ({ source: _source, referencePaths, ...member }) => {
      const read = await Promise.all(
        referencePaths.map(async path => {
          const text = await $.fs.read(path).catch(() => undefined)
          if (typeof text !== 'string') problems.push(`${member.title}: could not read reference ${path}`)
          return typeof text === 'string' ? { source: path.split('/').pop() ?? path, text } : undefined
        }),
      )
      return { ...member, references: trimReferences(read.filter((entry): entry is { source: string; text: string } => entry !== undefined)) }
    }),
  )
  return { seats, problems }
}

async function refreshRoster($: EngineInterface): Promise<Roster> {
  const { members, problems, root } = await loadMembers($)
  const off = await unseatedIds($, root)
  const seated = seatedMembers(members, off).slice(0, MAX_SEATS).map(member => member.id)
  const roster: Roster = {
    entries: members.map(member => ({ id: member.id, title: member.title, concern: member.concern, color: member.color, source: member.source, isSeated: seated.includes(member.id) })),
    problems: [...problems, ...(members.length - off.length > MAX_SEATS ? [`At most ${MAX_SEATS} sit at once; the rest wait until a seat is free.`] : [])],
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
  sitting: { onlySeat?: string; options?: string[]; isChamber?: boolean; source?: 'person' | 'claude'; isDeep?: boolean } = {},
): Promise<Council | undefined> {
  const { seats: seated } = await seatsForProject($)
  // Asked of one member: only it sits.
  const seats = sitting.onlySeat === undefined ? seated : seated.filter(seat => seat.id === sitting.onlySeat)
  if (seats.length === 0) return undefined
  const generation = ++councilGeneration
  const standing = await standingFor($).catch(() => null)
  const council: Council = { ...newCouncil(topic, seats, sitting.isDeep === true), standing, source: sitting.source ?? 'person' }
  await update($, councilAtom, () => (sitting.options && sitting.options.length > 0 ? { ...council, options: sitting.options } : council))
  // The court's sittings show the court; a consult shows its chamber.
  await update($, isChamberShownAtom, () => sitting.isChamber === true)
  await openCouncilPane($)
  isCouncilWorking = true
  try {
    await holdCouncil($, generation, topic, seats, sitting.isDeep === true, produceBrief)
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
  if (council.phase !== 'done') return `The council could not answer: ${council.notice ?? 'it dissolved'}. Ask the person instead.`
  return consultText(council)
}

// The propose_orders tool: the council rules on Claude's plan; approved
// dispatches become orders.
async function proposeOrders($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const root = await $.session.root()
  const proposal = readProposal(input, root)
  if ('error' in proposal) return proposal.error
  for (const dispatch of proposal.dispatches) {
    const isFolder = await $.fs
      .stat(`${root}/${dispatch.folder}`)
      .then(stat => stat.kind === 'dir')
      .catch(() => false)
    if (!isFolder) return `There is no folder ${dispatch.folder}/ under ${root}.`
  }
  const council = await conveneAndWait($, `Orders: ${proposal.plan}`, async () => ({ brief: proposalBrief(proposal, lastPetition) }), { source: 'claude' })
  if (council === undefined) return 'The council could not sit (no one is seated, or another council replaced it). Ask the person.'
  const ruled = ruling(council, proposal.plan)
  const result = needsArbiter(ruled) ? await arbitrate($, council, proposal, ruled) : ruled
  const court = await read($, courtAtom)
  const orders = result.isApproved ? newOrders(court, proposal, root, result.conditions) : []
  await update($, courtAtom, current => ({
    ...current,
    orders: [...current.orders, ...orders],
    rulings: [
      ...current.rulings.slice(-9),
      { plan: result.plan, isApproved: result.isApproved, gravest: result.gravest, reason: result.reason, ...(result.notes ? { notes: result.notes } : {}) },
    ],
  }))
  return rulingText(result, orders)
}

// The arbiter's review of an approved plan's conditions: one low-effort call
// on the advisor model, as the member itself (its own system prompt, with the
// arbiter's request added). With no arbiter, or one not seated, the ruling
// stands as it is; a failed call keeps every condition, with a note saying so.
async function arbitrate($: EngineInterface, council: Council, proposal: Proposal, result: RulingResult): Promise<RulingResult> {
  if (settings.arbiter === null) return result
  const seat = arbiterSeat(council, settings.arbiter)
  if (seat === undefined) {
    $.ui.toast(`Council: the arbiter "${settings.arbiter}" is not seated here, so the conditions stand unreviewed.`)
    return result
  }
  let review: ArbiterDecision[] | { failure: string }
  try {
    const reply = await $.model.complete({
      model: settings.advisorModel,
      effort: 'low',
      system: advisorSystemPrompt(seat, council.standing, true),
      prompt: arbiterPrompt(proposal, lastPetition, result.proposed),
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
  const court = await read($, courtAtom)
  const isCouncilAgent = Object.values(AGENT_TYPES).includes(e.subagentType)
  if (!isCouncilAgent) {
    if (court.isInSession && e.subagentType !== 'fork') {
      return { deny: `Court mode is on: dispatch work as ${AGENT_TYPES.scout} or ${AGENT_TYPES.knight} with an order from mcp__council__propose_orders.` }
    }
    return undefined
  }
  const order = matchOrder(court.orders, e.subagentType, e.description, e.prompt)
  if (order === undefined) {
    const open = court.orders.filter(candidate => candidate.status === 'approved').map(candidate => `${candidate.id} (${candidate.role}, ${candidate.relFolder}/)`)
    return {
      deny: open.length > 0 ? `Name the order this carries in the description: open orders are ${open.join(', ')}.` : 'No approved order for this dispatch. Propose it with mcp__council__propose_orders first.',
    }
  }
  const instructions = await $.fs.read(`${order.folder}/CLAUDE.md`).catch(() => undefined)
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
    const absolute = path.startsWith('/') ? path : `${order.folder}/${path}`
    if (!isInside(order, absolute)) {
      return { deny: `Order ${order.id} is scoped to ${order.relFolder}/; ${path} is outside it. Work inside the folder, or report that the order needs a change.` }
    }
  }
  const todos = tool === 'TodoWrite' || tool === PROGRESS_TOOL ? readTodos(input) : undefined
  await updateOrder(
    $,
    candidate => candidate.id === order.id,
    current => ({ ...current, steps: current.steps + 1, ...(todos ? { todos } : {}) }),
  )
  return { order }
}

async function finishOrder($: EngineInterface, agentId: string, answer: string, isFailed: boolean): Promise<void> {
  const court = await read($, courtAtom)
  const order = court.orders.find(candidate => candidate.agentId === agentId && candidate.status === 'dispatched')
  if (order === undefined) return
  const now = await $.clock.now()
  // The whole report (it opens in full in the court), line breaks kept.
  const report = answer.replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000)
  await updateOrder($, candidate => candidate.id === order.id, current => ({ ...current, status: isFailed ? 'failed' : 'done', report, endedAt: now }))
  $.ui.toast(`${order.id}: the ${order.role} ${isFailed ? 'fell in' : 'is back from'} ${order.relFolder}/.`)
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
  const reply = await $.model
    .complete({ model: settings.triageModel, system: TRIAGE_SYSTEM, prompt: triagePrompt(petition, seated), maxTokens: 12, timeoutMs: 15000 })
    .catch(() => undefined)
  const sorted = parseTriage(reply?.isAnswered ? reply.text : undefined, seated.map(member => member.id))
  return sorted.route === 'seat' ? { seat: sorted.id } : sorted.route === 'pass' ? 'pass' : 'review'
}

// Court mode: the council sits on the prompt (briefed from this conversation),
// and its digest goes to Claude beside it, out of the transcript's sight.
async function petitionDigest($: EngineInterface, petition: string, isAsked: boolean, onlySeat?: string): Promise<string> {
  lastPetition = petition
  const council = await conveneAndWait($, petition, () => forkBrief($, petition), { onlySeat })
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
    await update($, courtAtom, court => ({ ...court, orders: court.orders.filter(order => order.status === 'approved' || order.status === 'dispatched') }))
    return 'Finished orders cleared.'
  }
  await update($, isChamberShownAtom, () => false)
  await $.ui.open({ id: COUNCIL_PANE_ID, title: 'The Council', rows: 30 })
  return 'The court is open.'
}

// ── Learning from reconsiders ─────────────────────────────────────────────

async function learningFiles($: EngineInterface) {
  const homePath = await home($)
  if (homePath === '') throw new Error('could not find the home folder')
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
  const reply = await $.model
    .complete({ model: settings.advisorModel, effort: settings.advisorEffort, system: SUMMARY_SYSTEM, prompt: summaryPrompt(mine, existing, project), maxTokens: 800, timeoutMs: 120000 })
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

async function councilCommand($: EngineInterface, args: string): Promise<string> {
  const trimmed = args.trim()
  const [action = '', target = '', ...words] = trimmed.split(/\s+/)
  // A subcommand only when it's used as one, so "reset the DB first?" or
  // "ask users for consent?" are still questions for the council.
  const isAlone = trimmed.split(/\s+/).length === 1
  if (action === 'show' && isAlone) {
    if ((await read($, councilAtom)) === null) return 'The council has not convened. /council <topic> to summon it.'
    await openCouncilPane($)
    return 'The council chamber is open.'
  }
  if (action === 'reset' && isAlone) {
    await dismissCouncil($)
    return 'The council is dismissed.'
  }
  if (action === 'members') return membersCommand($, target, words.join(' '))
  if (action === 'court') return courtCommand($, target)
  if (action === 'lessons' && isAlone) {
    await openLessons($)
    return 'The lessons are open in the chamber.'
  }
  if (action === 'deep' && target === 'reconsider') return reconsider($, trimmed.replace(/^deep\s+reconsider\b/, '').trim(), true)
  if (action === 'deep') return conveneFromText($, trimmed.replace(/^deep\b/, '').trim() || DEFAULT_COUNCIL_TOPIC, true)
  const current = await read($, councilAtom)
  if (action === 'ask' && current !== null && findAdvisor(seatsOf(current), target) !== undefined) return askAdvisor($, target, words.join(' '))
  if (action === 'reconsider') return reconsider($, trimmed.replace(/^reconsider\b/, '').trim())
  if (action === 'report' && isAlone) return reportCouncil($)
  return conveneFromText($, trimmed || DEFAULT_COUNCIL_TOPIC)
}

// ── Hooks ─────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'council',
      description: 'Convene the council of five on a question, or on a repo\'s work since a ref',
      argumentHint: '[<question>|deep <question>|deep reconsider <context>|review [folder] <ref> [question]|reconsider <context>|ask <advisor> <question>|report|members|lessons|court [on|off|clear]|show|reset]',
    })
    await settleInterruptedWork($)
    await $.tool.register({
      name: 'propose_orders',
      description: PROPOSE_ORDERS_DESCRIPTION,
      inputSchema: PROPOSE_ORDERS_SCHEMA,
      isDeferred: false,
    })
    await $.tool.register({ name: 'progress', description: PROGRESS_DESCRIPTION, inputSchema: PROGRESS_SCHEMA, isDeferred: false })
    await $.tool.register({ name: 'consult', description: CONSULT_DESCRIPTION, inputSchema: CONSULT_SCHEMA, isDeferred: false })
    return result
  })

  on('session.end', async ($, e, next) => {
    stopAnimation()
    return next(e)
  })

  on('command.run', { command: 'council' }, async ($, e) => ({ text: await councilCommand($, e.args) }))

  on('ui.render', { component: 'Pane', requestId: COUNCIL_PANE_ID }, ($, e) => drawCouncil($, e))

  // The council's own tool: it only convenes the council, so it needs no prompt.
  on('tool.check', { tool: 'mcp__council__propose_orders' }, () => ({ decision: 'allow' as const }))
  on('tool.check', { tool: 'mcp__council__progress' }, () => ({ decision: 'allow' as const }))
  on('tool.check', { tool: 'mcp__council__consult' }, () => ({ decision: 'allow' as const }))
  on('tool.call', { tool: 'mcp__council__consult' }, async ($, e) => ({ result: await consultCouncil($, e as unknown as Record<string, unknown>) })).catch(() => ({
    deny: 'The council could not be consulted; ask the person instead.',
  }))
  on('tool.call', { tool: 'mcp__council__propose_orders' }, async ($, e) => ({ result: await proposeOrders($, e as unknown as Record<string, unknown>) })).catch(() => ({
    deny: 'The council could not rule on the plan; ask the person.',
  }))

  // Every dispatch: council agents carry an approved order; in court mode,
  // nothing else is dispatched.
  on('agent.spawn', async ($, e, next) => {
    const outcome = await dispatchOrder($, e)
    if (outcome === undefined) return next(e)
    if ('deny' in outcome) return { deny: outcome.deny }
    const result = await next({ ...e, prompt: outcome.prompt, description: outcome.description })
    if (result.agentId !== undefined) {
      const now = await $.clock.now()
      await updateOrder($, order => order.id === outcome.order.id, order => ({ ...order, status: 'dispatched', agentId: result.agentId ?? null, startedAt: now }))
    }
    return result
  }).catch(($, e, next) => (next.called ? next(e) : Object.values(AGENT_TYPES).includes(e.subagentType) ? { deny: 'The council could not check this dispatch against its orders; try again.' } : next(e)))

  // A council agent's calls: progress, edits, and its folder's bounds.
  // (The progress tool is answered here too, so its list is always folded in.)
  on('tool.call', async ($, e, next) => {
    const isProgress = e.tool === PROGRESS_TOOL
    if (e.agentId === undefined) return isProgress ? { deny: 'The progress tool is for council scouts and knights carrying an order.' } : next(e)
    const outcome = await followAgentCall($, e.agentId, String(e.tool), e as unknown as Record<string, unknown>)
    if (isProgress) return { result: outcome === undefined ? 'No order of yours is in progress; nothing noted.' : 'Noted.' }
    if (outcome !== undefined && 'deny' in outcome) return { deny: outcome.deny }
    const result = await next(e)
    if (outcome !== undefined && FILE_TOOLS.has(String(e.tool)) && result.deny === undefined && result.isError !== true) {
      await updateOrder($, order => order.id === outcome.order.id, order => ({ ...order, edits: order.edits + 1 }))
    }
    return result
  }).catch(($, e, next) => (next.called ? next(e) : FILE_TOOLS.has(String(e.tool)) && e.agentId !== undefined ? { deny: 'The council could not check this edit against its order; try again.' } : next(e)))

  // A council agent's last answer is its report.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      const isFailed = e.reason !== 'answer'
      await finishOrder($, e.agentId, 'answer' in e ? e.answer : '', isFailed).catch(() => undefined)
    }
    return result
  })

  // Court mode: what you type goes to the council first.
  // The prompt waits here while the council sits (the model calls in flight
  // don't count against the hook's time), then enters as typed, with the
  // council's digest beside it for Claude only.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer') return next(e)
    // Your next message folds away the orders that have finished since.
    if ((await read($, courtAtom)).orders.some(order => (order.status === 'done' || order.status === 'failed') && !order.isFolded)) {
      await update($, courtAtom, current => ({ ...current, orders: withFinishedFolded(current.orders) }))
    }
    if (e.text.trim().startsWith('/')) return next(e)
    const court = await read($, courtAtom)
    if (!court.isInSession) return next(e)
    const route = await triage($, e.text)
    if (route === 'pass') return next(e)
    const onlySeat = typeof route === 'object' ? route.seat : undefined
    await update($, courtAtom, current => ({ ...current, heldPrompt: e.text }))
    try {
      const digest = await petitionDigest($, e.text, route !== 'review', onlySeat)
      return await next({ ...e, context: [...(e.context ?? []), digest] })
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
