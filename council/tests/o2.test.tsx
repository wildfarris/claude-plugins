// Knight overlap, lost agents, levels, the order lifecycle (unsettled
// orders, settling, releasing, wakes), and a court saved before the advisor
// agent was removed, through the hooks.

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Court } from '../types'
import { baseStandIn, composer, presentation, settle, testPath } from './stand-in'

const ROOT = '/dev/work'
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const PANE = { title: 'The Council', isFocused: false, bodyColumns: 100, bodyRows: 40 }
const DIRS = ['api', 'api/src', 'web', 'repo1', 'repo1/a', 'repo1/b', 'repo2']
const REPOS = ['repo1', 'repo2']

type Spawn = { subagentType: string; description: string; prompt: string; model?: string; cwd?: string; resume?: { agentId: string } }

function standIn(on: On, options: { verdict?: (system: string, prompt: string) => string} = {}) {
  const spawned: Spawn[] = []
  // The engine's agent list: every spawned agent, running unless a test says otherwise.
  const listed = new Map<string, string>()
  const steps: Array<{ agentId?: string; effort?: unknown; model: string }> = []
  const harness = baseStandIn(on, {
    root: ROOT,
    complete: ({ system, prompt }) =>
      system.includes('You sort a person') ? 'COUNCIL' : (options.verdict?.(system, prompt) ?? 'CONCERN: 2\nVERDICT: Reasonable.\nDETAIL: Scoped well.'),
  })
  on('fs.stat', ($, e) => (DIRS.some(folder => testPath(e.path) === `${ROOT}/${folder}`) ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: REPOS.some(repo => testPath(e.path) === `${ROOT}/${repo}/.git`) }))
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.list', () => ({ deny: 'no such directory' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.fork', () => ({ value: { isAnswered: true, text: 'The person wants work done.', usage: USAGE } }))
  on('agent.spawn', ($, e) => {
    const input = e as unknown as Spawn
    // A plugin's own spawn reaches the hooks spelled as the Agent tool's input in this engine build.
    spawned.push({ subagentType: input.subagentType ?? (input as unknown as { subagent_type: string }).subagent_type, description: input.description, prompt: input.prompt, model: input.model, cwd: input.cwd, resume: input.resume })
    const agentId = input.resume?.agentId ?? `agent-${spawned.length}`
    listed.set(agentId, 'running')
    return { model: input.model ?? 'inherit', agentId }
  })
  on('agent.list', () => ({ value: [...listed].map(([id, status]) => ({ id, status, description: '', type: 'x' })) }) as never)
  on('turn.step', async function* ($, e) {
    steps.push({ agentId: e.agentId, effort: e.effort, model: e.model })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  return Object.assign(harness, { spawned, listed, steps })
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
const propose = ($: Engine, plan: string, dispatches: Array<{ folder: string; role: 'scout' | 'knight' }>, agentId?: string) =>
  $.tool.call({ tool: 'mcp__council__propose_orders', plan, dispatches: dispatches.map(entry => ({ ...entry, task: `Work in ${entry.folder}.`, todos: ['Do it'] })), ...(agentId ? { agentId } : {}) } as never)
const cmdText = (result: { text?: unknown }) => String(result.text)
const text = (result: unknown) => String((result as { result?: unknown }).result ?? (result as { deny?: unknown }).deny)
const spawn = ($: Engine, subagentType: string, description: string, extra: Record<string, unknown> = {}) => $.agent.spawn({ subagentType, description, prompt: 'Do the work.', ...extra } as never) as Promise<{ deny?: string; agentId?: string }>
const finish = ($: Engine, agentId: string, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', agentId, reason: 'answer' } as never)
// The agent checks off its one todo ("Do it"), then answers: its order is done.
const finishAll = async ($: Engine, agentId: string, answer: string) => {
  await $.tool.call({ tool: 'mcp__council__progress', agentId, todos: [{ content: 'Do it', status: 'completed', activeForm: 'Doing it' }] } as never)
  return finish($, agentId, answer)
}
const settleOrder = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__council__settle_order', ...input } as never)
const mountPane = ($: Engine, surface: 'desktop' | 'terminal' = 'terminal') => $.ui.mount({ plugin: 'council', surface, component: 'Pane', requestId: 'council-chamber', props: PANE })
const step = async ($: Engine, agentId: string | undefined, effort?: string) => {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'sonnet', messageCount: 1, ...(effort ? { effort } : {}), ...(agentId ? { agentId } : {}) } as never)
  for await (const _chunk of stream) {
    // drained
  }
}
const person = (args: string) => composer('council', args)
const notPerson = (args: string) => ({ command: 'council', args, origin: { kind: 'sdk' as const }, presentation })

// ── Knight overlap ────────────────────────────────────────────────────────

test('knights in different folders of one repository work at once; scouts are never held back', async ($, on) => {
  const harness = standIn(on)
  await start($)
  expect(text(await propose($, 'Two steps in repo1, a look, and repo2.', [
    { folder: 'repo1/a', role: 'knight' },
    { folder: 'repo1/b', role: 'knight' },
    { folder: 'repo1/b', role: 'scout' },
    { folder: 'repo2', role: 'knight' },
  ]))).toContain('The council approved the plan')
  expect((await spawn($, 'council:knight', 'O1 repo1 a')).agentId).toBe('agent-1')
  // A sibling folder in the same repository is another place.
  expect((await spawn($, 'council:knight', 'O2 repo1 b')).agentId).toBeDefined()
  expect((await spawn($, 'council:scout', 'O3 repo1 b')).agentId).toBeDefined()
  expect((await spawn($, 'council:knight', 'O4 repo2')).agentId).toBeDefined()
  expect(harness.spawned.filter(entry => entry.subagentType === 'council:knight').length).toBe(3)
})

test('the same folder or one inside the other clash; different folders with no repository do not', async ($, on) => {
  standIn(on)
  await start($)
  await propose($, 'Three knights.', [
    { folder: 'api', role: 'knight' },
    { folder: 'api', role: 'knight' },
    { folder: 'api/src', role: 'knight' },
    { folder: 'web', role: 'knight' },
  ])
  expect((await spawn($, 'council:knight', 'O1 api')).agentId).toBeDefined()
  expect((await spawn($, 'council:knight', 'O2 api')).deny).toContain('the same folder as O1')
  expect((await spawn($, 'council:knight', 'O3 api src')).deny).toContain('one folder inside the other as O1')
  expect((await spawn($, 'council:knight', 'O4 web')).agentId).toBeDefined()
})

test('a proposal whose knight would clash with one at work is refused before the council sits', async ($, on) => {
  const harness = standIn(on)
  await start($)
  await propose($, 'Limits.', [{ folder: 'repo1/a', role: 'knight' }])
  await spawn($, 'council:knight', 'O1 repo1')
  const calls = harness.completions.length
  const refused = text(await propose($, 'More in repo1.', [{ folder: 'repo1/a', role: 'knight' }, { folder: 'web', role: 'scout' }]))
  expect(refused).toContain('Dispatch 1 (a knight in repo1/a/) would work in the same folder')
  expect(refused).toContain('wait for O1 to finish')
  expect(harness.completions.length).toBe(calls)
  // A scout there, or a knight in a sibling folder, is put to the council.
  expect(text(await propose($, 'Look in repo1.', [{ folder: 'repo1/a', role: 'scout' }, { folder: 'repo1/b', role: 'knight' }]))).toContain('The council approved the plan')
})

// ── Releasing orders whose agent is gone ──────────────────────────────────

test('a dispatched order whose agent is gone is lost; a waiting or idle one is not', async ($, on) => {
  const harness = standIn(on)
  await start($)
  await propose($, 'Two knights.', [{ folder: 'api', role: 'knight' }, { folder: 'api', role: 'knight' }, { folder: 'web', role: 'knight' }])
  await spawn($, 'council:knight', 'O1 api')
  await spawn($, 'council:knight', 'O3 web')
  // Waiting on a timer or a background task, idle, or ended (a message may resume it): not gone,
  // so O1 still holds api/ and O2 must wait.
  for (const status of ['waiting', 'idle', 'completed']) {
    harness.listed.set('agent-1', status)
    harness.listed.set('agent-2', status)
    expect((await spawn($, 'council:knight', 'O2 api')).deny).toContain('wait for O1 to finish')
  }
  // No longer listed at all: gone (checked when the court is next acted on), and its place is free.
  harness.listed.delete('agent-1')
  expect((await spawn($, 'council:knight', 'O2 api')).agentId).toBeDefined()
  const pane = await mountPane($)
  expect(await pane.find({ text: /On the road · 2/ })).toBeDefined()
  expect(await pane.find({ text: /^lost$/ })).toBeDefined()
  expect(await pane.find({ text: /^its agent is gone$/ })).toBeDefined()
  await pane.unmount()
  // Its last answer, should it still come, is kept as its report; it stays lost.
  await finish($, 'agent-1', 'Finished after all.')
  const again = await mountPane($)
  await again.press({ key: 'order-toggle-O1' })
  expect(await again.find({ text: /^Finished after all\.$/ })).toBeDefined()
  expect(await again.find({ text: /^lost$/ })).toBeDefined()
  await again.unmount()
})

// ── Subagents can't convene the council ───────────────────────────────────

test('subagents cannot consult the council or propose orders', async ($, on) => {
  const harness = standIn(on)
  await start($)
  expect(text(await propose($, 'From a knight.', [{ folder: 'api', role: 'knight' }], 'agent-9'))).toContain("Subagents can't propose orders")
  expect(text(await $.tool.call({ tool: 'mcp__council__consult', question: 'q', context: 'c', agentId: 'agent-9' } as never))).toContain("Subagents can't consult the council")
  expect(harness.completions.length).toBe(0)
})

// ── Levels ────────────────────────────────────────────────────────────────

const levelVerdicts = (system: string) =>
  system.includes('You are The Castellan')
    ? 'CONCERN: 2\nVERDICT: Fine.\nDETAIL: ok\nLEVEL 1: 3\nLEVEL 2: 1'
    : system.includes('You are The Lord Treasurer')
      ? 'CONCERN: 2\nVERDICT: Fine.\nLEVEL 1: 3\nLEVEL 2: 2'
      : 'CONCERN: 1\nVERDICT: Fine.\nLEVEL 1: 2'

test('the council rates each order; its agent runs on the level\'s model and effort', async ($, on) => {
  const harness = standIn(on, { verdict: levelVerdicts })
  await start($)
  await propose($, 'Rate-limit and look.', [{ folder: 'api', role: 'knight' }, { folder: 'web', role: 'scout' }])
  // The members were asked for LEVEL lines, beside their three.
  expect(harness.completions.filter(call => call.system.includes('You are The')).every(call => call.prompt.includes('LEVEL <dispatch number>'))).toBe(true)
  let pane = await mountPane($)
  // Knight: ratings 3, 3, 2, 2, 2 → 2; scout: 1, 2 → 2 (a half rounds up).
  expect(await pane.find({ text: /^L2$/ })).toBeDefined()
  await pane.unmount()
  expect(cmdText(await $.command.run(person('level O1 3')))).toContain('O1 (knight, api/) is now level 3 (was 2)')
  await spawn($, 'council:knight', 'O1 api')
  await spawn($, 'council:scout', 'O2 web')
  // Knight level 3: opus at high effort; scout level 2: haiku at high effort.
  expect(harness.spawned.map(entry => entry.model)).toEqual(['opus', 'haiku'])
  await step($, 'agent-1', 'medium')
  await step($, 'agent-2', 'low')
  // Any other agent, the main loop, and a model that takes no effort pass untouched.
  await step($, 'agent-77', 'medium')
  await step($, undefined, 'medium')
  await step($, 'agent-1')
  expect(harness.steps.map(entry => entry.effort)).toEqual(['high', 'high', 'medium', 'medium', undefined])
  pane = await mountPane($)
  expect(await pane.find({ text: /^L3$/ })).toBeDefined()
  await pane.unmount()
  // Dispatched: its level no longer changes; and only the person sets one.
  expect(cmdText(await $.command.run(person('level O1 1')))).toContain('only an approved order not yet dispatched')
  expect(cmdText(await $.command.run(notPerson('level O1 1')))).toContain("Only the person can change an order's level")
})

// ── The order lifecycle: unsettled orders, settling, releasing, wakes ─────

// The lines the plugin added to the main conversation.
const mainLines = (session: { appended: () => ReadonlyArray<{ agentId?: string; door: string; message: { content: unknown[] } }> }) =>
  session.appended().filter(row => row.agentId === undefined && row.door === 'note').map(row => String((row.message.content[0] as { text?: unknown }).text))

test('an agent that ends with todos open leaves its order unsettled: it keeps its place and Claude is told', async ($, on) => {
  const harness = standIn(on)
  const session = mock.session(on)
  await start($)
  await propose($, 'Two in api.', [{ folder: 'api', role: 'knight' }, { folder: 'api', role: 'knight' }])
  await spawn($, 'council:knight', 'O1 api')
  await finish($, 'agent-1', 'Started the hour-long tests; waiting.')
  expect(mainLines(session)).toEqual(['Council: O1 ended with 1 of 1 todos open (Do it). Settle it with mcp__council__settle_order.'])
  expect(harness.toasts.some(toast => toast.includes('O1: the knight (L2) paused with todos open in api/'))).toBe(true)
  let pane = await mountPane($)
  expect(await pane.find({ text: /Paused · 1/ })).toBeDefined()
  expect(await pane.find({ text: /^unsettled · 1 of 1 open$/ })).toBeDefined()
  expect(await pane.find({ text: /^open: Do it$/ })).toBeDefined()
  await pane.unmount()
  // It still holds api/.
  expect((await spawn($, 'council:knight', 'O2 api')).deny).toContain('ended with todos open (settle it with mcp__council__settle_order)')
  // Only the main session settles, and only an unsettled or waiting order.
  expect(text(await settleOrder($, { id: 'O1', outcome: 'done', agentId: 'agent-1' }))).toContain('Only the main session settles orders')
  expect(text(await settleOrder($, { id: 'O2', outcome: 'done' }))).toBe('O2 is approved; only an unsettled or waiting order can be settled.')
  expect(text(await settleOrder($, { id: 'O1', outcome: 'waiting', note: 'tests run for an hour' }))).toContain('O1 settled as waiting')
  pane = await mountPane($)
  expect(await pane.find({ text: /^waiting$/ })).toBeDefined()
  expect(await pane.find({ text: /^tests run for an hour$/ })).toBeDefined()
  await pane.unmount()
  expect((await spawn($, 'council:knight', 'O2 api')).deny).toContain('waiting to wake')
  // Its wake always goes through: it goes back on the road, and its report follows the earlier one.
  const woke = await spawn($, 'council:knight', 'wake', { prompt: '', resume: { agentId: 'agent-1' } })
  expect(woke.deny).toBeUndefined()
  expect(woke.agentId).toBe('agent-1')
  pane = await mountPane($)
  expect(await pane.find({ text: /On the road · 2/ })).toBeDefined()
  expect(await pane.find({ text: /^woke$/ })).toBeDefined()
  await pane.unmount()
  await step($, 'agent-1', 'low')
  expect(harness.steps[0]!.effort).toBe('low')
  await finishAll($, 'agent-1', 'All 40 tests pass.')
  // Every todo done: done at once, nothing to settle, and the place is free.
  expect(mainLines(session).length).toBe(1)
  pane = await mountPane($)
  await pane.press({ key: 'order-toggle-O1' })
  expect(await pane.find({ text: /Started the hour-long tests; waiting\.\n\n\[woke and went on\]\nAll 40 tests pass\./ })).toBeDefined()
  await pane.unmount()
  expect((await spawn($, 'council:knight', 'O2 api')).agentId).toBeDefined()
})

test('settling as done, stopped early or failed frees the place; a turn that fails is failed', async ($, on) => {
  standIn(on)
  await start($)
  await propose($, 'Three in api.', [{ folder: 'api', role: 'knight' }, { folder: 'api', role: 'knight' }, { folder: 'api', role: 'knight' }])
  await spawn($, 'council:knight', 'O1 api')
  await finish($, 'agent-1', 'Ran out of room.')
  expect(text(await settleOrder($, { id: 'o1', outcome: 'stopped-early', note: 'context full' }))).toBe('O1 settled as stopped early. api/ is free.')
  expect(text(await settleOrder($, { id: 'O1', outcome: 'done' }))).toBe('O1 is stopped-early; only an unsettled or waiting order can be settled.')
  await spawn($, 'council:knight', 'O2 api')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't', agentId: 'agent-2', reason: 'aborted' } as never)
  expect((await spawn($, 'council:knight', 'O3 api')).agentId).toBeDefined()
  const pane = await mountPane($)
  expect(await pane.find({ text: /^stopped early$/ })).toBeDefined()
  expect(await pane.find({ text: /^context full$/ })).toBeDefined()
  expect(await pane.find({ text: /✕/ })).toBeDefined()
  await pane.unmount()
})

