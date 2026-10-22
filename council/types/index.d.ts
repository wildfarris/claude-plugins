// The council mod's $.state contract.

// The five built-ins are castellan, treasurer, seneschal, justiciar and
// jester; member files add any others.
export type AdvisorId = string

// What a legionary carries (sprites.ts draws each).
export type Accessory = 'shield' | 'crown' | 'none' | 'standard' | 'antenna'

// One member seated on a council: everything the council needs to run and
// draw it, fixed when it convenes (later edits to member files don't change
// a council in session).
export type Seat = {
  id: AdvisorId
  title: string
  // A word or two: Security, Money…
  concern: string
  // What the member weighs (the core of its prompt).
  remit: string
  // Body color, #rrggbb.
  color: string
  accessory: Accessory
  // Reference material read from the member's files, already trimmed.
  references: Array<{ source: string; text: string }>
  // The person's tuning for this member (members.ts), which adds to its remit
  // and never replaces it. Absent when there is none, and in seats saved
  // before tuning existed.
  tuning?: MemberTuning
}

// A member's tuning, from its member files (cares, ignores, lean), merged
// user then project, field by field. Items are already cleaned and checked.
export type MemberTuning = {
  // What it should weigh especially, and set aside: at most 5 each.
  cares?: string[]
  ignores?: string[]
  // -2 (softer: lower concerns) to 2 (harder: higher concerns) than the
  // council's strictness. Its prompt's guidance only, never the thresholds.
  lean?: number
}

// `abstained`: the topic is outside the member's remit; its verdict holds the reason.
export type AdvisorStatus = 'waiting' | 'deliberating' | 'done' | 'abstained' | 'failed'

export type FollowUp = {
  question: string
  answer: string
  status: 'asking' | 'done' | 'failed'
}

export type AdvisorReport = {
  status: AdvisorStatus
  // 1 (content) to 5 (alarmed); 0 until a verdict is in.
  concern: number
  // At most eight words; `detail` is the exposition shown on request.
  verdict: string
  detail: string
  isExpanded: boolean
  followUp: FollowUp | null
  // The concern before the latest reconsideration, to show the shift; null
  // until reconsidered.
  previousConcern: number | null
  // A consult with options: the option it favors (1-based), 0 for none of
  // them; absent when there were no options.
  choice?: number
}

// One advisor's verdict in a finished round.
export type RoundVerdict = {
  status: AdvisorStatus
  concern: number
  verdict: string
  detail: string
  choice?: number
}

// A round the council has moved past: its verdicts, and the context that
// ended it (the person's reconsideration).
export type CouncilRound = {
  verdicts: Record<AdvisorId, RoundVerdict>
  // The context added after this round, which started the next one.
  addedContext: string
}

// A follow-up question answered by one advisor.
export type FollowUpRecord = {
  advisor: AdvisorId
  question: string
  answer: string
}

export type CouncilPhase = 'briefing' | 'deliberating' | 'done' | 'failed'

export type Council = {
  topic: string
  phase: CouncilPhase
  brief: string
  isBriefExpanded: boolean
  advisors: Record<AdvisorId, AdvisorReport>
  // Who sits on this council, in order. Absent in councils saved by 0.1.0
  // (they had the five built-ins).
  seats?: Seat[]
  // Brain trust: every call on the deep model and effort.
  isDeep?: boolean
  // A consult's options; each advisor picks one (`choice`).
  options?: string[]
  // The person's standing context (guidance and recent lessons) given to
  // every advisor of this council, fixed when it convened.
  standing?: string | null
  // The person's strictness from their profile (-2 lenient to 2 strict),
  // fixed when it convened: it moves the concern at which a verdict becomes a
  // condition (profile.ts conditionAt). Absent: balanced.
  strictness?: number
  // Who put the question: the person, or Claude (a consult, the court's
  // orders). Only the person's questions go into lessons.
  source?: 'person' | 'claude'
  // A note shown under the herald's line, e.g. that the repo hasn't been
  // fetched lately (review mode).
  notice: string | null
  // Context added after the verdicts, oldest first; each reconsideration
  // sees all of it.
  context: string[]
  // Earlier rounds, oldest first (the current verdicts are on `advisors`).
  // Absent in councils saved by version 0.1.0.
  rounds?: CouncilRound[]
  // Every answered follow-up, oldest first. Absent in older councils.
  followUps?: FollowUpRecord[]
  // The docket entry that records this sitting (DocketEntry id). Absent until
  // it is recorded, and in councils from before the docket.
  docketId?: string
}

