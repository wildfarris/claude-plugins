// Stands in for the engine beneath the plugin in every hook test: the session,
// the store and clock, the UI calls the plugin makes, and the bottoms of the
// tool, prompt and turn chains, each recorded on the returned harness.

import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

// The test runner provides timers; the mod's own environment (and its types) has none.
declare function setTimeout(callback: (value?: unknown) => void, ms: number): unknown

export const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 19 }, view: {} }
export const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
export const presentation = { isFullscreen: false, columns: 140 }
// Background work (reviews, advisors) runs after the dispatch that started it; let it land.
export const settle = () => new Promise(resolve => setTimeout(resolve, 50))
export const composer = (command: string, args: string) => ({ command, args, origin: { kind: 'composer' as const }, presentation })

type CheckDecision = 'allow' | 'ask' | 'deny'
export type ModelFailure = { isAnswered: false; reason: 'api-error'; status: number | null; error: 'rate_limit' | 'overloaded' | 'server_error' } | { isAnswered: false; reason: 'aborted' | 'empty-reply' }
type Message = SessionMessage

export type Harness = {
  tools: string[]
  prompts: string[]
  filled: string[]
  draft: { text: string }
  messages: Message[]
  toasts: string[]
  completions: Array<{ model: string; system: string; prompt: string }>
  clock: MockClock
}

export function baseStandIn(
  on: On,
  options: {
    root: string
    cwd?: string
    decide?: (tool: string, input: unknown) => CheckDecision
    // A string answers; a failure object is the call's unanswered result.
    complete?: (request: { model: string; system: string; prompt: string }) => string | ModelFailure | Promise<string | ModelFailure>
    toolResult?: () => { result: string; text: string; isError?: true }
    // Entries the store holds when the test starts, as an earlier session left them.
    store?: Record<string, unknown>
    // A file system in memory (path → text); absent, file calls go unanswered.
    files?: Map<string, string>
    // Answers $.process.run; absent, every process fails.
    run?: (argv: readonly string[]) => { exitCode: number; stdout: string } | undefined
  },
): Harness {
  const clock = mock.clock(on, { now: 1_000_000 })
  const harness: Harness = { tools: [], prompts: [], filled: [], draft: { text: '' }, messages: [], toasts: [], completions: [], clock }
  mock.store(on, options.store)
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
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.run', () => ({ text: '' }))
  on('tool.check', ($, e) => ({ decision: (options.decide ?? (() => 'ask'))(String(e.tool), e.input) }))
  on('tool.call', ($, e) => {
    harness.tools.push(String(e.tool))
    return options.toolResult?.() ?? { result: 'ok', text: 'ok' }
  })
  on('prompt.submit', ($, e) => {
    harness.prompts.push(e.text)
    return { text: e.text }
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
    harness.completions.push(request)
    const answer = await options.complete?.(request)
    return { value: typeof answer === 'object' ? { ...answer, usage: USAGE } : { isAnswered: true, text: answer ?? 'NONE', usage: USAGE } }
  })
  if (options.files) memoryFiles(on, options.files)
  on('process.run', ($, e) => {
    const answer = options.run?.(e.argv) ?? { exitCode: 1, stdout: '' }
    return { value: { ...answer, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })
  return harness
}

// The fs calls over a map of path → text; a folder is any prefix of a path.
export function memoryFiles(on: On, files: Map<string, string>): void {
  const children = (folder: string) => {
    const prefix = `${folder.replace(/\/$/, '')}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue
      const [name, ...rest] = path.slice(prefix.length).split('/')
      names.set(name!, rest.length > 0 ? 'dir' : 'file')
    }
    return names
  }
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || children(e.path).size > 0 }))
  on('fs.list', ($, e) => ({
    value: [...children(e.path)].map(([name, kind]) => ({ name, kind, size: kind === 'file' ? (files.get(`${e.path}/${name}`)?.length ?? 0) : 0, mtimeMs: kind === 'file' ? 1_000_000 : 0, isLink: false })),
  }))
  on('fs.stat', ($, e) => {
    if (files.has(e.path)) return { value: { kind: 'file' as const, size: files.get(e.path)!.length, mtimeMs: 1_000_000, isLink: false } }
    if (children(e.path).size > 0) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    throw new Error(`ENOENT: ${e.path}`)
  })
}