test('/council release marks an unsettled order lost and frees its place; only the person can', async ($, on) => {
  standIn(on)
  await start($)
  await propose($, 'Two in api.', [{ folder: 'api', role: 'knight' }, { folder: 'api', role: 'knight' }])
  await spawn($, 'council:knight', 'O1 api')
  await finish($, 'agent-1', 'Stuck.')
  expect(cmdText(await $.command.run(notPerson('release O1')))).toContain('Only the person can release an order')
  expect(cmdText(await $.command.run(person('release O2')))).toBe('O2 is approved; only an unsettled or waiting order can be released.')
  expect(cmdText(await $.command.run(person('release O1')))).toBe('O1 is released as lost; api/ is free.')
  expect((await spawn($, 'council:knight', 'O2 api')).agentId).toBe('agent-2')
  const pane = await mountPane($)
  expect(await pane.find({ text: /^released by the person$/ })).toBeDefined()
  await pane.unmount()
})

test('a settled knight wakes only while its place is free; otherwise the wake is refused and you are told why', async ($, on) => {
  const harness = standIn(on)
  await start($)
  await propose($, 'Two in api, a look in web.', [{ folder: 'api', role: 'knight' }, { folder: 'api', role: 'knight' }, { folder: 'web', role: 'scout' }])
  await spawn($, 'council:knight', 'O1 api')
  await finishAll($, 'agent-1', 'Done.')
  // Its place is free: the wake goes through.
  expect((await spawn($, 'council:knight', 'wake', { prompt: '', resume: { agentId: 'agent-1' } })).agentId).toBe('agent-1')
  await finishAll($, 'agent-1', 'Still done.')
  await spawn($, 'council:knight', 'O2 api')
  // Now O2 holds api/: O1's wake is refused, which parks its agent.
  const refused = await spawn($, 'council:knight', 'wake', { prompt: '', resume: { agentId: 'agent-1' } })
  expect(refused.deny).toBe('O1 is done and O2 now holds the same folder: the wake is refused.')
  expect(harness.toasts.some(toast => toast.includes('O1 is done and O2 now holds the same folder') && toast.includes('stays parked'))).toBe(true)
  // A scout holds no place: its wake always goes through.
  await spawn($, 'council:scout', 'O3 web')
  await finishAll($, 'agent-3', 'Looked.')
  expect((await spawn($, 'council:scout', 'wake', { prompt: '', resume: { agentId: 'agent-3' } })).agentId).toBe('agent-3')
  const pane = await mountPane($)
  expect(await pane.find({ text: /⚠/ })).toBeUndefined()
  await pane.unmount()
})