export type RosterEntry = {
  id: AdvisorId
  title: string
  concern: string
  color: string
  // Where it comes from: built in, your user folder, or this project.
  source: 'built-in' | 'user' | 'project'
  isSeated: boolean
  // Its tuning in short ("lean: slightly-softer · cares 2 · ignores 1") and
  // the member files it came from. Absent when it has none.
  tuning?: { summary: string; files: string[] }
}

export type Roster = {
  entries: RosterEntry[]
  // Member files that could not be read, with why.
  problems: string[]
}

// ── The court: orders the council approved, and the agents carrying them ──

export type OrderRole = 'scout' | 'knight'

// The order lifecycle (court.ts ORDER_LIFECYCLE holds every transition):
// 'held': approved on the first round while the council's summoned advisor
// checks a fact (CourtSummons); not dispatchable, holding no place, until the
// second round releases it ('approved') or refuses it ('withdrawn');
// 'approved': waiting for Claude to dispatch it; 'dispatched': an agent is on
// it; 'unsettled': its agent ended a turn with todos open, so the main session
// judges how it ended (settle_order); 'waiting': settled as waiting for a wake
// (a timer, a background task); 'done' / 'stopped-early' / 'failed': settled;
// 'lost': its agent left the engine's agent list, or the person released it;
// 'withdrawn': retired before it was dispatched (Claude withdrew it, or it
// expired), with `withdrawnReason`; 'recalled': the main session or the person
// recalled it (`recall`), and its agent's turn has ended (or it was not
// running). A knight order holds its place (the folder claim) while
// dispatched, unsettled or waiting.
export type OrderStatus = 'held' | 'approved' | 'dispatched' | 'unsettled' | 'waiting' | 'done' | 'stopped-early' | 'failed' | 'lost' | 'withdrawn' | 'recalled'

// A message the person sent an order's agent (/council message).
export type OrderMessage = { text: string; at: number; isDelivered: boolean; reason?: string }

// One amendment Claude asked for (mcp__council__amend_order) and the council's
// ruling on it: 'ruling' while the council sits (it holds the slot, so two
// calls can't both pass the cap), then 'approved' or 'refused'. Refused ones
// count toward the cap too.
export type OrderAmendment = {
  change: string
  reason: string
  todos: string[]
  status: 'ruling' | 'approved' | 'refused'
  // The gravest concern, the refusal's reason, and the conditions it carries.
  gravest?: number
  refusal?: string
  conditions?: string[]
  // Whether the approved amendment reached the agent ($.session.send).
  isDelivered?: boolean
  at: number
}

// A recall (mcp__council__recall_order or /council recall): the agent's
// changing tool calls are refused from `at`, and after RECALL_STEPS more
// model requests its next one is answered with a final reply (`isEnded`).
export type OrderRecall = { reason: string; at: number; by: 'claude' | 'person'; steps: number; isEnded?: boolean }

export type ForbidOp = 'create' | 'edit' | 'delete'

// One path rule on an order: a glob relative to the order's folder (`*` and
// `?` within a name, `**` across folders, a bare name at any depth), the
// operations it forbids, and the person's reason, shown to the agent.
export type ForbidRule = { glob: string; ops: ForbidOp[]; reason: string }

export type OrderTodo = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
  // Tool calls the agent made while this todo was in progress (absent in orders
  // saved before the court counted them, and until a first call).
  calls?: number
}

