// Knight overlap, lost agents, levels, the advisor agent, council summons,
// and the order lifecycle (unsettled orders, settling, releasing, wakes),
// through the hooks.

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Court } from '../types'
import { SUMMONS_TIMEOUT_MS } from '../hooks/advisors'
import { baseStandIn, composer, presentation, settle, testPath } from './stand-in'

const ROOT = '/dev/work'
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const PANE = { title: 'The Council', isFocused: false, bodyColumns: 100, bodyRows: 40 }
const DIRS = ['api', 'api/src', 'web', 'repo1', 'repo1/a', 'repo1/b', 'repo2']
const REPOS = ['repo1', 'repo2']

type Spawn = { subagentType: string; description: string; prompt: string; model?: string; cwd?: string; resume?: { agentId: string } }

function standIn(on: On, options: { verdict?: (system: string, prompt: string) => string; denyAdvisor?: string } = {}) {
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
    if (options.denyAdvisor !== undefined && (input.subagentType ?? (input as unknown as { subagent_type?: string }).subagent_type) === 'council:advisor') return { deny: options.denyAdvisor }
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
// Lets background work run until the advisor has been spawned; its agent id.
const advisorSpawned = async (harness: { spawned: Spawn[] }) => {
  for (let tries = 0; tries < 40 && !harness.spawned.some(entry => entry.subagentType === 'council:advisor'); tries++) await settle()
  await settle()
  return `agent-${harness.spawned.findIndex(entry => entry.subagentType === 'council:advisor') + 1}`
}
const person = (args: string) => composer('council', args)
const notPerson = (args: string) => ({ command: 'council', args, origin: { kind: 'sdk' as const }, presentation })

// ── Knight overlap ────────────────────────────────────────────────────────

test('knights in one repository go one after another: the second waits, scouts and other repos do not', async ($, on) => {
  const harness = standIn(on)
  await start($)
  // Several knights for one repo in one proposal are fine: they run in turn.
  expect(text(await propose($, 'Two steps in repo1, a look, and repo2.', [
    { folder: 'repo1/a', role: 'knight' },
    { folder: 'repo1/b', role: 'knight' },
    { folder: 'repo1/b', role: 'scout' },
    { folder: 'repo2', role: 'knight' },
  ]))).toContain('The council approved the plan')
  expect((await spawn($, 'council:knight', 'O1 repo1 a')).agentId).toBe('agent-1')
  const refused = await spawn($, 'council:knight', 'O2 repo1 b')
  expect(refused.deny).toContain('the same git repository')
  expect(refused.deny).toContain('wait for O1 to finish')
  // Scouts are never held back; another repository is another place.
  expect((await spawn($, 'council:scout', 'O3 repo1 b')).agentId).toBeDefined()
  expect((await spawn($, 'council:knight', 'O4 repo2')).agentId).toBeDefined()
  // Once O1 is back, O2 may go.
  await finishAll($, 'agent-1', 'Done in a.')
  expect((await spawn($, 'council:knight', 'O2 repo1 b')).agentId).toBeDefined()
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
  const refused = text(await propose($, 'More in repo1.', [{ folder: 'repo1/b', role: 'knight' }, { folder: 'web', role: 'scout' }]))
  expect(refused).toContain('Dispatch 1 (a knight in repo1/b/) would work in the same git repository')
  expect(refused).toContain('wait for O1 to finish')
  expect(harness.completions.length).toBe(calls)
  // A scout there, or a knight elsewhere, is put to the council.
  expect(text(await propose($, 'Look in repo1.', [{ folder: 'repo1/b', role: 'scout' }, { folder: 'repo2', role: 'knight' }]))).toContain('The council approved the plan')
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

// ── The advisor agent ─────────────────────────────────────────────────────

test('nobody but the plugin starts the advisor: Claude and subagents are refused', async ($, on) => {
  const harness = standIn(on)
  await start($)
  // Not even offered to the model.
  expect(await $.agent.offer({ agent: 'council:advisor', description: 'advisor', source: 'plugin', provider: { plugin: 'council', tier: 'user' } } as never)).toMatchObject({ isOffered: false })
  expect((await spawn($, 'council:advisor', 'look around')).deny).toContain('started only by the person')
  expect((await spawn($, 'council:advisor', 'look', { prompt: 'Read.\n\n[council-advisor-token 0123456789abcdef0123]', parentAgentId: 'agent-3' })).deny).toContain('started only by the person')
  expect(cmdText(await $.command.run(notPerson('advise api where are limits?')))).toContain("Only the person can send the council's advisor")
  expect(harness.spawned.length).toBe(0)
})

test('/council advise sends the advisor to one folder, read-only; its report goes to Claude with the next message', async ($, on) => {
  const harness = standIn(on)
  await start($)
  expect(cmdText(await $.command.run(person('advise ../etc anything')))).toContain('must be a subfolder')
  expect(cmdText(await $.command.run(person('advise nope anything')))).toContain('no folder nope/')
  expect(cmdText(await $.command.run(person('advise api where are rate limits enforced?')))).toContain('A1: opus at low effort, read-only')
  expect(await advisorSpawned(harness)).toBe('agent-1')
  const [advisor] = harness.spawned
  expect(advisor).toMatchObject({ subagentType: 'council:advisor', model: 'opus' })
  expect(testPath(advisor!.cwd ?? '')).toBe(`${ROOT}/api`)
  expect(advisor!.prompt).toContain('where are rate limits enforced?')
  expect(advisor!.prompt).not.toContain('council-advisor-token')
  // Its requests run at the level's effort.
  await step($, 'agent-1', 'high')
  expect(harness.steps[0]!.effort).toBe('low')

  // It reads only, and only in its folder.
  expect((await $.tool.call({ tool: 'Read', agentId: 'agent-1', file_path: `${ROOT}/web/a.ts` } as never) as { deny?: string }).deny).toContain('reads only in')
  expect((await $.tool.call({ tool: 'Bash', agentId: 'agent-1', command: 'ls' } as never) as { deny?: string }).deny).toContain('only reads')
  expect((await $.tool.call({ tool: 'Read', agentId: 'agent-1', file_path: `${ROOT}/api/limits.ts` } as never) as { deny?: string }).deny).toBeUndefined()

  let pane = await mountPane($)
  expect(await pane.find({ text: /Advisor · api\// })).toBeDefined()
  expect(await pane.find({ text: /^reading…$/ })).toBeDefined()
  await pane.unmount()

  await finish($, 'agent-1', 'Limits live in api/limits.ts:12.')
  await settle()
  expect(harness.toasts.some(toast => toast.includes('A1: the advisor is back from api/'))).toBe(true)
  pane = await mountPane($)
  await pane.press({ key: 'advisor-toggle-A1' })
  expect(await pane.find({ text: /^Limits live in api\/limits\.ts:12\.$/ })).toBeDefined()
  await pane.unmount()

  // The next message carries the report to Claude, once.
  const first = (await $.prompt.submit({ text: 'Go on.', origin: { kind: 'composer' } } as never)) as { context?: string[] }
  expect((first.context ?? []).join('\n')).toContain('Limits live in api/limits.ts:12.')
  const second = (await $.prompt.submit({ text: 'And?', origin: { kind: 'composer' } } as never)) as { context?: string[] }
  expect((second.context ?? []).join('\n')).not.toContain('Limits live')
})

test('/council advise deep runs on the second advisor level', { options: { advisorAgentLevels: 'sonnet:low,opus:max' } }, async ($, on) => {
  const harness = standIn(on)
  await start($)
  expect(cmdText(await $.command.run(person('advise deep web why so slow?')))).toContain('opus at max effort')
  await advisorSpawned(harness)
  expect(harness.spawned[0]).toMatchObject({ subagentType: 'council:advisor', model: 'opus' })
  await step($, 'agent-1', 'low')
  expect(harness.steps[0]!.effort).toBe('max')
})

// ── Council summons ───────────────────────────────────────────────────────

const FINDINGS = 'The key is not committed; tests cover the limiter (api/limits_test.go:4).'
// Round 1: three members ask (two the same question); round 2, with the findings, all settle.
const summonsVerdicts = (system: string, prompt: string) => {
  if (prompt.includes('ITS FINDINGS')) return 'CONCERN: 1\nVERDICT: Checked and fine.\nLEVEL 1: 1'
  if (system.includes('You are The Castellan')) return 'CONCERN: 3\nVERDICT: Is a key committed?\nDETAIL: Unclear.\nCHECK: Is an API key committed in api/?'
  if (system.includes('You are The Lord Treasurer')) return 'CONCERN: 4\nVERDICT: Check the key.\nCHECK: is an API key committed in api/'
  if (system.includes('You are The Seneschal')) return 'CONCERN: 3\nVERDICT: Tests?\nCHECK: Do tests cover the limiter?'
  // A content member's CHECK is not acted on.
  return 'CONCERN: 1\nVERDICT: Fine.\nCHECK: Is the README current?'
}

// Lets background work (timers, the second round) run until `isDone` holds.
const until = async (harness: { clock: { settle: () => Promise<void> } }, isDone: () => boolean) => {
  for (let tries = 0; tries < 40 && !isDone(); tries++) {
    await harness.clock.settle()
    await settle()
  }
}

test('members who ask CHECK questions hold the orders and summon one advisor; propose_orders answers at once', async ($, on) => {
  const harness = standIn(on, { verdict: summonsVerdicts })
  const session = mock.session(on)
  await start($)
  // The tool answers before the advisor reports.
  const held = text(await propose($, 'Rate-limit the API.', [{ folder: 'api', role: 'knight' }, { folder: 'web', role: 'scout' }]))
  expect(held).toContain('The council holds O1, O2 while its advisor (A1, read-only) checks:')
  expect(held).toContain('1. Is an API key committed in api/? (asked by The Castellan, The Lord Treasurer)')
  expect(held).toContain('2. Do tests cover the limiter? (asked by The Seneschal)')
  expect(held).toContain('It rules again when the advisor reports')
  // Exactly one advisor, whatever the number of members who asked.
  const advisors = harness.spawned.filter(entry => entry.subagentType === 'council:advisor')
  expect(advisors.length).toBe(1)
  expect(advisors[0]!.model).toBe('opus')
  // Identical questions are asked once, crediting both members; a content member's is ignored.
  expect(advisors[0]!.prompt).toContain('1. Is an API key committed in api/? (asked by The Castellan, The Lord Treasurer)')
  expect(advisors[0]!.prompt).toContain('2. Do tests cover the limiter? (asked by The Seneschal)')
  expect(advisors[0]!.prompt).not.toContain('README')
  expect(harness.completions.some(call => call.prompt.includes('ITS FINDINGS'))).toBe(false)
  // Held orders can't be dispatched, named or not.
  expect((await spawn($, 'council:knight', 'O1 api')).deny).toBe("O1 is held while the council's advisor checks a fact. You will be told when the council rules; dispatch then.")
  expect((await spawn($, 'council:scout', 'look in web')).deny).toContain('O2 is held')
  // The court shows them held, and the advisor reading.
  let pane = await mountPane($)
  expect(await pane.find({ text: /^◌$/ })).toBeDefined()
  expect(await pane.find({ text: /^held: advisor checking$/ })).toBeDefined()
  expect(await pane.find({ text: /^reading…$/ })).toBeDefined()
  await pane.unmount()

  // The advisor reports: the second round runs in the background, releases the orders, and Claude is told.
  await finish($, 'agent-1', FINDINGS)
  await until(harness, () => mainLines(session).length > 0)
  const round2 = harness.completions.filter(call => call.prompt.includes('ITS FINDINGS'))
  expect(round2.length).toBe(5)
  expect(round2.every(call => !call.prompt.includes('CHECK:'))).toBe(true)
  expect(mainLines(session)).toEqual([
    [
      'Council: the advisor (A1) reported; O1, O2 approved (gravest concern 1/5).',
      `Findings: ${FINDINGS}`,
      'Dispatch them as before, the order id in each description: O1 (council:knight, api/), O2 (council:scout, web/).',
    ].join('\n'),
  ])
  expect(harness.toasts.some(toast => toast.includes('O1, O2 released after its advisor (A1)'))).toBe(true)
  expect((await spawn($, 'council:knight', 'O1 api')).agentId).toBeDefined()
  // The court shows the advisor, who asked and what; nothing is held.
  pane = await mountPane($)
  expect(await pane.find({ text: /summoned by The Castellan, The Lord Treasurer, The Seneschal/ })).toBeDefined()
  expect(await pane.find({ text: /Do tests cover the limiter\?/ })).toBeDefined()
  expect(await pane.find({ text: /^reported$/ })).toBeDefined()
  expect(await pane.find({ text: /^◌$/ })).toBeUndefined()
  await pane.unmount()
})

test('a second round that refuses withdraws the held orders, and Claude is told', async ($, on) => {
  const harness = standIn(on, {
    verdict: (system, prompt) =>
      prompt.includes('ITS FINDINGS') ? (system.includes('You are The Castellan') ? 'CONCERN: 5\nVERDICT: A key is committed.\nDETAIL: api/.env holds it.' : 'CONCERN: 1\nVERDICT: Fine.') : summonsVerdicts(system, prompt),
  })
  const session = mock.session(on)
  await start($)
  expect(text(await propose($, 'Rate-limit the API.', [{ folder: 'api', role: 'knight' }]))).toContain('The council holds O1')
  await finish($, await advisorSpawned(harness), 'api/.env:1 holds a live key.')
  await until(harness, () => mainLines(session).length > 0)
  expect(mainLines(session)).toEqual(['Council: the advisor (A1) reported; it refused O1 (gravest concern 5/5). The Castellan: A key is committed. api/.env holds it. Revise the plan and propose again, or ask the person.'])
  expect((await spawn($, 'council:knight', 'O1 api')).deny).toContain('No approved order')
  const pane = await mountPane($)
  expect(await pane.find({ text: /withdrawn · refused after the advisor's check \(gravest concern 5\/5\)/ })).toBeDefined()
  await pane.unmount()
})

test('no CHECK, no summons; with summons off, CHECK lines are ignored', { options: { councilSummons: false } }, async ($, on) => {
  const harness = standIn(on, { verdict: summonsVerdicts })
  await start($)
  const ruled = text(await propose($, 'Rate-limit the API.', [{ folder: 'api', role: 'knight' }]))
  expect(harness.spawned.filter(entry => entry.subagentType === 'council:advisor').length).toBe(0)
  expect(harness.completions.some(call => call.prompt.includes('CHECK: <one question'))).toBe(false)
  expect(ruled).toContain('Conditions:')
  expect(ruled).not.toContain('summoned')
})

test('members who ask nothing summon no one', async ($, on) => {
  const harness = standIn(on, { verdict: () => 'CONCERN: 3\nVERDICT: Split it.\nDETAIL: Two changes.' })
  await start($)
  const ruled = text(await propose($, 'Rate-limit the API.', [{ folder: 'api', role: 'knight' }]))
  expect(harness.spawned.length).toBe(0)
  expect(ruled).toContain('Conditions:')
  expect(ruled).not.toContain('summoned')
})

test('an advisor that does not report in time leaves the council to rule on its first round, and Claude is told', async ($, on) => {
  const harness = standIn(on, { verdict: summonsVerdicts })
  const session = mock.session(on)
  await start($)
  expect(text(await propose($, 'Rate-limit the API.', [{ folder: 'api', role: 'knight' }]))).toContain('The council holds O1')
  await harness.clock.advance(SUMMONS_TIMEOUT_MS - 1000)
  await settle()
  expect(mainLines(session)).toEqual([])
  await harness.clock.advance(2000)
  await until(harness, () => mainLines(session).length > 0)
  const [line] = mainLines(session)
  expect(line).toContain('Council: the advisor (A1) did not report in time, so the council ruled on its first round; O1 approved (gravest concern 4/5).')
  expect(line).toContain('The Lord Treasurer: Check the key.')
  expect(harness.completions.some(call => call.prompt.includes('ITS FINDINGS'))).toBe(false)
  const pane = await mountPane($)
  expect(await pane.find({ text: /^timed out$/ })).toBeDefined()
  await pane.unmount()
  // A late report changes nothing.
  await finish($, 'agent-1', FINDINGS)
  await until(harness, () => false)
  expect(mainLines(session).length).toBe(1)
  expect(harness.completions.some(call => call.prompt.includes('ITS FINDINGS'))).toBe(false)
})

test('held orders Claude withdraws are not ruled on again', async ($, on) => {
  const harness = standIn(on, { verdict: summonsVerdicts })
  const session = mock.session(on)
  await start($)
  await propose($, 'Rate-limit the API.', [{ folder: 'api', role: 'knight' }])
  expect(text(await $.tool.call({ tool: 'mcp__council__withdraw_orders', ids: ['O1'], reason: 'plan changed' } as never))).toContain('Withdrew O1 (plan changed)')
  await finish($, 'agent-1', FINDINGS)
  await until(harness, () => false)
  expect(harness.completions.some(call => call.prompt.includes('ITS FINDINGS'))).toBe(false)
  expect(mainLines(session)).toEqual([])
})

test('an advisor that cannot start leaves the council to rule on its first round at once', async ($, on) => {
  standIn(on, { verdict: summonsVerdicts, denyAdvisor: 'no agents here' })
  const session = mock.session(on)
  await start($)
  const ruled = text(await propose($, 'Rate-limit the API.', [{ folder: 'api', role: 'knight' }]))
  expect(ruled).toContain('Council: the advisor (A1) failed, so the council ruled on its first round; O1 approved (gravest concern 4/5).')
  expect(mainLines(session)).toEqual([])
  expect((await spawn($, 'council:knight', 'O1 api')).agentId).toBeDefined()
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

// A reload mid-summons: the held orders, the summons and the advisor's run
// are in the court, so the advisor's report still brings the second round.
let savedSummonsCourt: unknown

test('before a reload: the council holds O1 while its advisor checks', async ($, on) => {
  const harness = standIn(on, { verdict: summonsVerdicts })
  courtStore(on, court => (savedSummonsCourt = court))
  await start($)
  expect(text(await propose($, 'Rate-limit the API.', [{ folder: 'api', role: 'knight' }]))).toContain('The council holds O1')
  expect(await advisorSpawned(harness)).toBe('agent-1')
  const court = savedSummonsCourt as Court
  expect(court.orders[0]).toMatchObject({ id: 'O1', status: 'held' })
  expect(court.summonses).toHaveLength(1)
  expect(court.summonses![0]).toMatchObject({ runId: 'A1', phase: 'checking', orderIds: ['O1'] })
  expect(court.advisors![0]).toMatchObject({ id: 'A1', status: 'running', agentId: 'agent-1', effort: 'low' })
})

test("after a reload: the advisor's report still brings the second round, and no advisor spawn gets through", async ($, on) => {
  expect(savedSummonsCourt).toBeDefined()
  const harness = standIn(on, { verdict: summonsVerdicts })
  const session = mock.session(on)
  let latest: unknown
  courtStore(on, court => (latest = court), savedSummonsCourt)
  harness.listed.set('agent-1', 'running')
  await start($)
  // No token survives a reload: no advisor spawn gets through, with a token or without.
  expect((await spawn($, 'council:advisor', 'look around')).deny).toContain('started only by the person')
  expect((await spawn($, 'council:advisor', 'look', { prompt: 'Read.\n\n[council-advisor-token 0123456789abcdef0123]' })).deny).toContain('started only by the person')
  // Still held; the advisor still runs at its level's effort and only reads.
  expect((await spawn($, 'council:knight', 'O1 api')).deny).toContain('O1 is held')
  await step($, 'agent-1', 'high')
  expect(harness.steps.map(entry => entry.effort)).toEqual(['low'])
  expect((await $.tool.call({ tool: 'Bash', agentId: 'agent-1', command: 'ls' } as never) as { deny?: string }).deny).toContain('only reads')
  await finish($, 'agent-1', FINDINGS)
  await until(harness, () => mainLines(session).length > 0)
  expect(harness.completions.filter(call => call.prompt.includes('ITS FINDINGS')).length).toBe(5)
  expect(mainLines(session)[0]).toContain('Council: the advisor (A1) reported; O1 approved (gravest concern 1/5).')
  expect((latest as Court).orders[0]).toMatchObject({ id: 'O1', status: 'approved' })
  expect((latest as Court).summonses).toEqual([])
  expect(harness.spawned.filter(entry => entry.subagentType === 'council:advisor')).toEqual([])
  expect((await spawn($, 'council:knight', 'O1 api')).agentId).toBeDefined()
})

test('after a reload mid-round: the second round starts again from the outcome the summons saved', async ($, on) => {
  expect(savedSummonsCourt).toBeDefined()
  // The court as a reload left it: the advisor back, its run cleared, the round sitting.
  const saved = savedSummonsCourt as Court
  const midRound: Court = { ...saved, advisors: [], summonses: saved.summonses!.map(entry => ({ ...entry, phase: 'ruling' as const, outcome: { status: 'done' as const, findings: FINDINGS } })) }
  const harness = standIn(on, { verdict: summonsVerdicts })
  const session = mock.session(on)
  let latest: unknown
  courtStore(on, court => (latest = court), midRound)
  await start($)
  await until(harness, () => mainLines(session).length > 0)
  expect(harness.completions.filter(call => call.prompt.includes('ITS FINDINGS')).length).toBe(5)
  expect(mainLines(session)).toHaveLength(1)
  expect(mainLines(session)[0]).toContain('Council: the advisor (A1) reported; O1 approved (gravest concern 1/5).')
  expect((latest as Court).orders[0]).toMatchObject({ id: 'O1', status: 'approved' })
})