test('a wake with no order behind it is allowed, and court mode never refuses a wake', async ($, on) => {
  standIn(on)
  await start($)
  expect((await spawn($, 'council:scout', 'wake', { prompt: '', resume: { agentId: 'lost-agent' } })).agentId).toBe('lost-agent')
  await $.command.run(person('court on'))
  expect((await spawn($, 'general-purpose', 'new work')).deny).toContain('Court mode is on')
  expect((await spawn($, 'general-purpose', 'wake', { prompt: '', resume: { agentId: 'helper-1' } })).agentId).toBe('helper-1')
})

test('when the line cannot be added to the conversation, it goes beside your next message', async ($, on) => {
  standIn(on)
  on('session.append', () => ({ deny: 'not here' }) as never)
  await start($)
  await propose($, 'Work in api.', [{ folder: 'api', role: 'knight' }])
  await spawn($, 'council:knight', 'O1 api')
  await finish($, 'agent-1', 'Paused.')
  const first = (await $.prompt.submit({ text: 'Go on.', origin: { kind: 'composer' } } as never)) as { context?: string[] }
  expect(first.context ?? []).toContain('Council: O1 ended with 1 of 1 todos open (Do it). Settle it with mcp__council__settle_order.')
  const second = (await $.prompt.submit({ text: 'And?', origin: { kind: 'composer' } } as never)) as { context?: string[] }
  expect((second.context ?? []).join('\n')).not.toContain('Council: O1')
})