export type Order = {
  // O1, O2…: what Claude names in the dispatch.
  id: string
  role: OrderRole
  // Absolute, and as given (relative to the session root).
  folder: string
  relFolder: string
  task: string
  // The agent's todo list as it last wrote it (the proposal's, until then).
  todos: OrderTodo[]
  // The council's conditions on this order (concerns of 3 or more).
  conditions: string[]
  // Paths the order's agent may not create, edit or delete (globs relative to
  // `folder`), from the dispatch's `forbid`. The sidekick mod enforces them.
  // Absent when the dispatch named none, and in orders saved before it existed.
  forbid?: ForbidRule[]
  // Plain-language rules for the order's agent (the dispatch's `forbid`
  // entries given as `{ rule }`), which the sidekick mod's policy judge reads
  // against its shell commands. Absent when there are none.
  policy?: string[]
  // Leave (knights only): specific exceptions to the default rules of the
  // sidekick mod's policy judge, asked in the proposal and ruled on with the
  // plan. Sidekick reads it only while `leaveStatus` is 'granted'. Absent when
  // none was asked, or once the person denied it.
  leave?: string[]
  // Who has let the leave stand: 'pending' until the person types /council
  // grant (leaveApproval owner, the default); 'granted' by the person, or at
  // approval (leaveApproval council); 'denied' by /council deny-leave, which
  // drops the leave. Absent when no leave was asked.
  leaveStatus?: LeaveStatus
  status: OrderStatus
  agentId: string | null
  steps: number
  edits: number
  // The agent's final answer, trimmed.
  report: string
  startedAt: number | null
  endedAt: number | null
  // When the council approved it (ms), which starts its expiry clock. Absent in
  // orders saved before expiry existed; the court stamps those when it next
  // looks at them.
  approvedAt?: number
  // Why a withdrawn order was withdrawn ('expired' when it timed out).
  withdrawnReason?: string
  // Finished, and folded away at the person's next prompt. Absent in orders
  // saved before folding existed.
  isFolded?: boolean
  // How demanding the council rated it, 1 to 3: picks the agent's model and
  // effort (settings scoutLevels, knightLevels). Absent in older orders (read
  // as the role's default: 2 for a knight, 1 for a scout).
  level?: OrderLevel
  // The model and effort its agent runs on (from its level), kept with the
  // order so they survive a reload and the effort applies after a wake (a
  // woken agent keeps the model it was started on). Absent: untouched.
  model?: string
  effort?: string
  // How many times its agent woke after ending a turn (a timer, a background
  // task, a message): each wake puts the order back on the road. Absent: never.
  wakes?: number
  // The main session's note when it settled the order (settle_order), or why
  // it was lost. Absent when there is none.
  note?: string
  // The name the dispatch gave its agent (`Agent({ name })`), which
  // SendMessage addresses it by. Absent when unnamed.
  agentName?: string
  // Files its agent's file tools (Edit, Write, MultiEdit, NotebookEdit)
  // changed, absolute, once each. Shell changes are not tracked.
  touched?: string[]
  // The person's messages to its agent (/council message), oldest first.
  messages?: OrderMessage[]
  // Claude's amendments and the council's rulings on them, oldest first.
  amendments?: OrderAmendment[]
  // Set when it is recalled.
  recall?: OrderRecall
}

export type OrderLevel = 1 | 2 | 3

export type LeaveStatus = 'pending' | 'granted' | 'denied'

// ── Advisor agents (council:advisor): read-only investigators ─────────────

// 'timed-out': the council stopped waiting for it (a summons only).
export type AdvisorRunStatus = 'running' | 'done' | 'failed' | 'timed-out'

// One question put to an advisor, and who asked it: member titles for a
// summons, 'you' for the person's own.
export type AdvisorQuestion = { question: string; askedBy: string[] }

// One advisor agent's run: started by the person (/council advise) or
// summoned by the council during a ruling on orders.
export type AdvisorRun = {
  // A1, A2…
  id: string
  origin: 'owner' | 'council'
  // The folders it may read, relative to the session root.
  relFolders: string[]
  questions: AdvisorQuestion[]
  // /council advise deep: the second advisor agent level.
  isDeep: boolean
  model: string
  effort: string
  status: AdvisorRunStatus
  agentId: string | null
  // Its findings, trimmed.
  report: string
  startedAt: number
  endedAt: number | null
  // The person's own: its report has gone to Claude with their next prompt.
  isDelivered?: boolean
  // Finished, and folded away at the person's next prompt.
  isFolded?: boolean
}

