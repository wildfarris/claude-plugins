// Steering orders under way, through the hooks: direct messages to order
// agents blocked, the person's /council message, Claude's amendments (code
// refusals before any model call, the council's ruling, delivery, the cap)
// and recalls (changes refused, the turn.step ceiling, the recalled status).

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Order } from '../types'
import { RECALL_STEPS, normalizedChange, orderForRecipient, readAmendment, recallOrder, recallStep, recalledReport } from '../hooks/control'
import { withLostAgents } from '../hooks/court'
import { baseStandIn, composer, presentation } from './stand-in'

const ROOT = '/dev/work'
const PANE = { title: 'The Council', isFocused: false, bodyColumns: 100, bodyRows: 40 }
const DIRS = ['api', 'web']

type Sent = { to: unknown; text: string; origin: { kind: string }; agentId?: string }

function standIn(on: On, options: { verdict?: (system: string, prompt: string) => string; slowWrite?: Promise<unknown> } = {}) {
  const sent: Sent[] = []
  const steps: Array<{ agentId?: string }> = []
  let spawns = 0
  const harness = baseStandIn(on, {
    root: ROOT,
    complete: ({ system, prompt }) => options.verdict?.(system, prompt) ?? 'CONCERN: 2\nVERDICT: Reasonable.\nDETAIL: Scoped well.',
    // A Write runs until `slowWrite` settles, when a test gives one.
    toolResult: async tool => {
      if (tool === 'Write' && options.slowWrite) await options.slowWrite
      return undefined
    },
  })
  on('fs.stat', ($, e) => (DIRS.some(folder => e.path.replace(/\\/g, '/').endsWith(`/work/${folder}`)) ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } : { deny: 'no such file' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.list', () => ({ deny: 'no such directory' }))
  on('agent.spawn', ($, e) => {
    const input = e as unknown as { resume?: { agentId: string }; model?: string }
    if (input.resume === undefined) spawns++
    return { model: input.model ?? 'inherit', agentId: input.resume?.agentId ?? `agent-${spawns}` }
  })
  on('agent.list', () => ({ value: Array.from({ length: spawns }, (_, index) => ({ id: `agent-${index + 1}`, status: 'running', description: '', type: 'x' })) }) as never)
  on('turn.step', async function* ($, e) {
    steps.push({ agentId: e.agentId })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  // The engine's delivery, beneath the plugin: every send that got this far.
  on('session.send', ($, e) => {
    sent.push({ to: e.to, text: e.text, origin: e.origin, agentId: e.agentId })
    return { isDelivered: true }
  })
  return Object.assign(harness, { sent, steps })
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
const propose = ($: Engine, dispatches: Array<{ folder: string; role: 'scout' | 'knight' }>) =>
  $.tool.call({ tool: 'mcp__council__propose_orders', plan: 'Work.', dispatches: dispatches.map(entry => ({ ...entry, task: `Work in ${entry.folder}.`, todos: ['Do it'] })) } as never)
const text = (result: unknown) => String((result as { result?: unknown }).result ?? (result as { deny?: unknown }).deny)
const denial = (result: unknown) => (result as { deny?: string }).deny
const cmdText = (result: { text?: unknown }) => String(result.text)
const spawn = ($: Engine, subagentType: string, description: string, extra: Record<string, unknown> = {}) =>
  $.agent.spawn({ subagentType, description, prompt: 'Do the work.', ...extra } as never) as Promise<{ deny?: string; agentId?: string }>
const finish = ($: Engine, agentId: string, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', agentId, reason: 'answer' } as never)
const progress = ($: Engine, agentId: string, status: 'completed' | 'in_progress', extra: string[] = []) =>
  $.tool.call({ tool: 'mcp__council__progress', agentId, todos: [{ content: 'Do it', status, activeForm: 'Doing it' }, ...extra.map(content => ({ content, status: 'pending', activeForm: content }))] } as never)
const send = ($: Engine, to: string, origin: { kind: 'model' } | { kind: 'plugin'; name: string }, agentId?: string) =>
  $.session.send({ to, text: 'Please also fix the docs.', origin, ...(agentId ? { agentId } : {}) } as never) as Promise<{ isDelivered: boolean; reason?: string }>
const amend = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__council__amend_order', ...input } as never)
const recall = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__council__recall_order', ...input } as never)
const person = (args: string) => composer('council', args)
const notPerson = (args: string) => ({ command: 'council', args, origin: { kind: 'sdk' as const }, presentation })
const mountPane = ($: Engine) => $.ui.mount({ plugin: 'council', surface: 'terminal', component: 'Pane', requestId: 'council-chamber', props: PANE })
const mainLines = (session: { appended: () => ReadonlyArray<{ agentId?: string; door: string; message: { content: unknown[] } }> }) =>
  session.appended().filter(row => row.agentId === undefined && row.door === 'note').map(row => String((row.message.content[0] as { text?: unknown }).text))
// One model request of an agent: the chunks of its response, as shown and recorded.
async function step($: Engine, agentId: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'sonnet', messageCount: 1, agentId } as never)
  const chunks: Array<Record<string, unknown>> = []
  for await (const chunk of stream) chunks.push(chunk as Record<string, unknown>)
  const answer = chunks.filter(chunk => chunk.kind === 'text').map(chunk => String(chunk.text)).join('')
  return { chunks, answer }
}

// ── Direct messages ───────────────────────────────────────────────────────

test("a model's message to an order's agent is refused, from the main session or a subagent, naming the alternative", async ($, on) => {
  const harness = standIn(on)
  await start($)
  await propose($, [{ folder: 'api', role: 'knight' }, { folder: 'web', role: 'scout' }])
  await spawn($, 'council:knight', 'O1 api', { name: 'api-knight' })
  await spawn($, 'council:scout', 'O2 web')
  const main = await send($, 'agent-1', { kind: 'model' })
  expect(main).toEqual({ isDelivered: false, reason: 'Direct messages to O1 are blocked: use mcp__council__amend_order to change its task, or mcp__council__recall_order to stop it.' })
  // By the name the dispatch gave it, or by its order id.
  expect((await send($, 'API-Knight', { kind: 'model' })).isDelivered).toBe(false)
  expect((await send($, 'O2', { kind: 'model' })).reason).toContain('Direct messages to O2 are blocked')
  // From a subagent: it reports to Claude instead.
  const fromScout = await send($, 'agent-1', { kind: 'model' }, 'agent-2')
  expect(fromScout.isDelivered).toBe(false)
  expect(fromScout.reason).toContain('put it in your final report to Claude')
  // Whatever its status: a finished order's agent is blocked too.
  await progress($, 'agent-1', 'completed')
  await finish($, 'agent-1', 'Done.')
  expect((await send($, 'agent-1', { kind: 'model' })).isDelivered).toBe(false)
  expect(harness.sent).toEqual([])
  // A plugin's send passes, and so does a model's to anyone else.
  expect((await send($, 'agent-1', { kind: 'plugin', name: 'other' })).isDelivered).toBe(true)
  expect((await send($, 'helper-9', { kind: 'model' })).isDelivered).toBe(true)
  expect(harness.sent.map(entry => entry.to)).toEqual(['agent-1', 'helper-9'])
})

// ── /council message ──────────────────────────────────────────────────────

test("/council message sends the person's word to an order's agent, records it, and shows it; only the person can", async ($, on) => {
  const harness = standIn(on)
  await start($)
  await propose($, [{ folder: 'api', role: 'knight' }, { folder: 'web', role: 'scout' }])
  await spawn($, 'council:knight', 'O1 api')
  expect(cmdText(await $.command.run(notPerson('message O1 use the helper')))).toContain("Only the person can message an order's agent")
  expect(cmdText(await $.command.run(person('message O2 hello')))).toContain('O2 has no agent')
  expect(cmdText(await $.command.run(person('message O9 hello')))).toBe('No order O9.')
  expect(cmdText(await $.command.run(person('message o1 use the  existing helper')))).toBe("Sent to O1's agent (knight in api/).")
  expect(harness.sent.length).toBe(1)
  const [message] = harness.sent
  expect(JSON.stringify(message!.to)).toContain('agent-1')
  expect(message!.origin.kind).toBe('plugin')
  expect(message!.text).toBe('[Message from the person about order O1, sent with /council message]\nuse the  existing helper')
  const pane = await mountPane($)
  expect(await pane.find({ text: /^✉ you: use the existing helper$/ })).toBeDefined()
  await pane.unmount()
  // A question that merely starts with "message" is still a question for the council.
  expect(cmdText(await $.command.run(person('message queues or polling?')))).toContain('convenes on')
})

// ── Amendments ────────────────────────────────────────────────────────────

const AMEND_VERDICTS = (system: string, prompt: string) => {
  if (!prompt.includes('The amendment:')) return 'CONCERN: 2\nVERDICT: Reasonable.\nDETAIL: Scoped well.'
  if (prompt.includes('The amendment: Also add an FTP')) return system.includes('You are The Seneschal') ? 'CONCERN: 5\nVERDICT: This is new work, not this task.\nDETAIL: Split it out.' : 'CONCERN: 1\nVERDICT: Fine.'
  if (system.includes('You are The Castellan')) return 'CONCERN: 3\nVERDICT: Keep the cache local.\nDETAIL: No shared state.'
  return 'CONCERN: 1\nVERDICT: Fine.'
}

test('code refusals come before any model call: not dispatched, finished, unknown, from a subagent, malformed', async ($, on) => {
  const harness = standIn(on, { verdict: AMEND_VERDICTS })
  await start($)
  await propose($, [{ folder: 'api', role: 'knight' }, { folder: 'web', role: 'knight' }])
  await spawn($, 'council:knight', 'O1 api')
  await progress($, 'agent-1', 'completed')
  await finish($, 'agent-1', 'Done.')
  const calls = harness.completions.length
  expect(text(await amend($, { id: 'O2', change: 'Also cache.', reason: 'speed' }))).toContain('O2 has not been dispatched: withdraw it')
  expect(text(await amend($, { id: 'o1', change: 'Also cache.', reason: 'speed' }))).toBe('O1 is done: only an order under way (dispatched, unsettled or waiting) can be amended. Propose a new order with mcp__council__propose_orders.')
  expect(text(await amend($, { id: 'O9', change: 'Also cache.', reason: 'speed' }))).toBe('No order O9.')
  expect(text(await amend($, { id: 'O1', change: 'Also cache.', reason: 'speed', agentId: 'agent-1' }))).toContain('Only the main session amends orders')
  expect(text(await amend($, { id: 'O1', reason: 'speed' }))).toContain('Say what changes')
  expect(text(await amend($, { id: 'O1', change: 'x', reason: 'y', todos: ['1', '2', '3', '4', '5', '6', '7'] }))).toContain('at most 6 todos')
  expect(harness.completions.length).toBe(calls)
})

test('an approved amendment is sent to its agent with its conditions, adds its todos, and uses up the cap', async ($, on) => {
  const harness = standIn(on, { verdict: AMEND_VERDICTS })
  await start($)
  await propose($, [{ folder: 'api', role: 'knight' }])
  const planCalls = harness.completions.length
  await spawn($, 'council:knight', 'O1 api')
  await progress($, 'agent-1', 'in_progress')
  const ruled = text(await amend($, { id: 'O1', change: 'Also cache the limits.', reason: 'Lookups are slow.', todos: ['Add the cache'] }))
  // As cheap as a plan's ruling: one call per seated member, nothing more.
  expect(harness.completions.length - planCalls).toBe(planCalls)
  const brief = harness.completions[harness.completions.length - 1]!.prompt
  expect(brief).toContain("The order's task: Work in api.")
  expect(brief).toContain('Its todos (0 of 1 done): [>] Do it')
  expect(brief).toContain('The amendment: Also cache the limits.')
  expect(brief).toContain('Todos it adds: Add the cache')
  expect(ruled).toContain('The council approved the amendment to O1 (gravest concern 3/5).')
  expect(ruled).toContain('- The Castellan: Keep the cache local. (No shared state.)')
  expect(ruled).toContain("It was sent to O1's agent.")
  expect(ruled).toContain('O1 has no amendments left.')
  expect(harness.sent.length).toBe(1)
  expect(harness.sent[0]!.origin.kind).toBe('plugin')
  expect(harness.sent[0]!.text).toContain('[Amendment to order O1, approved by the council]')
  expect(harness.sent[0]!.text).toContain('Change: Also cache the limits.')
  expect(harness.sent[0]!.text).toContain('- Add the cache')
  expect(harness.sent[0]!.text).toContain('- The Castellan: Keep the cache local.')
  const pane = await mountPane($)
  expect(await pane.find({ text: /^✎ amendment approved: Also cache the limits\.$/ })).toBeDefined()
  expect(await pane.find({ text: /^0\/2/ })).toBeDefined()
  await pane.unmount()
  // The cap (1) is used: the next is refused with no model call, naming what to do instead.
  const calls = harness.completions.length
  const capped = text(await amend($, { id: 'O1', change: 'And log it.', reason: 'Debugging.' }))
  expect(capped).toContain('O1 already has 1 amendment, the most an order takes (amendmentsPerOrder 1')
  expect(capped).toContain('mcp__council__recall_order')
  expect(capped).toContain('/council message')
  expect(harness.completions.length).toBe(calls)
})

test('a refused amendment returns the reason, suggests a new order for new work, and counts toward the cap; repeats are refused unasked', { options: { amendmentsPerOrder: 2 } }, async ($, on) => {
  const harness = standIn(on, { verdict: AMEND_VERDICTS })
  await start($)
  await propose($, [{ folder: 'api', role: 'knight' }])
  await spawn($, 'council:knight', 'O1 api')
  const refused = text(await amend($, { id: 'O1', change: 'Also add an FTP server.', reason: 'Uploads.' }))
  expect(refused).toContain('The council refused the amendment to O1 (gravest concern 5/5). The Seneschal: This is new work, not this task. Split it out.')
  expect(refused).toContain('The council called it new work: propose it as a new order with mcp__council__propose_orders.')
  expect(refused).toContain('O1 has 1 amendment left.')
  expect(harness.sent).toEqual([])
  let calls = harness.completions.length
  // The same change again, however it is spelled: refused without the council.
  expect(text(await amend($, { id: 'O1', change: 'also add an  FTP server', reason: 'Really.' }))).toContain('The council already ruled on that change to O1 (refused)')
  expect(harness.completions.length).toBe(calls)
  // The refused one counted: one more is put, then the cap holds.
  expect(text(await amend($, { id: 'O1', change: 'Cache the limits.', reason: 'Speed.' }))).toContain('approved')
  calls = harness.completions.length
  expect(text(await amend($, { id: 'O1', change: 'Log the limits.', reason: 'Debugging.' }))).toContain('O1 already has 2 amendments')
  expect(harness.completions.length).toBe(calls)
  const pane = await mountPane($)
  expect(await pane.find({ text: /^✎ amendment refused: Also add an FTP server\.$/ })).toBeDefined()
  await pane.unmount()
})

test('with amendments off, every amendment is refused unasked', { options: { amendmentsPerOrder: 0 } }, async ($, on) => {
  const harness = standIn(on)
  await start($)
  await propose($, [{ folder: 'api', role: 'knight' }])
  await spawn($, 'council:knight', 'O1 api')
  const calls = harness.completions.length
  expect(text(await amend($, { id: 'O1', change: 'Cache.', reason: 'Speed.' }))).toContain('Amendments are off (amendmentsPerOrder 0)')
  expect(harness.completions.length).toBe(calls)
})

// ── Recalls ───────────────────────────────────────────────────────────────

test('a recalled agent may read but change nothing; after 3 more requests its 4th is answered for it, and its order is recalled', async ($, on) => {
  const harness = standIn(on)
  const session = mock.session(on)
  await start($)
  await propose($, [{ folder: 'api', role: 'knight' }, { folder: 'api', role: 'knight' }])
  await spawn($, 'council:knight', 'O1 api')
  // Before the recall, its changes go through and are tracked.
  expect(denial(await $.tool.call({ tool: 'Edit', agentId: 'agent-1', file_path: `${ROOT}/api/a.ts`, old_string: 'a', new_string: 'b' } as never))).toBeUndefined()
  expect(denial(await $.tool.call({ tool: 'Write', agentId: 'agent-1', file_path: `${ROOT}/api/lib/b.ts`, content: 'x' } as never))).toBeUndefined()
  expect(denial(await $.tool.call({ tool: 'Edit', agentId: 'agent-1', file_path: `${ROOT}/api/a.ts`, old_string: 'b', new_string: 'c' } as never))).toBeUndefined()
  const ran = harness.tools.length
  // Only the main session recalls.
  expect(text(await recall($, { id: 'O1', reason: 'wrong folder', agentId: 'agent-2' }))).toContain('Only the main session recalls orders')
  expect(text(await recall($, { id: 'O1' }))).toContain('Give a short reason')
  expect(text(await recall($, { id: 'O1', reason: 'wrong folder' }))).toContain("O1 is recalled: its agent's changing tool calls are refused from now on")
  expect(text(await recall($, { id: 'O1', reason: 'again' }))).toBe('O1 is already recalled.')
  // Changes are refused, with the reason; reads and progress pass.
  const RECALLED = 'Recalled: wrong folder. Make no more changes. Report what you changed and its state, then stop.'
  expect(denial(await $.tool.call({ tool: 'Edit', agentId: 'agent-1', file_path: `${ROOT}/api/a.ts`, old_string: 'c', new_string: 'd' } as never))).toBe(RECALLED)
  expect(denial(await $.tool.call({ tool: 'Bash', agentId: 'agent-1', command: 'rm -rf build' } as never))).toBe(RECALLED)
  expect(denial(await $.tool.call({ tool: 'PowerShell', agentId: 'agent-1', command: 'ls' } as never))).toBe(RECALLED)
  expect(denial(await $.tool.call({ tool: 'mcp__council__withdraw_orders', agentId: 'agent-1', ids: ['O2'], reason: 'x' } as never))).toBeDefined()
  expect(harness.tools.length).toBe(ran)
  expect(denial(await $.tool.call({ tool: 'Read', agentId: 'agent-1', file_path: `${ROOT}/api/a.ts` } as never))).toBeUndefined()
  expect(denial(await $.tool.call({ tool: 'Grep', agentId: 'agent-1', pattern: 'x' } as never))).toBeUndefined()
  expect(text(await progress($, 'agent-1', 'in_progress'))).toBe('Noted.')
  // It still holds its place until its turn ends.
  expect((await spawn($, 'council:knight', 'O2 api')).deny).toContain('wait for O1 to finish')
  // Three more requests reach the model; the fourth is answered here, without one.
  for (let request = 0; request < RECALL_STEPS; request++) expect((await step($, 'agent-1')).chunks).toEqual([])
  expect(harness.steps.length).toBe(RECALL_STEPS)
  const ceiling = await step($, 'agent-1')
  expect(harness.steps.length).toBe(RECALL_STEPS)
  // A final reply: text, then the stop, no tool call (so no tool is cut short).
  expect(ceiling.chunks.map(chunk => chunk.kind)).toEqual(['text', 'stop'])
  expect(ceiling.chunks[1]).toMatchObject({ stopReason: 'end_turn' })
  expect(ceiling.answer).toContain('Recalled: wrong folder. The council ended this turn at its recall ceiling.')
  expect(ceiling.answer).toContain('Files changed with file tools: a.ts, lib/b.ts. Shell changes are not tracked.')
  // Other agents and the main loop are untouched.
  await step($, 'agent-9')
  expect(harness.steps.length).toBe(RECALL_STEPS + 1)
  // Its turn ends with that answer: recalled, not done or unsettled, and Claude is told.
  await finish($, 'agent-1', ceiling.answer)
  expect(mainLines(session)).toContain('Council: O1 recalled (wrong folder); touched: a.ts, lib/b.ts (shell changes are not tracked). Review or revert, then propose a new order if needed.')
  const pane = await mountPane($)
  expect(await pane.find({ text: /^recalled$/ })).toBeDefined()
  expect(await pane.find({ text: /^⏏ recalled by Claude: wrong folder$/ })).toBeDefined()
  expect(await pane.find({ text: /^touched: a\.ts, lib\/b\.ts · shell changes not tracked$/ })).toBeDefined()
  await pane.press({ key: 'order-toggle-O1' })
  expect(await pane.find({ text: /Files changed with file tools: a\.ts, lib\/b\.ts/ })).toBeDefined()
  await pane.unmount()
  // Its place is free, and it never wakes again.
  expect((await spawn($, 'council:knight', 'O2 api')).agentId).toBe('agent-2')
  const woke = await spawn($, 'council:knight', 'wake', { prompt: '', resume: { agentId: 'agent-1' } })
  expect(woke.deny).toBe('O1 was recalled: the wake is refused.')
  expect(text(await amend($, { id: 'O1', change: 'More.', reason: 'x' }))).toContain('O1 is recalled')
  expect(cmdText(await $.command.run(person('message O1 hello')))).toContain('O1 was recalled')
})

test('a recall never cuts a write short: a call already running finishes, and is counted as touched', async ($, on) => {
  // The engine runs the Write slowly: it is still in flight when the recall lands.
  let release = () => undefined as unknown
  let isWritten = false
  const gate = new Promise(resolve => (release = () => resolve(undefined))).then(() => (isWritten = true))
  standIn(on, { slowWrite: gate })
  const session = mock.session(on)
  await start($)
  await propose($, [{ folder: 'api', role: 'knight' }])
  await spawn($, 'council:knight', 'O1 api')
  const writing = $.tool.call({ tool: 'Write', agentId: 'agent-1', file_path: `${ROOT}/api/big.ts`, content: 'x' } as never)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(isWritten).toBe(false)
  await recall($, { id: 'O1', reason: 'stop' })
  release()
  expect(denial(await writing)).toBeUndefined()
  expect(isWritten).toBe(true)
  // The next one is refused at its start, before it runs.
  expect(denial(await $.tool.call({ tool: 'Write', agentId: 'agent-1', file_path: `${ROOT}/api/more.ts`, content: 'x' } as never))).toContain('Recalled: stop.')
  await finish($, 'agent-1', 'Wrote big.ts.')
  expect(mainLines(session)).toEqual(['Council: O1 recalled (stop); touched: big.ts (shell changes are not tracked). Review or revert, then propose a new order if needed.'])
})

test('an agent that answers on its own after a recall is recalled with its report and the files it touched', async ($, on) => {
  standIn(on)
  const session = mock.session(on)
  await start($)
  await propose($, [{ folder: 'api', role: 'knight' }])
  await spawn($, 'council:knight', 'O1 api')
  await $.tool.call({ tool: 'Edit', agentId: 'agent-1', file_path: `${ROOT}/api/a.ts`, old_string: 'a', new_string: 'b' } as never)
  await recall($, { id: 'O1', reason: 'plan changed' })
  await step($, 'agent-1')
  await finish($, 'agent-1', 'I edited a.ts; it compiles.')
  expect(mainLines(session)).toEqual(['Council: O1 recalled (plan changed); touched: a.ts (shell changes are not tracked). Review or revert, then propose a new order if needed.'])
  const pane = await mountPane($)
  await pane.press({ key: 'order-toggle-O1' })
  expect(await pane.find({ text: /^I edited a\.ts; it compiles\.\n\nTouched \(file tools\): a\.ts\. Shell changes are not tracked\.$/ })).toBeDefined()
  await pane.unmount()
})

test('an unsettled or waiting order is recalled at once; /council recall is the person\'s, and Claude is told', async ($, on) => {
  standIn(on)
  const session = mock.session(on)
  await start($)
  await propose($, [{ folder: 'api', role: 'knight' }, { folder: 'web', role: 'knight' }, { folder: 'api', role: 'scout' }, { folder: 'api', role: 'knight' }])
  await spawn($, 'council:knight', 'O1 api')
  await finish($, 'agent-1', 'Paused.')
  expect(cmdText(await $.command.run(notPerson('recall O1 scope changed')))).toContain('Only the person can recall an order')
  expect(cmdText(await $.command.run(person('recall O1 scope changed')))).toBe('O1 is recalled; touched: no files through its file tools (shell changes are not tracked). api/ is free. Review or revert, then propose a new order if needed.')
  expect(mainLines(session)).toContain('Council: O1 recalled (scope changed); touched: no files through its file tools (shell changes are not tracked). Review or revert, then propose a new order if needed.')
  expect((await spawn($, 'council:knight', 'wake', { prompt: '', resume: { agentId: 'agent-1' } })).deny).toBe('O1 was recalled: the wake is refused.')
  expect((await spawn($, 'council:knight', 'O4 api')).agentId).toBeDefined()
  // Waiting: recalled at once by Claude's tool, which says so itself.
  await spawn($, 'council:knight', 'O2 web')
  await finish($, 'agent-3', 'Waiting on CI.')
  await $.tool.call({ tool: 'mcp__council__settle_order', id: 'O2', outcome: 'waiting' } as never)
  expect(text(await recall($, { id: 'O2', reason: 'not needed' }))).toContain('O2 is recalled; touched: no files')
  expect(mainLines(session).filter(line => line.includes('O2 recalled'))).toEqual([])
  // A scout's recalled order refuses its wakes too; an approved or finished one can't be recalled.
  await spawn($, 'council:scout', 'O3 api')
  await finish($, 'agent-4', 'Looking.')
  expect(text(await recall($, { id: 'O3', reason: 'enough' }))).toContain('O3 is recalled')
  expect((await spawn($, 'council:scout', 'wake', { prompt: '', resume: { agentId: 'agent-4' } })).deny).toBe('O3 was recalled: the wake is refused.')
  expect(text(await recall($, { id: 'O3', reason: 'again' }))).toBe('O3 is already recalled.')
  expect(cmdText(await $.command.run(person('recall O9 x')))).toBe('No order O9.')
})

// ── The pure parts ────────────────────────────────────────────────────────

const order = (id: string, patch: Partial<Order> = {}): Order => ({
  id,
  role: 'knight',
  folder: '/dev/work/api',
  relFolder: 'api',
  task: 'task',
  todos: [{ content: 'a', status: 'pending', activeForm: 'a' }],
  conditions: [],
  status: 'dispatched',
  agentId: 'agent-1',
  steps: 0,
  edits: 0,
  report: '',
  startedAt: 1,
  endedAt: null,
  ...patch,
})

describe('steering, pure', () => {
  test('a recipient names an order by agent id, agent name or order id, never one without an agent', () => {
    const orders = [order('O1', { agentName: 'Fixer' }), order('O2', { agentId: null, status: 'approved' })]
    expect(orderForRecipient(orders, 'agent-1')?.id).toBe('O1')
    expect(orderForRecipient(orders, ' fixer ')?.id).toBe('O1')
    expect(orderForRecipient(orders, 'o1')?.id).toBe('O1')
    expect(orderForRecipient(orders, 'O2')).toBeUndefined()
    expect(orderForRecipient(orders, '')).toBeUndefined()
  })

  test('changes compare without case, punctuation or spacing; the input is checked', () => {
    expect(normalizedChange('Also, cache  the LIMITS!')).toBe(normalizedChange('also cache the limits'))
    expect(readAmendment({ id: ' o3 ', change: ' Cache. ', reason: 'Speed\nreally', todos: ['a', ' ', 'b'] })).toEqual({ id: 'O3', change: 'Cache.', reason: 'Speed really', todos: ['a', 'b'] })
  })

  test('the ceiling counts requests, then answers every one after', () => {
    let current = recallOrder([order('O1')], { id: 'O1', reason: 'r' }, 'claude', 5)
    expect('order' in current && current.order).toMatchObject({ status: 'dispatched', recall: { reason: 'r', at: 5, by: 'claude', steps: 0 } })
    let recalled = 'order' in current ? current.order : order('O1')
    const answered: boolean[] = []
    for (let request = 0; request < RECALL_STEPS + 2; request++) {
      const next = recallStep(recalled)
      answered.push(next.isAnswered)
      recalled = next.order
    }
    expect(answered).toEqual([false, false, false, true, true])
    expect(recalled.recall).toMatchObject({ steps: RECALL_STEPS, isEnded: true })
    // Its report is then the council's reply alone.
    expect(recalledReport(recalled, 'Recalled: r.')).toBe('Recalled: r.')
    current = recallOrder([order('O1', { status: 'done' })], { id: 'O1', reason: 'r' }, 'claude', 5)
    expect(current).toEqual({ error: 'O1 is done; only an order under way (dispatched, unsettled or waiting) can be recalled.' })
  })

  test("a recalled order whose agent is gone is recalled, not lost", () => {
    const recalled = order('O1', { recall: { reason: 'r', at: 1, by: 'person', steps: 0 } })
    expect(withLostAgents([recalled, order('O2', { agentId: 'agent-2' })], new Set(), 9).map(entry => entry.status)).toEqual(['recalled', 'lost'])
  })
})
