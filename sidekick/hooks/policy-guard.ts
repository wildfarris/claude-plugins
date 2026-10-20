// The guard's decision for one shell command (Bash or PowerShell), in the
// order the checks run: deterministic refusals first, never behind a model.
// Pure.
//
//   1. the inline-code ban (inline-code.ts): refused, no model call;
//   2. the scope guard: a change outside the target folders is refused;
//   3. anything code can't settle is left to the classifier.
//
// The path rules (globs) need the disk (create or edit) and run beside this
// in register.tsx.

import { inlineCodeInBash, inlineCodeInPowerShell, type InlineFinding } from './inline-code'
import { analyzePowerShell } from './powershell'
import { analyzeCommand, type GuardVerdict, type ScopeContext } from './scope-guard'

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

// The subagent a call comes from, if the event names one.
export function agentIdOf(input: Record<string, unknown>): string | undefined {
  const id = input.agentId ?? input.agent_id
  return typeof id === 'string' && id !== '' ? id : undefined
}

export function inlineFinding(tool: ShellTool, command: string): InlineFinding | undefined {
  return tool === 'PowerShell' ? inlineCodeInPowerShell(command) : inlineCodeInBash(command)
}

export function scopeVerdict(tool: ShellTool, command: string, context: ScopeContext): GuardVerdict {
  return tool === 'PowerShell' ? analyzePowerShell(command, context) : analyzeCommand(command, context)
}

export type ShellDecision =
  | { kind: 'allow'; via: 'code' }
  | { kind: 'refuse'; via: 'inline'; finding: InlineFinding }
  | { kind: 'refuse'; via: 'scope'; verdict: Extract<GuardVerdict, { kind: 'block' }> }
  | { kind: 'judge'; reason: string }

// What a decision means for the call: a scope refusal is denied for anyone
// (as the scope guard always did); any other refusal is denied for a
// subagent, which can't be asked, and asked of the owner in their session.
export function outcomeFor(decision: ShellDecision, isAgent: boolean): 'allow' | 'deny' | 'ask' {
  if (decision.kind !== 'refuse') return 'allow'
  return decision.via === 'scope' || isAgent ? 'deny' : 'ask'
}

export type ShellOptions = { isInlineBanEnabled: boolean }

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