// A plan the council held for its summoned advisor: the dispatches as
// proposed (court.ts Proposal).
export type SummonsProposal = {
  plan: string
  dispatches: Array<{ folder: string; role: OrderRole; task: string; todos: string[]; forbid?: ForbidRule[]; policy?: string[]; leave?: string[] }>
}

// A summons in progress, kept in the court so a reload never loses it: the
// held orders, the plan, the first round (its council and each member's raw
// answer, for the LEVEL lines), the questions and the deadline. 'checking':
// the advisor (run `runId`) is out; 'ruling': the second round is sitting.
// Removed once the held orders are released or refused.
export type CourtSummons = {
  runId: string
  phase: 'checking' | 'ruling'
  orderIds: string[]
  proposal: SummonsProposal
  root: string
  // The person's petition the plan answered (court mode), for the arbiter.
  petition: string | null
  council: Council
  replies: Record<AdvisorId, string>
  questions: AdvisorQuestion[]
  startedAt: number
  // When the council stops waiting and rules on its first round (ms).
  deadline: number
  // How the advisor ended, saved as the second round starts, so a round a
  // reload dropped starts again without the run. Absent while checking.
  outcome?: { status: AdvisorRunStatus; findings: string }
  // The docket entry of the first round (outcome 'held'), which the second
  // round's entry follows. Absent when it was not recorded.
  docketId?: string
}

// What a ruling's summons asked and found.
export type RulingSummons = { advisorId: string; questions: AdvisorQuestion[]; status: AdvisorRunStatus; findings: string }

// One proposal the council ruled on.
export type Ruling = {
  plan: string
  isApproved: boolean
  gravest: number
  // Why it was refused, when it was.
  reason: string
  // What the arbiter's review left beside the conditions: each one it
  // dropped and why, or that its review failed (court.ts). Absent before it.
  notes?: string[]
  // The advisor the council summoned before ruling, if any.
  summons?: RulingSummons
  // The docket entry that records it. Absent before the docket.
  docketId?: string
}

export type Court = {
  orders: Order[]
  // The number the next order gets (O<n>), counting up for the life of the
  // court so clearing or withdrawing orders never frees an id. Absent in a court
  // saved before it existed: ids then continue after the highest saved one.
  nextOrderId?: number
  rulings: Ruling[]
  // Advisor agents, oldest first. Absent in courts saved before them.
  advisors?: AdvisorRun[]
  // The number the next advisor gets (A<n>).
  nextAdvisorId?: number
  // Court mode: every prompt goes to the council before Claude.
  isInSession: boolean
  // A prompt held for the council, while it sits.
  heldPrompt: string | null
  // Summonses whose held orders wait for the second round. Absent when none.
  summonses?: CourtSummons[]
  // Lines for the main session (an order left unsettled) that could not be
  // appended to its conversation: they go beside the person's next prompt.
  // Absent when there are none.
  notices?: string[]
}

// ── Learning from reconsiders (learning.ts) ──────────────────────────────

export type Lesson = {
  id: string
  // The session root it happened in: a lesson applies there only.
  project: string
  at: string
  // The question, when the person asked it (never Claude's or a tool's words).
  topic: string | null
  // What the person added: their own words.
  added: string
  // How the council moved, e.g. "Treasurer 3→2", "Castellan held at 2".
  moves: string[]
}

export type Guidance = Array<{ scope: string; items: string[] }>

// What the lessons view shows: this project's lessons, the guidance that
// applies here, and a drafted summary waiting for the person.
export type LearningView = {
  project: string
  lessons: Lesson[]
  guidance: Guidance
  proposal: Guidance | null
  proposalPath: string
  guidancePath: string
  error: string | null
}

// ── The docket (docket.ts): a record of every sitting ───────────────────

// What a docket entry records: a consult (Claude's question, a brain trust
// when `isDeep`), a ruling on orders (outcome approved, refused or held), the
// second round of a held ruling (summons), a ruling on an amendment, a
// court-mode council on the person's prompt (court), a council the person
// convened with /council (council), and the lighter events: the person's
// leave ruling, an advisor the person sent (advise), and a recall.
export type DocketKind = 'consult' | 'orders' | 'summons' | 'amendment' | 'court' | 'council' | 'leave' | 'advise' | 'recall'

