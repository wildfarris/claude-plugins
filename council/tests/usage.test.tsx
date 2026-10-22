// Usage: every council model call recorded through one helper, the
// session's model requests summed from turn.step by category (main, an
// order's dispatch with its level, the advisor, other subagents), the
// per-session file, its retention, a failed write that changes nothing, and
// /council usage's table on fixture files.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  DAY_MS,
  MAX_CALL_RECORDS,
  SHARE_HEADING,
  callRecord,
  costOf,
  dayOf,
  expiredUsageFiles,
  familyOf,
  foldCalls,
  formatUsageTable,
  parseSince,
  parseUsageFile,
  serializeUsage,
  sidekickRecords,
  tokensLabel,
  usageFileName,
  usageRows,
  withStepsAdded,
  type StepTotal,
  type UsageRecord,
} from '../hooks/usage'
import { baseStandIn, composer, settle, testPath } from './stand-in'

const ROOT = '/dev/work'
const HOME = '/home/me'
const NOW = Date.parse('2026-10-22T10:00:00.000Z')
const USAGE_DIR = `${HOME}/.claude/council/usage`
const MINE = `${USAGE_DIR}/session-1.jsonl`
const LEDGERS = `${HOME}/.claude/sidekick/ledgers`
const M = 1_000_000

const tokens = (input = 0, cacheRead = 0, cacheWrite = 0, output = 0) => ({ input, cacheRead, cacheWrite, output })
const step = (fields: Partial<StepTotal> & Pick<StepTotal, 'category' | 'model'>): StepTotal => ({ v: 1, at: NOW, day: '2026-10-20', requests: 1, session: 'sess-aaaa-1', ...tokens(), ...fields })
const call = (fields: Partial<UsageRecord> & Pick<UsageRecord, 'purpose' | 'model'>): UsageRecord => ({ v: 1, at: Date.parse('2026-10-20T12:00:00Z'), plugin: 'council', session: 'sess-aaaa-1', ...tokens(), ...fields })

// ── Pure: the record, the file, retention, prices ─────────────────────────

