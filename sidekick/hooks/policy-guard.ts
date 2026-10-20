// The guard's decision for one shell command (Bash or PowerShell), in the
// order the checks run: deterministic refusals first, never behind a model.
// Pure: the model call and the process snapshot come in through a host.
//
//   1. the inline-code ban (inline-code.ts): refused, no model call;
//   2. the scope guard: a change outside the target folders is refused;
//   3. the fast path (clearCommand / clearPowerShell): when every part of
//      the command clears, it runs, no model call;
//   4. the complexity rule: an opaque construct, or more uncleared parts
//      than the limit, is refused with "split it", no model call;
//   5. the segment cache: parts the judge allowed before, here, under the
//      same policy, run without a call;
//   6. the budget: past the call ceiling the guard fails closed;
//   7. the policy judge (judge.ts): one call for the whole command; ALLOW
//      runs, BLOCK is refused, and anything else (an error, a timeout, an
//      empty, malformed or cut-off answer) is refused too: it fails closed.
//
// The path rules (globs) need the disk (create or edit) and run beside this
// in register.tsx.

import { inlineCodeInBash, inlineCodeInPowerShell, type InlineFinding } from './inline-code'
import { buildJudgePrompt, judgeSystemPrompt, parseJudgeAnswer, JUDGE_MAX_TOKENS, JUDGE_TIMEOUT_MS, type JudgeRequest } from './judge'
import { policyVersion, type PolicyRule } from './policy'
import { namesProcesses, processTargets, resolveTargets, treeLines, type ProcessSnapshot } from './processes'
import { analyzePowerShell, clearPowerShell } from './powershell'
import { analyzeCommand, clearCommand, type Clearance, type GuardVerdict, type ScopeContext } from './scope-guard'

export type ShellTool = 'Bash' | 'PowerShell'

export const SHELL_TOOLS: ReadonlySet<string> = new Set<ShellTool>(['Bash', 'PowerShell'])

export const isShellTool = (tool: string): tool is ShellTool => SHELL_TOOLS.has(tool)

