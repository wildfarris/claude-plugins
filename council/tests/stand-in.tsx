// Stands in for the engine beneath the plugin in every hook test: the session,
// the store and clock, the UI calls the plugin makes, and the bottoms of the
// tool, prompt and turn chains, each recorded on the returned harness.

import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 19 }, view: {} }
export const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
export const presentation = { isFullscreen: false, columns: 140 }
// Background work (reviews, advisors) runs after the dispatch that started it; let it land.
export const settle = () => new Promise(resolve => setTimeout(resolve, 50))
export const composer = (command: string, args: string) => ({ command, args, origin: { kind: 'composer' as const }, presentation })

type CheckDecision = 'allow' | 'ask' | 'deny'
// A model call that comes back without an answer: an API error, or cut short (a timeout).
export type Unanswered = { unanswered: 'api-error' | 'aborted' }
const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
type Message = { role: 'user' | 'assistant'; text: string; toolUses: unknown[] }

export type Harness = {
  tools: string[]
  prompts: string[]
  filled: string[]
  draft: { text: string }
  messages: Message[]
  completions: Array<{ model: string; system: string; prompt: string; effort?: string }>
  clock: MockClock
  toasts: string[]
}

export function baseStandIn(
  on: On,
  options: {
    root: string
    cwd?: string
    decide?: (tool: string, input: unknown) => CheckDecision
    complete?: (request: { model: string; system: string; prompt: string }) => string | Unanswered | Promise<string | Unanswered>
    toolResult?: () => { result: string; text: string; isError?: true }
  },
): Harness {
  const clock = mock.clock(on, { now: 1_000_000 })
  const harness: Harness = { tools: [], prompts: [], filled: [], draft: { text: '' }, messages: [], toasts: [], completions: [], clock }
  mock.store(on)
  on('session.root', () => ({ value: options.root }))
  on('session.cwd', () => ({ value: options.cwd ?? options.root }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.messages', () => ({ value: harness.messages }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    harness.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', e => ({ value: { command: e.name } }))
  on('command.run', () => ({ text: '' }))
  on('tool.check', ($, e) => ({ decision: (options.decide ?? (() => 'ask'))(String(e.tool), e.input) }))
  on('tool.call', ($, e) => {
    harness.tools.push(String(e.tool))
    return options.toolResult?.() ?? { result: 'ok', text: 'ok' }
  })
  on('prompt.submit', ($, e) => {
    harness.prompts.push(e.text)
    // What entered beside the prompt, as core hands it back.
    return { text: e.text, context: e.context ?? [] }
  })
  on('prompt.read', () => ({ value: { text: harness.draft.text, cursor: harness.draft.text.length } }))
  on('prompt.fill', ($, e) => {
    harness.filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('model.complete', async ($, e) => {
    const request = { model: e.model, system: String(e.system ?? ''), prompt: String(e.prompt) }
    harness.completions.push({ ...request, ...(e.effort ? { effort: e.effort } : {}) })
    const reply = (await options.complete?.(request)) ?? 'NONE'
    if (typeof reply === 'string') return { value: { isAnswered: true, text: reply, usage: USAGE } }
    return {
      value:
        reply.unanswered === 'api-error'
          ? { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: NO_USAGE }
          : { isAnswered: false, reason: 'aborted', usage: NO_USAGE },
    }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })
  return harness
}