describe('the usage record', () => {
  test("a call record's shape: the version, time, plugin, purpose, model, effort, four counts and the session; ids only when there are some", () => {
    const usage = { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 30 }
    const record = callRecord({ at: NOW, plugin: 'council', purpose: 'member:castellan', model: 'sonnet', effort: 'low', session: 's1', usage })
    expect(record).toEqual({ v: 1, at: NOW, plugin: 'council', purpose: 'member:castellan', model: 'sonnet', effort: 'low', input: 120, cacheRead: 900, cacheWrite: 30, output: 40, session: 's1' })
    expect(Object.keys(record)).toEqual(['v', 'at', 'plugin', 'purpose', 'model', 'effort', 'input', 'cacheRead', 'cacheWrite', 'output', 'session'])
    const amend = callRecord({ at: NOW, plugin: 'council', purpose: 'amend', model: 'opus', session: 's1', usage: undefined, orderId: 'O3', level: 2 })
    expect(amend).toEqual({ v: 1, at: NOW, plugin: 'council', purpose: 'amend', model: 'opus', input: 0, cacheRead: 0, cacheWrite: 0, output: 0, session: 's1', orderId: 'O3', level: 2 })
    // Odd counts read as zero; nothing else is ever kept (no prompt, no text).
    expect(callRecord({ at: 1, plugin: 'council', purpose: 'triage', model: 'haiku', session: 's', usage: { input_tokens: -5, output_tokens: Number.NaN } as never })).toMatchObject({ input: 0, output: 0 })
  })

  test('the file round-trips call records and step totals, skipping torn or foreign lines', () => {
    const records = [call({ purpose: 'herald', model: 'opus', input: 5 })]
    const steps = [step({ category: 'dispatch', model: 'sonnet', orderId: 'O1', level: 2, role: 'knight', folder: 'api', output: 7 })]
    const text = serializeUsage(records, steps)
    expect(parseUsageFile(`${text}{"torn":\nnot json\n{"v":2,"at":1}\n`)).toEqual({ calls: records, steps })
    expect(serializeUsage([], [])).toBe('')
    expect(usageFileName('abc-123_x')).toBe('abc-123_x.jsonl')
    expect(usageFileName('../../etc/passwd')).toBe('______etc_passwd.jsonl')
  })

  test('step totals add up per day, category, order and model', () => {
    let totals = new Map<string, StepTotal>()
    const order = { category: 'dispatch' as const, orderId: 'O1', level: 3, role: 'knight', folder: 'api' }
    totals = withStepsAdded(totals, { day: '2026-10-22', at: 1, session: 's', category: 'dispatch', model: 'opus', tokens: tokens(1, 2, 3, 4), requests: 2, agent: order })
    totals = withStepsAdded(totals, { day: '2026-10-22', at: 2, session: 's', category: 'dispatch', model: 'opus', tokens: tokens(10, 20, 30, 40), requests: 1, agent: order })
    totals = withStepsAdded(totals, { day: '2026-10-22', at: 2, session: 's', category: 'main', model: 'opus', tokens: tokens(5, 0, 0, 5), requests: 1 })
    expect([...totals.values()]).toEqual([
      { v: 1, at: 2, day: '2026-10-22', category: 'dispatch', model: 'opus', orderId: 'O1', requests: 3, session: 's', input: 11, cacheRead: 22, cacheWrite: 33, output: 44, level: 3, role: 'knight', folder: 'api' },
      { v: 1, at: 2, day: '2026-10-22', category: 'main', model: 'opus', requests: 1, session: 's', input: 5, cacheRead: 0, cacheWrite: 0, output: 5 },
    ])
  })

  test('past the cap, the oldest call records fold into one per day, purpose and model, their counts summed', () => {
    const many = Array.from({ length: MAX_CALL_RECORDS + 10 }, (_, index) => call({ at: NOW + index, purpose: index % 2 === 0 ? 'member:hand' : 'triage', model: 'sonnet', input: 1, agentId: 'x' }))
    const folded = foldCalls(many)
    expect(folded.length).toBe(2 + MAX_CALL_RECORDS / 2)
    const [hand, triage] = folded
    expect(hand).toMatchObject({ purpose: 'member:hand', calls: (MAX_CALL_RECORDS + 10 - MAX_CALL_RECORDS / 2) / 2 })
    expect(hand!.input).toBe(hand!.calls)
    expect(hand).not.toHaveProperty('agentId')
    expect(triage!.purpose).toBe('triage')
    // No count is lost.
    expect(folded.reduce((sum, record) => sum + record.input, 0)).toBe(many.length)
  })

  test('retention: files past 60 days, never the current one, never anything but a usage file', () => {
    const old = NOW - 61 * DAY_MS
    const files = [
      { name: 'old.jsonl', mtimeMs: old, kind: 'file' },
      { name: 'recent.jsonl', mtimeMs: NOW - 59 * DAY_MS, kind: 'file' },
      { name: 'session-1.jsonl', mtimeMs: old, kind: 'file' },
      { name: 'notes.txt', mtimeMs: old, kind: 'file' },
      { name: 'a-folder.jsonl', mtimeMs: old, kind: 'dir' },
      { name: '../x.jsonl', mtimeMs: old, kind: 'file' },
    ]
    expect(expiredUsageFiles(files, 'session-1.jsonl', NOW)).toEqual(['old.jsonl'])
  })

  test('prices by family: opus 5/25, sonnet 3/15, haiku 1/5 per million, cache reads 0.1×, writes 1.25× input; others as opus', () => {
    expect(costOf(tokens(M, 0, 0, 0), 'claude-opus-5-5')).toBe(5)
    expect(costOf(tokens(0, 0, 0, M), 'opus')).toBe(25)
    expect(Math.round(costOf(tokens(0, M, 0, 0), 'opus') * 1000) / 1000).toBe(0.5)
    expect(Math.round(costOf(tokens(0, 0, M, 0), 'opus') * 1000) / 1000).toBe(6.25)
    expect(costOf(tokens(M, 0, 0, M), 'claude-sonnet-5')).toBe(18)
    expect(costOf(tokens(M, 0, 0, M), 'haiku')).toBe(6)
    expect(familyOf('fable')).toBe('opus')
    expect(tokensLabel(undefined)).toBe('')
    expect(tokensLabel(tokens(1_200_000, 0, 0, 34_000))).toBe('1.2M tok')
  })

  test('the span: the last 7 days by default, or since a day; anything else is refused', () => {
    const week = parseSince('', NOW)
    expect(week).toMatchObject({ day: dayOf(NOW - 6 * DAY_MS) })
    expect((week as { label: string }).label).toContain('the last 7 days')
    expect(parseSince('since 2026-10-01', NOW)).toMatchObject({ day: '2026-10-01', label: 'since 2026-10-01' })
    expect(parseSince('2026-10-01', NOW)).toMatchObject({ day: '2026-10-01' })
    for (const bad of ['since', 'since 2026-13-01', 'since 2026-02-30', 'yesterday', 'since 2026-10-01 extra']) expect(parseSince(bad, NOW)).toHaveProperty('error')
  })
})