// ── A reload: the module starts over, the court in $.state stays ──────────

// Each test loads the plugin afresh (its module variables start empty), so a
// reload is two tests: the first saves the court as the plugin wrote it, the
// second loads the plugin over that saved court.
let savedCourt: unknown

// Records the court as the plugin writes it; given `saved`, a fresh module
// reads that court (saved before) until the plugin writes its own.
function courtStore(on: On, record: (court: unknown) => void, saved?: unknown) {
  let isWritten = false
  if (saved !== undefined) {
    on('state.get', async ($, e, next) => {
      const result = (await next(e)) as { value?: { value?: unknown; version: number } }
      if (isWritten || (e as { key?: string }).key !== 'court' || result.value?.value !== undefined) return result as never
      return { value: { value: saved, version: result.value?.version ?? 0 } } as never
    })
  }
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'court') {
      isWritten = true
      record((e as { value?: unknown }).value)
    }
    return next(e)
  })
}

test('before a reload: a level 3 knight ends with its todo open', async ($, on) => {
  const harness = standIn(on, { verdict: levelVerdicts })
  courtStore(on, court => (savedCourt = court))
  await start($)
  await propose($, 'Rate-limit.', [{ folder: 'api', role: 'knight' }])
  await $.command.run(person('level O1 3'))
  await spawn($, 'council:knight', 'O1 api')
  expect(harness.spawned[0]!.model).toBe('opus')
  await finish($, 'agent-1', 'Waiting on the tests.')
  expect((savedCourt as { orders: Array<{ status: string }> }).orders[0]!.status).toBe('unsettled')
})

