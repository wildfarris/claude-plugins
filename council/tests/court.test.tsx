import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { baseStandIn, composer, settle } from './stand-in'

const ROOT = '/dev/work'
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const PANE = { title: 'The Council', isFocused: false, bodyColumns: 100, bodyRows: 40 }

const PLAN = {
  plan: 'Rate-limit the billing API and make the web client back off.',
  dispatches: [
    { folder: 'api', role: 'knight', task: 'Add rate limiting to the billing endpoints.', todos: ['Read the routes', 'Add the limiter', 'Run the tests'] },
    { folder: 'web', role: 'scout', task: 'Find where the client retries.', todos: ['Find retry calls', 'Report them'] },
  ],
}

function courtStandIn(on: On, options: { verdict?: (system: string) => string } = {}) {
  const harness = baseStandIn(on, {
    root: ROOT,
    complete: ({ system, prompt }) =>
      system.includes('You sort a person')
        ? (/jester think/i.test(prompt) ? 'ASK jester' : /\?\s*\n>>>/.test(prompt) ? 'PASS' : 'COUNCIL')
        : (options.verdict?.(system) ?? 'CONCERN: 2\nVERDICT: Reasonable.\nDETAIL: Scoped well.'),
  })
  const spawned: Array<{ subagentType: string; description: string; prompt: string }> = []
  on('fs.stat', ($, e) => (['api', 'web', 'infra'].some(folder => e.path === `${ROOT}/${folder}`) ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } : { deny: 'no such file' }))
  on('fs.read', ($, e) => (e.path === `${ROOT}/api/CLAUDE.md` ? { value: 'Never log request bodies.' } : { deny: 'no such file' }))
  on('fs.list', () => ({ deny: 'no such directory' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.fork', () => ({ value: { isAnswered: true, text: 'The person wants rate limiting.', usage: USAGE } }))
  on('agent.spawn', ($, e) => {
    spawned.push({ subagentType: e.subagentType, description: e.description, prompt: e.prompt })
    return { model: 'sonnet', agentId: `agent-${spawned.length}` }
  })
  return Object.assign(harness, { spawned })
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
const propose = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__council__propose_orders', ...input })
const text = (result: unknown) => String((result as { result?: unknown }).result ?? (result as { deny?: unknown }).deny)
const spawn = ($: Engine, subagentType: string, description: string, prompt = 'Do the work.') =>
  $.agent.spawn({ subagentType, description, prompt } as never)
const mountPane = ($: Engine, surface: 'desktop' | 'terminal' = 'desktop') => $.ui.mount({ plugin: 'council', surface, component: 'Pane', requestId: 'council-chamber', props: PANE })

test('a plan the council approves becomes orders; a bad one is explained', async ($, on) => {
  courtStandIn(on)
  await start($)
  expect(text(await propose($, { plan: 'x', dispatches: [{ folder: '../other', role: 'knight', task: 't', todos: ['a'] }] }))).toContain('must be a subfolder')
  expect(text(await propose($, { plan: 'x', dispatches: [{ folder: 'nope', role: 'knight', task: 't', todos: ['a'] }] }))).toContain('no folder nope/')
  const ruled = text(await propose($, PLAN))
  expect(ruled).toContain('The council approved the plan (gravest concern 2/5).')
  expect(ruled).toContain('- O1: subagent_type "council:knight", folder api/')
  expect(ruled).toContain('- O2: subagent_type "council:scout", folder web/')

  const pane = await mountPane($)
  expect(await pane.find({ text: /The Court/ })).toBeDefined()
  expect(await pane.find({ text: /Knight · api\// })).toBeDefined()
  expect(await pane.find({ text: /On the road · 2/ })).toBeDefined()
  expect(await pane.find({ text: /^0\/3$/ })).toBeDefined()
  await pane.unmount()
})

test('a concern of 5 refuses the plan', async ($, on) => {
  courtStandIn(on, { verdict: system => (system.includes('Castellan') ? 'CONCERN: 5\nVERDICT: It deletes production data.\nDETAIL: The migration drops a table.' : 'CONCERN: 1\nVERDICT: Fine.') })
  await start($)
  const ruled = text(await propose($, PLAN))
  expect(ruled).toContain('The council refused the plan (gravest concern 5/5).')
  expect(ruled).toContain('It deletes production data.')
})

test('a dispatch carries its order: scoped, with todos and the folder rules; anything else is refused', async ($, on) => {
  const harness = courtStandIn(on)
  await start($)
  await propose($, PLAN)

  expect((await spawn($, 'council:knight', 'O9 limits for billing')) as { deny?: string }).toMatchObject({ deny: expect.stringContaining('open orders are O1') })
  const result = (await spawn($, 'council:knight', 'O1 api limits')) as { agentId?: string }
  expect(result.agentId).toBe('agent-1')
  const prompt = harness.spawned[0]!.prompt
  expect(prompt).toContain('You carry order O1 from the council')
  expect(prompt).toContain(`Work only in ${ROOT}/api/`)
  expect(prompt).toContain('- Add the limiter')
  expect(prompt).toContain('mcp__council__progress')
  expect(prompt).toContain('api/CLAUDE.md (this folder\'s rules):\nNever log request bodies.')
  expect(prompt).toContain('From Claude:\nDo the work.')

  // Its todos move it along; an edit outside its folder is refused.
  await $.tool.call({ tool: 'mcp__council__progress', agentId: 'agent-1', todos: [
    { content: 'Read the routes', status: 'completed', activeForm: 'Reading the routes' },
    { content: 'Add the limiter', status: 'in_progress', activeForm: 'Adding the limiter' },
    { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' },
  ] } as never)
  const outside = await $.tool.call({ tool: 'Edit', agentId: 'agent-1', file_path: `${ROOT}/web/a.ts`, old_string: 'a', new_string: 'b' } as never)
  expect((outside as { deny?: string }).deny).toContain('scoped to api/')
  const inside = await $.tool.call({ tool: 'Edit', agentId: 'agent-1', file_path: `${ROOT}/api/limits.ts`, old_string: 'a', new_string: 'b' } as never)
  expect((inside as { deny?: string }).deny).toBeUndefined()

  let pane = await mountPane($, 'terminal')
  expect(await pane.find({ text: /1\/3 · 1 edit$/ })).toBeDefined()
  expect(await pane.find({ text: /^Adding the limiter$/ })).toBeDefined()
  expect(await pane.find({ text: /♞/ })).toBeDefined()
  await pane.unmount()

  // Its last answer is its report.
  await $.turn.complete({ answer: 'Added a limiter to /charge; tests pass.', durationMs: 1, isAborted: false, turnId: 't', agentId: 'agent-1', reason: 'answer' } as never)
  pane = await mountPane($, 'terminal')
  expect(await pane.find({ text: /Back home · 1/ })).toBeDefined()
  // The report stays folded until its row is pressed, then shows in full.
  expect(await pane.find({ text: /Added a limiter/ })).toBeUndefined()
  await pane.press({ key: 'order-toggle-O1' })
  expect(await pane.find({ text: /^Added a limiter to \/charge; tests pass\.$/ })).toBeDefined()
  expect(await pane.find({ text: /✓/ })).toBeDefined()
  await pane.unmount()
})

test('court mode: changes wait for the council and enter with a hidden digest; questions pass; other agents are refused', async ($, on) => {
  const harness = courtStandIn(on, { verdict: system => (system.includes('Seneschal') ? 'CONCERN: 3\nVERDICT: Split it in two.\nDETAIL: Two concerns in one change.' : 'CONCERN: 1\nVERDICT: Fine.') })
  await start($)
  expect((await $.command.run(composer('council', 'court on'))).text).toContain('Court mode is on')

  const question = await $.prompt.submit({ text: 'What does the limiter do?', origin: { kind: 'composer' } } as never)
  expect((question as { context?: string[] }).context ?? []).toEqual([])
  expect(harness.completions.filter(call => call.system.includes('You are')).length).toBe(0)
  // Naming the council convenes everyone, and every verdict comes back.
  const asked = (await $.prompt.submit({ text: 'What does the council think of raiding Camelot?', origin: { kind: 'composer' } } as never)) as { context?: string[] }
  const askedDigest = (asked.context ?? []).join('\n')
  expect(askedDigest).toContain("The person asked for their council's view")
  expect(askedDigest).toContain('- The Castellan (1/5): Fine.')
  expect(askedDigest).toContain('- The Seneschal (3/5): Split it in two.')
  // Asking one member (as the triage reads it): only that member sits.
  harness.completions.length = 0
  const one = (await $.prompt.submit({ text: 'What does the Jester think of raiding Camelot?', origin: { kind: 'composer' } } as never)) as { context?: string[] }
  const oneDigest = (one.context ?? []).join('\n')
  expect(oneDigest).toContain('- The Court Jester (1/5): Fine.')
  expect(oneDigest).not.toContain('Castellan')
  expect(harness.completions.filter(call => call.system.includes('You are The')).length).toBe(1)
  harness.completions.length = 0
  expect(harness.completions.filter(call => call.system.includes('You are')).length).toBe(0)

  const change = (await $.prompt.submit({ text: 'Rate-limit the billing API', origin: { kind: 'composer' } } as never)) as { text?: string; drop?: string; context?: string[] }
  expect(change.drop).toBeUndefined()
  expect(change.text).toBe('Rate-limit the billing API')
  const digest = (change.context ?? []).join('\n')
  expect(digest).toContain('Weigh these concerns before acting:')
  expect(digest).toContain('- The Seneschal (3/5): Split it in two. Two concerns in one change.')
  expect(digest).not.toContain('Castellan')

  expect((await spawn($, 'general-purpose', 'look around')) as { deny?: string }).toMatchObject({ deny: expect.stringContaining('Court mode is on') })
  expect((await $.command.run(composer('council', 'court off'))).text).toContain('Court mode is off')
})

test('the court strip opens a verdict, and finished orders fold away at your next message', async ($, on) => {
  courtStandIn(on)
  await start($)
  await propose($, PLAN)
  await spawn($, 'council:scout', 'O2 web retries')
  await $.turn.complete({ answer: 'Found two retry loops.', durationMs: 1, isAborted: false, turnId: 't', agentId: 'agent-1', reason: 'answer' } as never)
  let pane = await mountPane($)
  await pane.press({ key: 'verdict-castellan' })
  expect(await pane.find({ text: /The Castellan · 2\/5 · Reasonable\./ })).toBeDefined()
  expect(await pane.find({ text: /Scout · web\// })).toBeDefined()
  await pane.unmount()
  // A turn of Claude's own doesn't fold it; your next message does.
  await $.turn.complete({ answer: 'Both are back.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  pane = await mountPane($)
  expect(await pane.find({ text: /Scout · web\// })).toBeDefined()
  await pane.unmount()
  await $.prompt.submit({ text: 'thanks', origin: { kind: 'composer' } } as never)
  pane = await mountPane($)
  expect(await pane.find({ text: /Scout · web\// })).toBeUndefined()
  expect(await pane.find({ text: /▸ Archived · 1/ })).toBeDefined()
  expect(await pane.find({ text: /Knight · api\// })).toBeDefined()
  await pane.press({ key: 'court-finished' })
  expect(await pane.find({ text: /Scout · web\// })).toBeDefined()
  await pane.unmount()
})

test('a council you convene opens to its chamber, even with orders in the court', async ($, on) => {
  courtStandIn(on)
  await start($)
  await propose($, PLAN)
  await $.command.run(composer('council', 'Should we raid Camelot?'))
  await settle()
  const pane = await mountPane($)
  expect(await pane.find({ text: /Should we raid Camelot\?/ })).toBeDefined()
  expect(await pane.find({ key: 'report' })).toBeDefined()
  await pane.press({ key: 'to-court' })
  expect(await pane.find({ text: /The Court/ })).toBeDefined()
  await pane.unmount()
})

test('Claude consults the council with options: it sits on the given context, and the tally comes back', async ($, on) => {
  const harness = courtStandIn(on, { verdict: system => (system.includes('Castellan') ? 'CONCERN: 2\nVERDICT: Self-signed is fine locally.\nDETAIL: Test only.\nCHOICE: 1' : 'CONCERN: 1\nVERDICT: Either works.\nCHOICE: 1') })
  await start($)
  const result = await $.tool.call({ tool: 'mcp__council__consult', question: 'Which TLS setup for the tests?', context: 'A Go service; only the TLS handshake code is under test.', options: ['A self-signed test cert', 'Wait for a real cert'] } as never)
  const text = String((result as { result?: unknown }).result)
  expect(text).toContain('The council on "Which TLS setup for the tests?":')
  expect(text).toContain('- The Castellan (concern 2/5): Self-signed is fine locally. Test only. Picks 1.')
  expect(text).toContain('Most favor option 1.')
  const advisorCall = harness.completions.find(call => call.system.includes('You are The Castellan'))!
  expect(advisorCall.prompt).toContain("THE HERALD'S BRIEF:\nA Go service; only the TLS handshake code is under test.")
  expect(advisorCall.prompt).toContain('OPTIONS:\n1. A self-signed test cert\n2. Wait for a real cert')
  // No fork: Claude wrote the brief.
  const pane = await mountPane($)
  expect(await pane.find({ text: /1\. A self-signed test cert/ })).toBeDefined()
  expect(await pane.find({ text: /picks 1/ })).toBeDefined()
  await pane.unmount()
  expect((await $.tool.call({ tool: 'mcp__council__consult', question: 'q' } as never)) as { result?: string }).toMatchObject({ result: expect.stringContaining("don't see this conversation") })
})

test('orders: on the road newest first, then back home, then the archive', async ($, on) => {
  courtStandIn(on)
  await start($)
  await propose($, PLAN)
  await propose($, { plan: 'More.', dispatches: [{ folder: 'infra', role: 'scout', task: 'Look.', todos: ['Look'] }] })
  await spawn($, 'council:knight', 'O1 api limits')
  await spawn($, 'council:scout', 'O2 web retries')
  await spawn($, 'council:scout', 'O3 infra look')
  await $.turn.complete({ answer: 'Two retry loops.', durationMs: 1, isAborted: false, turnId: 't', agentId: 'agent-2', reason: 'answer' } as never)
  const pane = await mountPane($)
  // Rows in drawing order: the newer scout before the older knight, the finished scout after both.
  const rows = (await pane.findAll({ type: 'Box' })).map(node => node.key).filter((key): key is string => typeof key === 'string' && key.startsWith('order-'))
  expect(rows).toEqual(['order-O3', 'order-O1', 'order-O2'])
  expect(await pane.find({ text: /On the road · 2/ })).toBeDefined()
  expect(await pane.find({ text: /Back home · 1/ })).toBeDefined()
  await pane.unmount()
})

test('the terminal animation never runs for a desktop chamber, and does for a terminal one', async ($, on) => {
  const harness = courtStandIn(on)
  const blits: string[] = []
  on('ui.blit', ($, e) => {
    blits.push(String((e as { id?: string }).id ?? 'blit'))
    return { value: { isDrawn: true } }
  })
  await start($)
  await $.command.run(composer('council', 'Ship it?'))
  await settle()
  let pane = await mountPane($, 'desktop')
  await pane.unmount()
  await harness.clock.advance(2000)
  expect(blits).toEqual([])
  pane = await mountPane($, 'terminal')
  await harness.clock.advance(2000)
  expect(blits.length).toBeGreaterThan(0)
  await pane.unmount()
})

test('a deep consult and a deep reconsider run on the brain trust model', async ($, on) => {
  const harness = courtStandIn(on)
  await start($)
  await $.tool.call({ tool: 'mcp__council__consult', question: 'Rewrite the parser?', context: 'A Go parser, 4k lines.', deep: true } as never)
  await settle()
  const advisorCalls = () => harness.completions.filter(call => call.system.includes('You are The'))
  expect(advisorCalls().length).toBe(5)
  expect(advisorCalls().every(call => call.model === 'opus')).toBe(true)
  let pane = await mountPane($)
  expect(await pane.find({ text: /The Brain Trust/ })).toBeDefined()
  await pane.unmount()

  // A plain council, reconsidered as a brain trust.
  await $.command.run(composer('council', 'Ship it?'))
  await settle()
  harness.completions.length = 0
  expect((await $.command.run(composer('council', 'deep reconsider It handles payments.'))).text).toContain('reconsiders')
  await settle()
  expect(advisorCalls().length).toBe(5)
  expect(advisorCalls().every(call => call.model === 'opus' && call.prompt.includes('It handles payments.'))).toBe(true)

  // The chamber's buttons fill the prompt.
  pane = await mountPane($)
  harness.draft.text = 'also the API'
  await pane.press({ key: 'reconsider-deep' })
  expect(harness.filled[harness.filled.length - 1]).toBe('/council deep reconsider also the API')
  await pane.press({ key: 'ask-deep' })
  expect(harness.filled[harness.filled.length - 1]).toBe('/council deep also the API')
  await pane.unmount()
})