// One member's vote in a sitting.
export type DocketVote = {
  id: AdvisorId
  title: string
  status: AdvisorStatus
  // 1 to 5; 0 when it gave none.
  concern: number
  verdict: string
  // At most 600 characters.
  detail: string
  // A consult's option it picked (1-based, 0 for none).
  choice?: number
  // A ruling on orders: its LEVEL rating of each dispatch, in order (null
  // where it gave none), and its CHECK question.
  levels?: Array<number | null>
  check?: string
}

// The concerns counted: how many members gave each concern (index 0 is
// concern 1), how many abstained or fell silent, and a consult's picks per
// option (index 0 is option 1).
export type DocketTally = { gravest: number; concerns: number[]; abstained: number; silent: number; picks?: number[] }

// One sitting, one line of a project's docket. `v` is the schema version: a
// line of another version is skipped when read. Text is redacted and capped
// before it is written (question and plan 4,000 characters, each detail 600).
export type DocketEntry = {
  v: 1
  // `20261022T101500-ab12`: when it was recorded, and a random part.
  id: string
  // ISO time.
  time: string
  kind: DocketKind
  // The session it happened in ($.session.id).
  session: string
  // The session root (the project), as the session gives it.
  project: string
  // The question: a consult's, a council's topic, the person's petition, an advisor's.
  question?: string
  // A plan of orders, or the amendment asked.
  plan?: string
  options?: string[]
  // The dispatches proposed: folder (relative to the root), role, and leave asked.
  dispatches?: Array<{ folder: string; role: OrderRole; leave?: string[] }>
  // The folders an advisor read (advise).
  folders?: string[]
  isDeep?: boolean
  votes?: DocketVote[]
  abstentions?: Array<{ id: AdvisorId; title: string; reason: string }>
  tally?: DocketTally
  // approved, refused or held (a ruling); adjourned or dissolved (a council);
  // a consult's result (`option 2`, `tie 1, 3`, `no pick`, `advice`);
  // granted or denied (leave); done, failed or timed-out (advise); recalled
  // or recalling (recall).
  outcome: string
  // Why it was refused, or why it was recalled.
  reason?: string
  conditions?: string[]
  orderIds?: string[]
  // The arbiter's notes beside the conditions.
  notes?: string[]
  // The advisor's findings, cut short.
  findings?: string
  // The person's strictness (-2 to 2) and the concern at which a verdict
  // became a condition, in effect for the sitting.
  strictness?: number
  threshold?: number
  // The advisor run (A3) a summons or an advise names: a held ruling and its
  // second round share it.
  runId?: string
  // The entry this one follows: a summons's held first round.
  follows?: string
  // Who recalled the order, or ruled on its leave.
  by?: 'claude' | 'person'
}

// The docket view's kind filter: consults (consult, council, court), orders
// (orders, summons), amendments, and other (leave, advise, recall).
export type DocketFilter = 'all' | 'consults' | 'orders' | 'amendments' | 'other'

// What the docket view shows: one page of this project's entries, newest
// first, under the filter; the entry open in full, if any.
export type DocketView = {
  project: string
  filter: DocketFilter
  // The first entry shown, counted in the filtered list.
  offset: number
  // Entries in the filtered list.
  total: number
  entries: DocketEntry[]
  openId: string | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    council: {
      council: Council | null
      // The chamber shows the members list (who sits on this project's council).
      isRosterOpen: boolean
      // The members this project could seat, for the list: built-ins and member
      // files, with whether each is seated and any file that failed to load.
      roster: Roster | null
      court: Court
      // The pane shows the full chamber instead of the court.
      isChamberShown: boolean
      // The court's strip: the advisor whose verdict is open, if any.
      openVerdictId: string | null
      // The court lists finished orders in full (they fold away otherwise).
      isFinishedShown: boolean
      // The finished order whose full report is open in the court.
      openOrderId: string | null
      // The pane shows the lessons and guidance.
      isLessonsOpen: boolean
      learning: LearningView | null
      // The pane shows the docket (/council docket).
      isDocketOpen: boolean
      docket: DocketView | null
    }
  }
}