// The fixture: 31.5 price units in all. Main 5, dispatches 16 (level 1: 1,
// level 2: 15), advisors 0.5, other 5, the council's calls 4 (votes 3, triage
// 1), sidekick 1 (the judge).
const FIXTURE_STEPS = [
  step({ category: 'main', model: 'claude-opus-5-5', input: M }),
  step({ category: 'dispatch', model: 'claude-sonnet-5', output: M, orderId: 'O1', level: 2, role: 'knight', folder: 'api' }),
  step({ category: 'dispatch', model: 'haiku', input: M, orderId: 'O2', level: 1, role: 'scout', folder: 'web', session: 'sess-bbbb-2' }),
  step({ category: 'advisor', model: 'opus', cacheRead: M }),
  step({ category: 'other', model: 'haiku', output: M }),
  // Before the span: left out.
  step({ category: 'main', model: 'opus', input: 50 * M, day: '2026-10-01' }),
]
const FIXTURE_CALLS = [
  call({ purpose: 'member:castellan', model: 'sonnet', input: M / 2 }),
  call({ purpose: 'member:hand', model: 'sonnet', input: M / 2 }),
  call({ purpose: 'triage', model: 'haiku', input: M }),
  call({ purpose: 'herald', model: 'opus', input: 9 * M, at: Date.parse('2026-10-01T12:00:00Z') }),
]
const FIXTURE_SIDEKICK = [{ ...call({ purpose: 'judge', model: 'haiku', input: M }), plugin: 'sidekick' as const }]
const SINCE = { sinceDay: '2026-10-15', since: Date.parse('2026-10-15T12:00:00Z'), now: NOW }

describe('the report', () => {
  test('rows: main, dispatches by level then the top orders, advisors, other subagents, the council by purpose, sidekick by purpose', () => {
    const rows = usageRows({ steps: FIXTURE_STEPS, calls: FIXTURE_CALLS, sidekick: FIXTURE_SIDEKICK, ...SINCE })
    expect(rows.map(row => [row.depth, row.label, Math.round(row.cost * 10) / 10])).toEqual([
      [0, 'Main sessions', 5],
      [0, 'Dispatches', 16],
      [1, 'level 1', 1],
      [1, 'level 2', 15],
      [1, 'O1 knight api · sess-aaa', 15],
      [1, 'O2 scout web · sess-bbb', 1],
      [0, 'Advisors (council:advisor)', 0.5],
      [0, 'Other subagents', 5],
      [0, "Council members' calls", 4],
      [1, 'member votes', 3],
      [1, 'triage', 1],
      [0, 'Sidekick', 1],
      [1, 'judge', 1],
    ])
    expect(rows[0]!.tokens).toEqual(tokens(M, 0, 0, 0))
  })

  test('the table: tokens, output and the approximate price-weighted share of the whole', () => {
    const table = formatUsageTable(usageRows({ steps: FIXTURE_STEPS, calls: FIXTURE_CALLS, sidekick: FIXTURE_SIDEKICK, ...SINCE })).split('\n')
    expect(table[0]).toContain('tokens')
    expect(table[0]).toContain('output')
    expect(table[0]).toContain(SHARE_HEADING)
    const line = (label: string) => table.find(row => row.trimStart().startsWith(label))!.replace(/\s+/g, ' ').trim()
    expect(line('Main sessions')).toBe('Main sessions 1.0M 0 16%')
    expect(line('Dispatches')).toBe('Dispatches 2.0M 1.0M 51%')
    expect(line('level 2')).toBe('level 2 1.0M 1.0M 48%')
    expect(line('Advisors')).toBe('Advisors (council:advisor) 1.0M 0 2%')
    expect(line('Other subagents')).toBe('Other subagents 1.0M 1.0M 16%')
    expect(line("Council members' calls")).toBe("Council members' calls 2.0M 0 13%")
    expect(line('Sidekick')).toBe('Sidekick 1.0M 0 3%')
  })

  test("sidekick's rows say not recorded when it left no records; a span past its 14 days says so", () => {
    const missing = formatUsageTable(usageRows({ steps: [], calls: [], sidekick: null, ...SINCE }))
    expect(missing).toMatch(/Sidekick\s+not recorded/)
    const long = formatUsageTable(usageRows({ steps: FIXTURE_STEPS, calls: [], sidekick: FIXTURE_SIDEKICK, sinceDay: '2026-09-01', since: Date.parse('2026-09-01T00:00:00Z'), now: NOW }))
    expect(long).toContain("(its ledgers keep 14 days)")
  })

  test("sidekick's records are read loosely from its ledger lines", () => {
    const ledger = [
      JSON.stringify({ kind: 'prompt', at: 1, turnId: 't', text: 'say "kind":"model" here' }),
      JSON.stringify({ kind: 'model', v: 1, at: 5, plugin: 'sidekick', purpose: 'judge', model: 'haiku', input: 3, cacheRead: 0, cacheWrite: 0, output: 1, session: 's' }),
      '{"kind":"model", torn',
      JSON.stringify({ kind: 'model', at: 6, purpose: 'tldr' }),
    ].join('\n')
    expect(sidekickRecords(ledger)).toEqual([{ kind: 'model', v: 1, at: 5, plugin: 'sidekick', purpose: 'judge', model: 'haiku', input: 3, cacheRead: 0, cacheWrite: 0, output: 1, session: 's' } as never])
  })
})