test("after a reload: the unsettled order still holds its place, and its wake runs at its level's effort", async ($, on) => {
  expect(savedCourt).toBeDefined()
  const harness = standIn(on)
  let latest: unknown
  courtStore(on, court => (latest = court), savedCourt)
  // The agent is still listed (it waits to wake), so it is not lost.
  harness.listed.set('agent-1', 'idle')
  await start($)
  expect(text(await propose($, 'A knight in api.', [{ folder: 'api', role: 'knight' }]))).toContain('ended with todos open')
  const woke = await spawn($, 'council:knight', 'wake', { prompt: '', resume: { agentId: 'agent-1' } })
  expect(woke.agentId).toBe('agent-1')
  // A woken agent keeps the model it was started on; the order still names it.
  expect((latest as { orders: Array<Record<string, unknown>> }).orders[0]).toMatchObject({ id: 'O1', status: 'dispatched', wakes: 1, model: 'opus', effort: 'high', level: 3 })
  await step($, 'agent-1', 'low')
  expect(harness.steps.map(entry => entry.effort)).toEqual(['high'])
})

// A court saved by 0.5 mid-summons: a held order, the summons, and the
// advisor's run, out on agent-1. 0.6.0 has no advisor: it loads cleanly.
const SAVED_SUMMONS_COURT = {
  orders: [
    { id: 'O1', role: 'knight', folder: `${ROOT}/api`, relFolder: 'api', task: 'Rate-limit.', todos: [{ content: 'Do it', status: 'pending', activeForm: 'Do it' }], conditions: [], status: 'held', agentId: null, steps: 0, edits: 0, report: '', startedAt: null, endedAt: null, approvedAt: 1, level: 2 },
  ],
  nextOrderId: 2,
  rulings: [{ plan: 'Earlier.', isApproved: true, gravest: 2, reason: '', summons: { advisorId: 'A0', questions: [], status: 'done', findings: 'Fine.' } }],
  advisors: [{ id: 'A1', origin: 'council', relFolders: ['api'], questions: [{ question: 'Is a key committed?', askedBy: ['The Castellan'] }], isDeep: false, model: 'opus', effort: 'low', status: 'running', agentId: 'agent-1', report: '', startedAt: 1, endedAt: null }],
  nextAdvisorId: 2,
  summonses: [{ runId: 'A1', phase: 'checking', orderIds: ['O1'], startedAt: 1, deadline: 2 }],
  isInSession: false,
  heldPrompt: null,
}

