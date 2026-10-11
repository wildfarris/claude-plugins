// Trim: an alternative to summary compaction. Once the context passes a
// threshold, tool output from finished turns is replaced by one-line stubs,
// except the person's answers, subagent reports and results flagged as
// errors; every prompt and every answer's text and tool calls stay, and the
// latest turns keep their output. It runs only when it frees enough to matter.
//
// Reasoning goes too, from the first changed message on: current models bind
// each thinking block to the exact history before it, so a block after an
// edit is no longer valid (the API refuses it on enforced accounts). Messages
// before the first change are handed back with their handles, whole.
//
// Pure: the plan over the transcript, the estimate and the stubs.

import type { SessionMessage, ToolUseSummary } from 'claude-code'

import { commandName, isReadOnlySegment, parseCommand } from './scope-guard'
import { estimateTokens } from './values'

export type TrimSettings = {
  // Trim once the context is at least this full (percent of the window)…
  atPercent: number
  // …and only when the trim would bring it down to this percent or less.
  targetPercent: number
  // The newest turns whose output is left whole (the turn in progress, if
  // any, is the newest).
  keepTurns: number
}

export type TrimPlan = {
  messages: SessionMessage[]
  droppedCount: number
  // Characters of tool output replaced, net of the stubs.
  savedCharacters: number
}

export const STUB_PREFIX = '[trimmed by sidekick:'

// Outputs a trim keeps: the person's answers to Claude's questions, and
// subagent reports (already a summary, often only partly relayed). Results
// flagged as errors are kept too (see planTrim).
const KEPT_TOOLS = new Set(['AskUserQuestion', 'Agent', 'Task'])

// Read-only tools: their stub says Claude can read them again.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])

// Shell commands that only read, search or list.
const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ls', 'find', 'fd', 'tree', 'wc', 'file', 'stat', 'du', 'cd', 'pwd', 'sed'])

const textInput = (input: Record<string, unknown>, key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')

// A Bash command whose every part reads, searches or lists: one of those
// commands, and read-only by the scope guard's own analysis (no redirection
// into a file, no in-place edit, no find -delete, no nested code).
export function isReadOnlyCommand(command: string): boolean {
  const segments = parseCommand(command)
  if (segments.length === 0) return false
  return segments.every(segment => READ_COMMANDS.has(commandName(segment)) && isReadOnlySegment(segment))
}

const isReadCall = (call: Pick<ToolUseSummary, 'tool' | 'input'>) => READ_TOOLS.has(call.tool) || (call.tool === 'Bash' && isReadOnlyCommand(textInput(call.input, 'command')))

// Every tool's output goes once its turn is over, except the kept ones.
export const isTrimmableCall = (call: Pick<ToolUseSummary, 'tool' | 'input'>) => !KEPT_TOOLS.has(call.tool)

const lineCount = (text: string) => (text === '' ? 0 : text.split('\n').length)

// What the call worked on, from its first telling input.
const SUBJECT_KEYS = ['file_path', 'notebook_path', 'command', 'url', 'pattern', 'path', 'query']

// The stub names the call and the output's size. Only a read is suggested
// again; anything else stays a record of what ran (the call itself is kept).
export function stubFor(call: Pick<ToolUseSummary, 'tool' | 'input'>, output: string): string {
  const key = SUBJECT_KEYS.find(name => textInput(call.input, name) !== '')
  const subject = key === undefined ? '' : textInput(call.input, key).replace(/\s+/g, ' ').slice(0, 120)
  const what = `${call.tool}${subject === '' ? '' : call.tool === 'Bash' ? ` \`${subject}\`` : ` ${subject}`}`
  const lines = lineCount(output)
  return `${STUB_PREFIX} ${what} returned ${lines} line${lines === 1 ? '' : 's'}${isReadCall(call) ? "; read it again if it's needed" : '; output dropped'}]`
}

// A prompt the person typed starts a turn; a message carrying only tool
// results is part of the turn before it.
const startsTurn = (message: SessionMessage) => message.role === 'user' && (message.toolResults ?? []).length === 0 && message.text.trim() !== ''

// A message rebuilt from its text and tool blocks, without its handle: the
// engine sends it without the thinking blocks the original carried.
const rebuilt = (message: SessionMessage, toolResults = message.toolResults): SessionMessage =>
  toolResults === undefined ? { role: message.role, text: message.text, toolUses: message.toolUses } : { role: message.role, text: message.text, toolUses: message.toolUses, toolResults }

// The transcript with the stale output stubbed. Messages before the first
// stub are handed back as they came (with their handles, kept whole); every
// message from the first stub on is rebuilt, so no thinking block outlives
// the edit before it.
export function planTrim(messages: readonly SessionMessage[], keepTurns: number): TrimPlan {
  const turnStarts = messages.flatMap((message, index) => (startsTurn(message) ? [index] : []))
  // Everything from the start of the newest `keepTurns` turns on keeps its output.
  const keepFrom = keepTurns <= 0 ? messages.length : turnStarts.length >= keepTurns ? turnStarts[turnStarts.length - keepTurns]! : 0
  const calls = new Map<string, ToolUseSummary>()
  for (const message of messages) for (const call of message.toolUses) calls.set(call.tool_use_id, call)

  let droppedCount = 0
  let savedCharacters = 0
  const trimmed = messages.map((message, index) => {
    if (index >= keepFrom || !message.toolResults || message.toolResults.length === 0) return message
    let isChanged = false
    const toolResults = message.toolResults.map(result => {
      const call = calls.get(result.tool_use_id)
      if (call === undefined || result.isError || result.text.startsWith(STUB_PREFIX) || !isTrimmableCall(call)) return result
      const stub = stubFor(call, result.text)
      if (stub.length >= result.text.length) return result
      isChanged = true
      droppedCount++
      savedCharacters += result.text.length - stub.length
      return { tool_use_id: result.tool_use_id, text: stub, isError: false }
    })
    return isChanged ? rebuilt(message, toolResults) : message
  })
  const firstChanged = trimmed.findIndex((message, index) => message !== messages[index])
  if (firstChanged === -1) return { messages: [...messages], droppedCount: 0, savedCharacters: 0 }
  return {
    messages: trimmed.map((message, index) => (index > firstChanged && message === messages[index] ? rebuilt(message) : message)),
    droppedCount,
    savedCharacters,
  }
}


export type TrimDecision = { isWorth: boolean; currentPercent: number; projectedPercent: number; savedTokens: number }

export function trimDecision(contextTokens: number, window: number, savedCharacters: number, settings: TrimSettings): TrimDecision {
  const savedTokens = estimateTokens(savedCharacters)
  const currentPercent = window > 0 ? Math.round((contextTokens / window) * 100) : 0
  const projectedPercent = window > 0 ? Math.round((Math.max(0, contextTokens - savedTokens) / window) * 100) : 0
  return { isWorth: currentPercent >= settings.atPercent && projectedPercent <= settings.targetPercent, currentPercent, projectedPercent, savedTokens }
}

export function trimNotice(plan: TrimPlan, decision: TrimDecision): string {
  return `Trimmed ${plan.droppedCount} old tool outputs, and the reasoning from that point on: at least ${Math.round(decision.savedTokens / 1000)}k tokens freed (${decision.currentPercent}% → ~${decision.projectedPercent}% or less). Nothing was summarized.`
}