// ── Through the hooks ─────────────────────────────────────────────────────

type Spawn = { subagentType: string; description: string; prompt: string; model?: string; resume?: { agentId: string } }
const OPUS = (input: number, output = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' })
const SONNET = (input: number, output = 0) => ({ ...OPUS(input, output), model: 'claude-sonnet-5' })

function standIn(
  on: On,
  options: { verdict?: (system: string, prompt: string) => string; files?: Map<string, string>; mtimes?: Map<string, number>; failWrite?: (path: string) => boolean; stepUsage?: (agentId: string | undefined) => unknown; env?: Record<string, string> } = {},
) {
  const files = options.files ?? new Map<string, string>()
  const mtimes = options.mtimes ?? new Map<string, number>()
  const ran: string[][] = []
  const spawned: Spawn[] = []
  const forks: string[] = []
  const harness = baseStandIn(on, {
    root: ROOT,
    complete: ({ system, prompt }) =>
      system.includes('You sort a person')
        ? 'COUNCIL'
        : system.includes('CONDITIONS TO REVIEW')
          ? JSON.stringify({ decisions: [{ index: 1, keep: true, reason: 'Fine.' }] })
          : (options.verdict?.(system, prompt) ?? 'CONCERN: 2\nVERDICT: Reasonable.\nDETAIL: Scoped well.'),
  })
  mock.env(on, options.env ?? { HOME })
  const logs: string[] = []
  on('ui.log', ($, e) => {
    logs.push(String(e.text))
    return { value: undefined }
  })
  const children = (folder: string) => {
    const prefix = `${folder}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue
      const [name, ...rest] = path.slice(prefix.length).split('/')
      names.set(name!, rest.length > 0 ? 'dir' : 'file')
    }
    return names
  }
  on('fs.stat', ($, e) => {
    const path = testPath(e.path)
    if (['api', 'web'].some(folder => path === `${ROOT}/${folder}`) || children(path).size > 0) return { value: { kind: 'dir', size: 0, mtimeMs: NOW, isLink: false, realPath: path } }
    if (files.has(path)) return { value: { kind: 'file', size: files.get(path)!.length, mtimeMs: mtimes.get(path) ?? NOW, isLink: false, realPath: path } }
    return { deny: 'no such file' }
  })
  on('fs.exists', ($, e) => ({ value: files.has(testPath(e.path)) || children(testPath(e.path)).size > 0 }))
  on('fs.read', ($, e) => (files.has(testPath(e.path)) ? { value: files.get(testPath(e.path))! } : { deny: 'no such file' }))
  on('fs.write', ($, e) => {
    const path = testPath(e.path)
    if (options.failWrite?.(path)) return { deny: 'the disk is full' }
    files.set(path, e.text)
    mtimes.set(path, NOW)
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const folder = testPath(e.path)
    const names = children(folder)
    if (names.size === 0) return { deny: 'no such directory' }
    return {
      value: [...names].map(([name, kind]) => {
        const path = `${folder}/${name}`
        const newest = kind === 'dir' ? Math.max(...[...files.keys()].filter(file => file.startsWith(`${path}/`)).map(file => mtimes.get(file) ?? NOW)) : (mtimes.get(path) ?? NOW)
        return { name, kind, size: kind === 'file' ? files.get(path)!.length : 0, mtimeMs: newest, isLink: false }
      }),
    }
  })
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    // rm -rf -- <path>: gone.
    if (e.argv[0] === 'rm') files.delete(testPath(String(e.argv[3])))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.fork', () => {
    forks.push('fork')
    return { value: { isAnswered: true, text: 'The person wants a decision.', usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 } } }
  })
  on('agent.spawn', ($, e) => {
    const input = e as unknown as Spawn
    const subagentType = input.subagentType ?? (input as unknown as { subagent_type: string }).subagent_type
    spawned.push({ ...input, subagentType })
    return { model: input.model ?? 'inherit', agentId: input.resume?.agentId ?? `agent-${spawned.length}` }
  })
  on('agent.list', () => ({ value: spawned.map((_, index) => ({ id: `agent-${index + 1}`, status: 'running', description: '', type: 'x' })) }) as never)
  on('session.send', () => ({ isDelivered: true }))
  // Beneath: one text chunk, then the stop with the request's usage.
  on('turn.step', async function* ($, e) {
    const usage = (options.stepUsage?.(e.agentId) ?? null) as never
    yield { kind: 'text' as const, index: 0, text: 'hello' }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
    return { turnId: e.turnId, index: e.index, answer: 'hello', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  return Object.assign(harness, { files, mtimes, ran, spawned, forks, logs })
}

const start = async ($: Engine, harness: { clock: { set: (ms: number) => Promise<void> } }) => {
  await harness.clock.set(NOW)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
}
const run = async ($: Engine, args: string) => String((await $.command.run(composer('council', args))).text)
const text = (result: unknown) => String((result as { result?: unknown }).result ?? (result as { deny?: unknown }).deny)
const consult = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__council__consult', ...input } as never)
const propose = ($: Engine, plan: string, dispatches: Array<Record<string, unknown>>) =>
  $.tool.call({ tool: 'mcp__council__propose_orders', plan, dispatches: dispatches.map(dispatch => ({ task: `Work in ${String(dispatch.folder)}.`, todos: ['Do it'], ...dispatch })) } as never)
const finish = ($: Engine, agentId: string, answer: string, turnId = 't', usage?: unknown) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId, agentId, reason: 'answer', ...(usage ? { usage } : {}) } as never)
const stepThrough = async ($: Engine, agentId: string | undefined, turnId = 't') => {
  const chunks: unknown[] = []
  const stream = $.turn.step({ turnId, index: 0, model: 'opus', messageCount: 1, ...(agentId ? { agentId } : {}) } as never) as AsyncGenerator<unknown, unknown>
  let next = await stream.next()
  while (!next.done) {
    chunks.push(next.value)
    next = await stream.next()
  }
  return { chunks, result: next.value }
}
const endMainTurn = ($: Engine, turnId = 'main') => $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as never)
const recorded = (files: Map<string, string>, path = MINE) => parseUsageFile(files.get(path) ?? '')
const until = async (harness: { clock: { advance: (ms: number) => Promise<void> } }, isDone: () => boolean, tries = 80) => {
  for (let attempt = 0; attempt < tries && !isDone(); attempt++) {
    await harness.clock.advance(50)
    await settle()
  }
}

test('every model call the council makes is recorded through its helper, each with its purpose', { options: { arbiter: 'jester' } }, async ($, on) => {
  const harness = standIn(on, {
    verdict: (system, prompt) =>
      prompt.includes('ITS FINDINGS')
        ? 'CONCERN: 1\nVERDICT: Checked and fine.\nLEVEL 1: 1'
        : prompt.includes('held') || system.includes('You are The Castellan')
          ? prompt.includes('Is a key committed') || prompt.includes('KEY CHECK')
            ? 'CONCERN: 3\nVERDICT: Is a key committed?\nDETAIL: Unclear.\nCHECK: Is an API key committed in api/?'
            : 'CONCERN: 3\nVERDICT: Mind the keys.\nDETAIL: Rotate them.'
          : 'CONCERN: 1\nVERDICT: Fine.',
  })
  await start($, harness)
  const made = () => harness.completions.length + harness.forks.length
  const calls = () => recorded(harness.files).calls

  // A consult (five votes), a council (the herald's fork and five votes), its report and a follow-up.
  expect(text(await consult($, { question: 'Ship it?', context: 'All tests pass.' }))).toContain('The council on "Ship it?"')
  expect(await run($, 'Should we cache the reports?')).toContain('convenes')
  await until(harness, () => calls().length >= 11)
  await run($, 'report')
  await run($, 'ask hand why?')
  await run($, 'reconsider The cache is shared.')
  // A ruling on orders, its arbiter, and an amendment once the order is under way.
  expect(text(await propose($, 'Rate-limit the API.', [{ folder: 'api', role: 'knight' }]))).toContain('The council approved the plan')
  expect(((await $.agent.spawn({ subagentType: 'council:knight', description: 'O1 api limits', prompt: 'Do it.' } as never)) as { agentId?: string }).agentId).toBe('agent-1')
  expect(text(await $.tool.call({ tool: 'mcp__council__amend_order', id: 'O1', change: 'Also add tests.', reason: 'Coverage.' } as never))).toContain('council')
  // Court mode: the triage, then the herald and the votes.
  await run($, 'court on')
  await $.prompt.submit({ text: 'Rate-limit the billing API', origin: { kind: 'composer' } } as never)
  await until(harness, () => calls().length === made() && made() > 30)

  // As many records as calls the engine answered: none bypassed the helper.
  expect(calls().length).toBe(made())
  const purposes = new Set(calls().map(record => record.purpose.replace(/^member:.*/, 'member')))
  expect([...purposes].sort()).toEqual(['amend', 'arbiter', 'herald', 'member', 'report', 'triage'])
  expect(calls().filter(record => record.purpose === 'herald').length).toBe(harness.forks.length)
  // A fork's record has its usage and the main model it ran on (none seen yet: so named).
  expect(calls().find(record => record.purpose === 'herald')).toMatchObject({ plugin: 'council', model: 'main model', input: 7, output: 3, cacheRead: 2000, session: 'session-1' })
  expect(calls().find(record => record.purpose === 'member:castellan')).toMatchObject({ model: 'sonnet', effort: 'low', input: 10, output: 5 })
  expect(calls().find(record => record.purpose === 'amend')).toMatchObject({ orderId: 'O1', level: 2 })
  // Only purposes and counts: no prompt or answer text is kept.
  expect(harness.files.get(MINE)).not.toContain('Rate-limit')
  expect(harness.files.get(MINE)).not.toContain('Mind the keys')
})

test('the brief, guidance-free summons second round: a held ruling records its round two', async ($, on) => {
  const harness = standIn(on, {
    verdict: (system, prompt) =>
      prompt.includes('ITS FINDINGS') ? 'CONCERN: 1\nVERDICT: Checked and fine.\nLEVEL 1: 1' : system.includes('You are The Castellan') ? 'CONCERN: 3\nVERDICT: Is a key committed?\nDETAIL: Unclear.\nCHECK: Is an API key committed in api/?' : 'CONCERN: 1\nVERDICT: Fine.',
  })
  await start($, harness)
  expect(text(await propose($, 'Rate-limit the API.', [{ folder: 'api', role: 'knight' }]))).toContain('The council holds O1')
  await until(harness, () => harness.spawned.length === 1)
  await finish($, 'agent-1', 'No key is committed.')
  await until(harness, () => recorded(harness.files).calls.filter(record => record.purpose === 'summons-round2').length === 5)
  expect(recorded(harness.files).calls.length).toBe(harness.completions.length)
})

test('turn.step: each request summed into main, its order (with the level), the advisor or other; the stream passes through unchanged', async ($, on) => {
  const harness = standIn(on, { stepUsage: agentId => (agentId === undefined ? OPUS(100, 10) : agentId === 'agent-1' ? SONNET(200, 20) : agentId === 'agent-2' ? OPUS(300, 30) : SONNET(1, 1)) })
  await start($, harness)
  expect(text(await propose($, 'Rate-limit the API.', [{ folder: 'api', role: 'knight' }]))).toContain('The council approved the plan')
  expect(((await $.agent.spawn({ subagentType: 'council:knight', description: 'O1 api limits', prompt: 'Do it.' } as never)) as { agentId?: string }).agentId).toBe('agent-1')
  expect(await run($, 'advise web where does the client retry?')).toContain('A1')
  await until(harness, () => harness.spawned.length === 2)

  // The stream above is the stream beneath: the same chunks, the same result.
  const main = await stepThrough($, undefined, 'm1')
  expect(main.chunks).toEqual([{ kind: 'text', index: 0, text: 'hello' }, { kind: 'stop', stopReason: 'end_turn', usage: OPUS(100, 10) }])
  expect(main.result).toMatchObject({ answer: 'hello', usage: OPUS(100, 10) })
  await stepThrough($, undefined, 'm1')
  await stepThrough($, 'agent-1', 'k1')
  await stepThrough($, 'agent-1', 'k1')
  await stepThrough($, 'agent-1', 'k1')
  await stepThrough($, 'agent-2', 'a1')
  await stepThrough($, 'agent-9', 'x1')
  // A turn whose steps the hook never saw counts from its own usage; a seen one is not counted twice.
  await finish($, 'agent-2', 'Retries are in web/src/http.ts.', 'a2', OPUS(1000, 100))
  await finish($, 'agent-9', 'Done.', 'x1', SONNET(5000, 500))
  // No request is written before the main turn ends (or 25 requests).
  await until(harness, () => false, 5)
  expect(recorded(harness.files).steps).toEqual([])
  await endMainTurn($, 'm1')
  await until(harness, () => recorded(harness.files).steps.length === 4)

  const steps = recorded(harness.files).steps
  const of = (category: string) => steps.find(total => total.category === category)!
  expect(of('main')).toMatchObject({ model: 'claude-opus-5-5', requests: 2, input: 200, output: 20, session: 'session-1', day: dayOf(NOW) })
  expect(of('dispatch')).toMatchObject({ model: 'claude-sonnet-5', requests: 3, input: 600, output: 60, orderId: 'O1', level: 2, role: 'knight', folder: 'api' })
  expect(of('advisor')).toMatchObject({ model: 'claude-opus-5-5', requests: 2, input: 1300, output: 130 })
  expect(of('other')).toMatchObject({ model: 'claude-sonnet-5', requests: 1, input: 1, output: 1 })
  // The order carries its totals, and the court shows them on its row.
  await settle()
  const pane = await $.ui.mount({ plugin: 'council', surface: 'desktop', component: 'Pane', requestId: 'council-chamber', props: { title: 'The Council', isFocused: false, bodyColumns: 100, bodyRows: 40 } })
  expect(await pane.find({ text: /660 tok/ })).toBeDefined()
  await pane.unmount()

  // More requests add to the same lines; the file is read back after a reload.
  await stepThrough($, undefined, 'm2')
  await endMainTurn($, 'm2')
  await until(harness, () => of('main').requests === 3 || recorded(harness.files).steps.find(total => total.category === 'main')!.requests === 3)
  expect(recorded(harness.files).steps.find(total => total.category === 'main')).toMatchObject({ requests: 3, input: 300 })
})

test('a failed write never breaks a call or a request: the answer stands, and the failure is toasted once', async ($, on) => {
  const harness = standIn(on, { failWrite: path => path.startsWith(USAGE_DIR), stepUsage: () => OPUS(5, 5) })
  await start($, harness)
  expect(text(await consult($, { question: 'Ship it?', context: 'All tests pass.' }))).toContain('The council on "Ship it?"')
  await until(harness, () => harness.toasts.some(toast => toast.includes('usage could not be recorded')))
  expect(text(await consult($, { question: 'Ship it now?', context: 'Still passing.' }))).toContain('The council on "Ship it now?"')
  const stepped = await stepThrough($, undefined, 'm1')
  expect(stepped.result).toMatchObject({ answer: 'hello' })
  await endMainTurn($, 'm1')
  await until(harness, () => false, 10)
  expect(harness.toasts.filter(toast => toast.includes('usage could not be recorded')).length).toBe(1)
  expect(harness.toasts.find(toast => toast.includes('usage could not be recorded'))).toContain('nothing else is affected')
})

test('with no home folder nothing is recorded, silently', async ($, on) => {
  const harness = standIn(on, { env: {} })
  await start($, harness)
  expect(text(await consult($, { question: 'Ship it?', context: 'All tests pass.' }))).toContain('The council on "Ship it?"')
  await until(harness, () => false, 5)
  expect([...harness.files.keys()].some(path => path.startsWith(USAGE_DIR))).toBe(false)
  expect(harness.toasts.some(toast => toast.includes('usage'))).toBe(false)
})

test("retention: the first write deletes other sessions' files past 60 days, and only those, in the usage folder", async ($, on) => {
  const files = new Map([
    [`${USAGE_DIR}/old-session.jsonl`, '\n'],
    [`${USAGE_DIR}/recent-session.jsonl`, '\n'],
    [`${USAGE_DIR}/notes.txt`, 'mine'],
  ])
  const mtimes = new Map([
    [`${USAGE_DIR}/old-session.jsonl`, NOW - 61 * DAY_MS],
    [`${USAGE_DIR}/recent-session.jsonl`, NOW - 10 * DAY_MS],
    [`${USAGE_DIR}/notes.txt`, NOW - 400 * DAY_MS],
  ])
  const harness = standIn(on, { files, mtimes })
  await start($, harness)
  await consult($, { question: 'Ship it?', context: 'All tests pass.' })
  const removals = () => harness.ran.filter(argv => argv[0] === 'rm' || argv[0] === 'powershell.exe').map(argv => argv.join(' '))
  await until(harness, () => removals().length > 0 && harness.files.has(MINE))
  await until(harness, () => false, 5)
  const deletes = removals()
  expect([deletes, harness.logs]).toEqual([[`rm -rf -- ${USAGE_DIR}/old-session.jsonl`], []])
  expect(deletes[0]).toContain('old-session.jsonl')
  expect(deletes.some(line => line.includes('recent-session') || line.includes('notes.txt') || line.includes('session-1.jsonl'))).toBe(false)
  // Once a session.
  await consult($, { question: 'Again?', context: 'Yes.' })
  await until(harness, () => false, 5)
  expect(removals().length).toBe(1)
})

test('/council usage: one table from every session file and sidekick\'s ledgers, with the coverage note; "usage of X?" is still a question', async ($, on) => {
  const files = new Map([
    [`${USAGE_DIR}/sess-aaaa-1.jsonl`, serializeUsage(FIXTURE_CALLS, FIXTURE_STEPS.filter(total => total.session === 'sess-aaaa-1'))],
    [`${USAGE_DIR}/sess-bbbb-2.jsonl`, serializeUsage([], FIXTURE_STEPS.filter(total => total.session === 'sess-bbbb-2'))],
    [`${LEDGERS}/sess-aaaa-1/000000.jsonl`, [JSON.stringify({ kind: 'prompt', at: 1, turnId: 't', text: 'hi' }), JSON.stringify({ kind: 'model', ...FIXTURE_SIDEKICK[0] })].join('\n')],
  ])
  const harness = standIn(on, { files })
  await start($, harness)
  const report = await run($, 'usage since 2026-10-15')
  expect(report.split('\n')[0]).toBe('Usage, since 2026-10-15:')
  const line = (label: string) => report.split('\n').find(row => row.trimStart().startsWith(label))!.replace(/\s+/g, ' ').trim()
  expect(line('Main sessions')).toBe('Main sessions 1.0M 0 16%')
  expect(line('Dispatches')).toBe('Dispatches 2.0M 1.0M 51%')
  expect(line('O1 knight api')).toBe('O1 knight api · sess-aaa 1.0M 1.0M 48%')
  expect(line('Sidekick')).toBe('Sidekick 1.0M 0 3%')
  expect(line('judge')).toBe('judge 1.0M 0 3%')
  expect(report).toContain(SHARE_HEADING)
  expect(report).toContain('only sessions on this machine where the council plugin was loaded, from council 0.4.0 on')
  expect(harness.completions.length).toBe(0)

  // The default span is the last 7 days.
  expect((await run($, 'usage')).split('\n')[0]).toContain('the last 7 days')
  expect(await run($, 'usage since 2026-13-40')).toContain('Usage: /council usage [since YYYY-MM-DD]')
  // Not a subcommand: a question for the council.
  expect(await run($, 'usage of the API: should we meter it?')).toContain('convenes')
})

test('with no sidekick ledgers, its row says not recorded', async ($, on) => {
  const harness = standIn(on, { files: new Map([[`${USAGE_DIR}/sess-aaaa-1.jsonl`, serializeUsage([], FIXTURE_STEPS.slice(0, 1))]]) })
  await start($, harness)
  expect(await run($, 'usage since 2026-10-15')).toMatch(/\nSidekick\s+not recorded/)
})