// A tool call's command, however the event carries it: flat (tool.call), or
// under `input` / `tool_input` (tool.check, classic hooks).
export function shellCommandOf(input: Record<string, unknown>): string | undefined {
  const nested = [input.input, input.tool_input].find((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
  const command = typeof input.command === 'string' ? input.command : nested?.command
  return typeof command === 'string' && command.trim() !== '' ? command : undefined
}


export function inlineFinding(tool: ShellTool, command: string): InlineFinding | undefined {
  return tool === 'PowerShell' ? inlineCodeInPowerShell(command) : inlineCodeInBash(command)
}

export function scopeVerdict(tool: ShellTool, command: string, context: ScopeContext): GuardVerdict {
  return tool === 'PowerShell' ? analyzePowerShell(command, context) : analyzeCommand(command, context)
}

export function clearanceOf(tool: ShellTool, command: string, context: ScopeContext): Clearance {
  return tool === 'PowerShell' ? clearPowerShell(command, context) : clearCommand(command, context)
}

export type ShellDecision =
  | { kind: 'allow'; via: 'code' | 'fast-path' | 'cache' | 'judge' | 'off' }
  | { kind: 'refuse'; via: 'inline'; finding: InlineFinding }
  | { kind: 'refuse'; via: 'scope'; verdict: Extract<GuardVerdict, { kind: 'block' }> }
  | { kind: 'refuse'; via: 'complexity' | 'judge' | 'fail-closed' | 'budget'; reason: string }
  | { kind: 'judge'; reason: string }

// What a decision means for the call: a scope refusal is denied for anyone
// (as the scope guard always did); any other refusal is denied for a
// subagent, which can't be asked, and asked of the owner in their session.
export function outcomeFor(decision: ShellDecision, isAgent: boolean): 'allow' | 'deny' | 'ask' {
  if (decision.kind !== 'refuse') return 'allow'
  return decision.via === 'scope' || isAgent ? 'deny' : 'ask'
}

export type ShellOptions = { isInlineBanEnabled: boolean }

// Stage 1 alone: the deterministic checks, with what's left marked for a judge.
export function decideShell(tool: ShellTool, command: string, context: ScopeContext, options: ShellOptions): ShellDecision {
  if (options.isInlineBanEnabled) {
    const finding = inlineFinding(tool, command)
    if (finding !== undefined) return { kind: 'refuse', via: 'inline', finding }
  }
  const verdict = scopeVerdict(tool, command, context)
  if (verdict.kind === 'block') return { kind: 'refuse', via: 'scope', verdict }
  if (verdict.kind === 'unclear') return { kind: 'judge', reason: verdict.reason }
  return { kind: 'allow', via: 'code' }
}

// ── The judge ──────────────────────────────────────────────────────────────

export type ModelReply = { isAnswered: true; text: string; usage?: { output_tokens?: number; input_tokens?: number; cache_read_input_tokens?: number } } | { isAnswered: false; reason: string }

export type JudgeHost = {
  complete: (request: { system: string; prompt: string; maxTokens: number; timeoutMs: number }) => Promise<ModelReply>
  // The process snapshot (cached by the host); undefined when it can't be taken.
  snapshot: () => Promise<ProcessSnapshot | undefined>
  // Why the judge is paused (the 5-hour usage cap), if it is.
  pausedBecause?: () => Promise<string | undefined>
}

// What one session's judge remembers: segments it allowed, and calls spent
// per budget (an agent's id, or the owner's session).
export type JudgeState = { allowed: Map<string, number>; calls: Map<string, number> }
export const newJudgeState = (): JudgeState => ({ allowed: new Map(), calls: new Map() })
const MAX_CACHED_SEGMENTS = 2000

export type JudgeSettings = { isEnabled: boolean; maxSegments: number; budget: number }

export type ShellCall = {
  tool: ShellTool
  command: string
  context: ScopeContext
  isAgent: boolean
  // Who runs it, as the judge reads it.
  agentLabel: string
  // The budget this call counts against.
  budgetKey: string
  policy: readonly PolicyRule[]
  recent: readonly string[]
}

// What happened, for the ledger's metrics.
export type JudgeEvent = { judged: boolean; usage?: { input: number; output: number; cacheRead: number } }

const normalizeSegment = (text: string) => text.replace(/\s+/g, ' ').trim()

export const segmentKey = (segment: string, context: Pick<ScopeContext, 'cwd' | 'folders'>, version: string) => JSON.stringify([normalizeSegment(segment), context.cwd, [...context.folders].sort(), version])

export async function decideCall(call: ShellCall, options: ShellOptions & { judge: JudgeSettings }, state: JudgeState, host: JudgeHost, event: JudgeEvent = { judged: false }): Promise<ShellDecision> {
  const first = decideShell(call.tool, call.command, call.context, options)
  if (first.kind === 'refuse') return first
  if (!options.judge.isEnabled) return { kind: 'allow', via: 'off' }

  const clearance = clearanceOf(call.tool, call.command, call.context)
  if (clearance.opaque !== undefined) return { kind: 'refuse', via: 'complexity', reason: `it uses ${clearance.opaque}, which the guard can't check` }
  const uncleared = [...new Set(clearance.segments.filter(segment => !segment.isCleared).map(segment => normalizeSegment(segment.text)))].filter(Boolean)
  if (uncleared.length === 0) return { kind: 'allow', via: 'fast-path' }
  if (uncleared.length > options.judge.maxSegments) {
    return { kind: 'refuse', via: 'complexity', reason: `it has ${uncleared.length} parts the guard can't clear on its own (the limit is ${options.judge.maxSegments})` }
  }

  const version = policyVersion(call.policy)
  const keys = uncleared.map(segment => segmentKey(segment, call.context, version))
  if (keys.every(key => state.allowed.has(key))) return { kind: 'allow', via: 'cache' }

  const paused = await host.pausedBecause?.().catch(() => undefined)
  if (paused !== undefined) return { kind: 'refuse', via: 'budget', reason: paused }
  const spent = state.calls.get(call.budgetKey) ?? 0
  if (spent >= options.judge.budget) return { kind: 'refuse', via: 'budget', reason: `the policy judge's budget for this ${call.isAgent ? 'agent' : 'session'} is spent (${options.judge.budget} calls)` }

  // Processes: only for a command that stops, signals or inspects them.
  let processes: JudgeRequest['processes']
  const usesSnapshot = namesProcesses(call.command)
  if (usesSnapshot) {
    const snapshot = await host.snapshot().catch(() => undefined)
    processes = snapshot === undefined ? { unavailable: true } : { tree: treeLines(snapshot), targets: resolveTargets(processTargets(call.command), snapshot) }
  }

  const request: JudgeRequest = {
    tool: call.tool,
    command: call.command,
    uncleared,
    cwd: call.context.cwd,
    folders: call.context.folders,
    agent: call.agentLabel,
    recent: call.recent,
    ...(processes === undefined ? {} : { processes }),
  }
  state.calls.set(call.budgetKey, spent + 1)
  event.judged = true
  const reply = await host
    .complete({ system: judgeSystemPrompt(call.policy), prompt: buildJudgePrompt(request, call.context.home), maxTokens: JUDGE_MAX_TOKENS, timeoutMs: JUDGE_TIMEOUT_MS })
    .catch((error: unknown): ModelReply => ({ isAnswered: false, reason: error instanceof Error ? error.message : String(error) }))
  if (!reply.isAnswered) return { kind: 'refuse', via: 'fail-closed', reason: `the policy judge gave no answer (${reply.reason})` }
  if (reply.usage) event.usage = { input: reply.usage.input_tokens ?? 0, output: reply.usage.output_tokens ?? 0, cacheRead: reply.usage.cache_read_input_tokens ?? 0 }
  const answer = parseJudgeAnswer(reply.text, reply.usage?.output_tokens)
  if (answer.kind === 'malformed') return { kind: 'refuse', via: 'fail-closed', reason: `the policy judge gave no usable answer (${answer.why})` }
  if (answer.kind === 'block') return { kind: 'refuse', via: 'judge', reason: answer.reason }
  // A verdict that read the process snapshot holds only for that moment.
  if (!usesSnapshot) {
    for (const key of keys) {
      if (state.allowed.size >= MAX_CACHED_SEGMENTS) state.allowed.delete(state.allowed.keys().next().value!)
      state.allowed.set(key, 1)
    }
  }
  return { kind: 'allow', via: 'judge' }
}

// ── What Claude and the owner read ─────────────────────────────────────────

const STOP_AND_REPORT = 'If the task needs it, stop and report that instead of working around it.'

// The denial Claude reads for a refusal other than inline code and scope
// (those have their own messages).
export function policyDenial(decision: Extract<ShellDecision, { kind: 'refuse'; via: 'complexity' | 'judge' | 'fail-closed' | 'budget' }>, isAgent: boolean): string {
  const owner = 'Ask the owner: they can run it themselves, or turn the judge off for this session with /scope judge off.'
  switch (decision.via) {
    case 'judge':
      return `Blocked by the sidekick policy judge: ${decision.reason}. ${isAgent ? STOP_AND_REPORT : owner}`
    case 'complexity':
      return `Blocked by the sidekick guard: ${decision.reason}. Split it into smaller commands, one step each, so each can be checked.`
    case 'budget':
      return `Blocked by the sidekick guard: ${decision.reason}, and it fails closed. ${isAgent ? 'Stop and report; the owner can raise the ceiling (judgeBudgetAgent).' : owner}`
    case 'fail-closed':
      return `Blocked by the sidekick guard: ${decision.reason}, and it fails closed. Retry once; if it is blocked again, ${isAgent ? 'stop and report.' : 'tell the owner.'}`
  }
}

// The question the owner is asked instead, in their own session.
export function policyQuestion(decision: Extract<ShellDecision, { kind: 'refuse'; via: 'complexity' | 'judge' | 'fail-closed' | 'budget' }>): string {
  switch (decision.via) {
    case 'judge':
      return `Sidekick policy judge: BLOCK: ${decision.reason}. Allow it anyway?`
    case 'complexity':
      return `Sidekick guard: ${decision.reason}, so the judge was not asked. Allow it anyway?`
    case 'budget':
      return `Sidekick guard: ${decision.reason}. Allow it without the judge?`
    case 'fail-closed':
      return `Sidekick guard: ${decision.reason}. Allow it anyway?`
  }
}
