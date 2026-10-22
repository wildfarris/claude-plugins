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
}

export type RosterEntry = {
  id: AdvisorId
  title: string
  concern: string
  color: string
  // Where it comes from: built in, your user folder, or this project.
  source: 'built-in' | 'user' | 'project'
  isSeated: boolean
}

export type Roster = {
  entries: RosterEntry[]
  // Member files that could not be read, with why.
  problems: string[]
}

// ── The court: orders the council approved, and the agents carrying them ──

export type OrderRole = 'scout' | 'knight'

// 'approved': waiting for Claude to dispatch it; 'dispatched': an agent is on
// it; 'done' / 'failed': the agent came back; 'withdrawn': retired before it
// was dispatched (Claude withdrew it, or it expired), with `withdrawnReason`.
export type OrderStatus = 'approved' | 'dispatched' | 'done' | 'failed' | 'withdrawn'

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
  // The effort its agent's requests run at (from its level), kept with the
  // order so it survives a reload and applies after a wake. Absent: untouched.
  effort?: string
  // How many times its agent woke after reporting (a timer, a background
  // task, a message): each wake reopens the order. Absent: never.
  wakes?: number
  // A note on the order the person should see (e.g. it woke while another
  // knight was working in an overlapping place).
  warning?: string
}

export type OrderLevel = 1 | 2 | 3

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
    }
  }
}
