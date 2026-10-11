// The sidekick mod's $.state contract.

export type DiffOp = '+' | '-' | ' ' | '~'

export type DiffLine = { op: DiffOp; text: string }

export type ReplayStep = {
  tool: string
  file: string
  note: string
  addedCount: number
  removedCount: number
  // Kept lines, capped; `hiddenLineCount` says how many were dropped.
  diff: DiffLine[]
  hiddenLineCount: number
}

export type Replay = {
  steps: ReplayStep[]
  index: number
  isSeen: boolean
  isOpen: boolean
  isInBand: boolean
}

export type HeadsUpNote = {
  headline: string
  detail: string
  isExpanded: boolean
}

// One repo the brief's span touched, with its git state when the brief was made.
export type BriefRepo = {
  // The repo's top folder, absolute.
  folder: string
  name: string
  // Paths relative to the repo.
  files: Array<{ path: string; added: number; removed: number }>
  added: number
  removed: number
  // Commits made in the span ("abc1234 subject").
  commits: string[]
  uncommitted: number | null
  unpushed: number | null
}

// The TL;DR of a span of the session's ledger. A short tool-less turn gets
// only `line` (the old one-sentence TL;DR); a working span gets the rest.
export type Brief = {
  span: 'last' | 'since' | 'full'
  // "last turn · 3h 12m"
  label: string
  line: string | null
  done: string | null
  stuck: string | null
  needsYou: string | null
  // The claims check: the answer against the record, found by rules.
  findings: string[]
  phases: string[]
  stats: string[]
  repos: BriefRepo[]
  // The earliest part of the span was left out (over the per-brief cap).
  skippedNote: string | null
  isExpanded: boolean
}

// A brief that needs more Haiku calls than the confirm threshold waits here.
export type PendingBrief = {
  span: 'last' | 'since' | 'full'
  calls: number
  characters: number
  // Asked for by the handoff: the session's HANDOFF.md is written once it's made.
  isForHandoff: boolean
}

// The one-line bar above the prompt: which item's panel is open, which
// items are working, a short notice per item ("nothing to flag"), and the
// calls the scope guard blocked since the last rule decision.
export type BarItemId = 'resume' | 'tldr' | 'headsUp' | 'rule' | 'replay' | 'trim' | 'context' | 'council'

export type Bar = {
  open: BarItemId | null
  busy: BarItemId[]
  notices: Partial<Record<BarItemId, string>>
  blockedCalls: string[]
}

// Absolute folders this session's changes should stay inside, set with /scope.
// The root itself stands for the root's own files only.
export type Scope = {
  folders: string[]
}

export type ResumeWarning = {
  secondsSinceLastResponse: number
  contextTokens: number
  estimatedCacheWriteUsd: number | null
  isAcknowledged: boolean
  heldPrompt: string | null
}

// A long-lived rule the review suggested, awaiting the person's answer.
// `spec` is the rule as /rules add takes it ("fence other"); `key` is how
// rules are compared, kept so "never" needs no parsing.
export type RuleSuggestion = {
  spec: string
  key: string
  description: string
  reason: string
}

// A trim worth running: the context is past the threshold and dropping stale
// output would bring it to the target or below. Offered on the bar; the
// person runs /compact trim.
export type TrimOffer = {
  currentPercent: number
  projectedPercent: number
  droppedCount: number
}

// One turn's growth of the context, credited to the prompt that started it.
export type ContextGrowth = { prompt: string; delta: number }

export type ContextBreakdownRow = { name: string; tokens: number }

// The context readout: the engine's figures after the last turn, the change
// since the turn before, the turns that grew it, and (when the panel asked
// for it) /context's breakdown.
export type ContextReadout = {
  tokens: number | null
  // `tokens` plus an estimate of the turn's final answer, which the engine's
  // figure (the last request's input) doesn't hold yet: growth is measured on
  // this, so each turn is credited with its own answer. Absent in readouts
  // saved by an earlier version.
  creditedTokens?: number | null
  window: number
  lastDelta: number | null
  history: ContextGrowth[]
  breakdown: ContextBreakdownRow[] | null
}

declare module 'claude-code' {
  interface PluginState {
    sidekick: {
      replay: Replay
      note: HeadsUpNote | null
      brief: Brief | null
      pendingBrief: PendingBrief | null
      scope: Scope
      resumeWarning: ResumeWarning | null
      ruleSuggestion: RuleSuggestion | null
      bar: Bar
      trimOffer: TrimOffer | null
      context: ContextReadout
      hasCouncil: boolean
    }
  }
}