test('after an upgrade: a held order loads as withdrawn, and advisor runs and summonses are dropped', async ($, on) => {
  const harness = standIn(on)
  const session = mock.session(on)
  let latest: unknown
  courtStore(on, court => (latest = court), SAVED_SUMMONS_COURT)
  harness.listed.set('agent-1', 'running')
  await start($)
  const court = latest as Court & Record<string, unknown>
  expect(court.orders[0]).toMatchObject({ id: 'O1', status: 'withdrawn', withdrawnReason: 'advisors were removed', level: 2 })
  expect(court).not.toHaveProperty('advisors')
  expect(court).not.toHaveProperty('nextAdvisorId')
  expect(court).not.toHaveProperty('summonses')
  expect(court.rulings[0]).not.toHaveProperty('summons')
  expect(court).toMatchObject({ nextOrderId: 2, rulings: [{ plan: 'Earlier.', isApproved: true }] })
  // The withdrawn order can't be dispatched; no second round ever runs, and nothing reaches Claude.
  expect((await spawn($, 'council:knight', 'O1 api')).deny).toContain('No approved order')
  await finish($, 'agent-1', 'Findings nobody waits for.')
  await settle()
  expect(mainLines(session)).toEqual([])
  expect((latest as Court).orders.map(order => order.status)).toEqual(['withdrawn'])
  // The old advisor's requests pass untouched (no effort of its own any more).
  await step($, 'agent-1', 'high')
  expect(harness.steps.map(entry => entry.effort)).toEqual(['high'])
  // The court goes on: the next order is O2, and the pane shows no advisors.
  expect(text(await propose($, 'Rate-limit again.', [{ folder: 'api', role: 'knight' }]))).toContain('- O2: subagent_type "council:knight"')
  const pane = await mountPane($)
  expect(await pane.find({ text: /Advisor/ })).toBeUndefined()
  expect(await pane.find({ text: /O1/ })).toBeDefined()
  await pane.unmount()
})
