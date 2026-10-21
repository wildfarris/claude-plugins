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
//      On a compound or long command that refusal says to split it.
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

// A command with several parts, or a long one: how many parts the guard read,
// how long it is, and the parts it couldn't clear in code. Carried by a
// complexity refusal and a fail-closed one, so the refusal can say to split it.
export type CommandShape = { parts: number; length: number; uncleared: readonly string[] }

// Past this many characters a one-part command is long.
export const LONG_COMMAND = 300

export type ShellDecision =
  | { kind: 'allow'; via: 'code' | 'fast-path' | 'cache' | 'judge' | 'off' }
  | { kind: 'refuse'; via: 'inline'; finding: InlineFinding }
  | { kind: 'refuse'; via: 'scope'; verdict: Extract<GuardVerdict, { kind: 'block' }> }
  | { kind: 'refuse'; via: 'complexity' | 'judge' | 'fail-closed' | 'budget'; reason: string; shape?: CommandShape }
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
  const parts = clearance.segments.length
  const fullShape: CommandShape = { parts, length: call.command.length, uncleared }
  if (uncleared.length > options.judge.maxSegments) {
    return { kind: 'refuse', via: 'complexity', reason: `it has ${uncleared.length} parts the guard can't clear on its own (the limit is ${options.judge.maxSegments})`, shape: fullShape }
  }
  // A judge that gives no answer on a compound or long command: say to split it.
  const shape = parts > 1 || call.command.length > LONG_COMMAND ? { shape: fullShape } : {}

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
  if (!reply.isAnswered) return { kind: 'refuse', via: 'fail-closed', reason: `the policy judge gave no answer (${reply.reason})`, ...shape }
  if (reply.usage) event.usage = { input: reply.usage.input_tokens ?? 0, output: reply.usage.output_tokens ?? 0, cacheRead: reply.usage.cache_read_input_tokens ?? 0 }
  const answer = parseJudgeAnswer(reply.text, reply.usage?.output_tokens)
  if (answer.kind === 'malformed') return { kind: 'refuse', via: 'fail-closed', reason: `the policy judge gave no usable answer (${answer.why})`, ...shape }
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

type PolicyRefusal = Extract<ShellDecision, { kind: 'refuse'; via: 'complexity' | 'judge' | 'fail-closed' | 'budget' }>

// A reason as the end of a sentence (a cut-off reason already ends in "…").
const ended = (reason: string) => (/[.…!?]$/.test(reason) ? reason : `${reason}.`)

const SHOWN_PARTS = 3
const SHOWN_PART_LENGTH = 80

// What a shape says: "long and compound (14 parts, 512 characters)".
function sizeOf(shape: CommandShape): string {
  const kind = shape.parts > 1 && shape.length > LONG_COMMAND ? 'long and compound' : shape.parts > 1 ? 'compound' : 'long'
  return `${kind} (${shape.parts} ${shape.parts === 1 ? 'part' : 'parts'}, ${shape.length} characters)`
}

// The parts code couldn't clear: the first few, each cut short.
function partsList(uncleared: readonly string[]): string {
  const shown = uncleared.slice(0, SHOWN_PARTS).map(part => `\`${part.length > SHOWN_PART_LENGTH ? `${part.slice(0, SHOWN_PART_LENGTH).trimEnd()}…` : part}\``)
  const more = uncleared.length - shown.length
  return `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}

// One voice for both refusals that a command should be split: too many
// uncleared parts, and a judge that gave no answer on a compound command.
const SPLIT_IT =
  "Don't retry this command as it is: split it into separate simple commands, one step each. Read-only commands (git status or log, ls, cat, grep) clear in code without the judge, so only the remaining parts need judging, one at a time."

const splitIt = (shape: CommandShape) => `The parts it couldn't clear in code: ${partsList(shape.uncleared)}. ${SPLIT_IT}`

// The denial Claude reads for a refusal other than inline code and scope
// (those have their own messages).
export function policyDenial(decision: PolicyRefusal, isAgent: boolean): string {
  const owner = 'Ask the owner: they can run it themselves, or turn the judge off for this session with /scope judge off.'
  switch (decision.via) {
    case 'judge':
      return `Blocked by the sidekick policy judge: ${ended(decision.reason)} ${isAgent ? STOP_AND_REPORT : owner}`
    case 'complexity':
      if (decision.shape !== undefined) return `Blocked by the sidekick guard: ${decision.reason}, so the judge was not asked. ${splitIt(decision.shape)}`
      return `Blocked by the sidekick guard: ${decision.reason}. Split it into smaller commands, one step each, so each can be checked.`
    case 'budget':
      return `Blocked by the sidekick guard: ${decision.reason}, and it fails closed. ${isAgent ? 'Stop and report; the owner can raise the ceiling (judgeBudgetAgent).' : owner}`
    case 'fail-closed':
      if (decision.shape !== undefined) {
        return [
          `Blocked by the sidekick guard: ${decision.reason}, and it fails closed.`,
          `The guard couldn't judge this command as one: it is ${sizeOf(decision.shape)}.`,
          splitIt(decision.shape),
          `If a part is still blocked on its own, ${isAgent ? 'stop and report.' : 'tell the owner.'}`,
        ].join(' ')
      }
      return `Blocked by the sidekick guard: ${decision.reason}, and it fails closed. Retry once; if it is blocked again, ${isAgent ? 'stop and report.' : 'tell the owner.'}`
  }
}

// The question the owner is asked instead, in their own session.
export function policyQuestion(decision: PolicyRefusal): string {
  const splitNote = 'If you refuse, Claude is told to run the parts as separate simple commands.'
  switch (decision.via) {
    case 'judge':
      return `Sidekick policy judge: BLOCK: ${ended(decision.reason)} Allow it anyway?`
    case 'complexity':
      return `Sidekick guard: ${decision.reason}, so the judge was not asked. Allow it anyway?${decision.shape === undefined ? '' : ` ${splitNote}`}`
    case 'budget':
      return `Sidekick guard: ${decision.reason}. Allow it without the judge?`
    case 'fail-closed':
      if (decision.shape !== undefined) return `Sidekick guard: ${decision.reason}. The command is ${sizeOf(decision.shape)}, too much to judge as one. Allow it anyway? ${splitNote}`
      return `Sidekick guard: ${decision.reason}. Allow it anyway?`
  }
}

// The owner's toast when an agent is refused.
export function policyToast(tool: ShellTool, decision: PolicyRefusal): string {
  const split = decision.shape === undefined ? '' : `; the command is ${sizeOf(decision.shape)}, and the agent is told to split it`
  return ended(`Policy guard refused ${tool}: ${decision.reason.replace(/\.$/, '')}${split}`)
}
