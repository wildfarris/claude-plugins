// The docket: every sitting recorded per project, redacted and capped, kept
// by count and age, written in turn by sessions sharing a project, and shown
// in the pane's docket view.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { DocketEntry, DocketKind } from '../types'
import {
  DAY_MS,
  DOCKET_LIMITS,
  dayFileName,
  docketEntries,
  docketFile,
  docketPage,
  docketPaths,
  formatEntry,
  formatLock,
  isSafeKey,
  offsetOf,
  parseDocket,
  projectKey,
  prunedFiles,
  sealEntry,
  withEntryAppended,
} from '../hooks/docket'
import { REDACTED, redactSecrets } from '../hooks/redact'
import { baseStandIn, composer, settle, testPath } from './stand-in'

const ROOT = '/dev/work'
const HOME = '/home/me'
const NOW = Date.parse('2026-10-22T10:00:00.000Z')
const DOCKET = `${HOME}/.claude/council/docket`
const FOLDER = `${DOCKET}/${projectKey(ROOT)}`
const TODAY = `${FOLDER}/${dayFileName(NOW)}`
const LOCK = `${FOLDER}/lock`
const PANE = { title: 'The Council', isFocused: false, bodyColumns: 100, bodyRows: 40 }
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const DIRS = ['api', 'web']

const entry = (index: number, kind: DocketKind, extra: Partial<DocketEntry> = {}): DocketEntry => ({
  v: 1,
  id: `e${String(index).padStart(2, '0')}`,
  time: new Date(NOW - index * 60_000).toISOString(),
  kind,
  session: 'other-session',
  project: ROOT,
  outcome: 'approved',
  ...extra,
})

// ── Pure: where it lives, redaction, reading and retention ────────────────

describe('where the docket lives', () => {
  test('a project key is a slug and a short hash, with nothing that could leave the docket folder', () => {
    for (const root of ['/dev/work', '/x/../../etc/passwd', 'C:\\Users\\me\\..\\..\\Windows', '../../..', '/', '', 'C:\\claude\\workspace', '/srv/ünïcode/プロジェクト']) {
      const key = projectKey(root)
      expect(isSafeKey(key)).toBe(true)
      expect(key).toMatch(/^[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/)
      expect(key.includes('..') || key.includes('/') || key.includes('\\')).toBe(false)
    }
    expect(projectKey('C:\\claude\\workspace')).toMatch(/^c-claude-workspace-[0-9a-f]{8}$/)
    // Windows roots are caseless; POSIX ones are not; one slug from two roots still differs by its hash.
    expect(projectKey('C:\\Work\\App')).toBe(projectKey('c:/work/app/'))
    expect(projectKey('/dev/Work')).not.toBe(projectKey('/dev/work'))
    expect(projectKey('/a/b-c')).not.toBe(projectKey('/a-b/c'))
  })

  test('a key with a separator, `..` or anything unsafe is refused, and so is any file but a day file', () => {
    for (const key of ['../evil', 'a/b', 'a\\b', '..', '', 'Work-1', '-x', 'a'.repeat(65)]) expect(docketPaths(HOME, key)).toBeUndefined()
    expect(docketPaths('', 'work-1234abcd')).toBeUndefined()
    const paths = docketPaths(HOME, 'work-1234abcd')!
    expect(paths.folder).toBe(`${DOCKET}/work-1234abcd`)
    expect(paths.lock).toBe(`${DOCKET}/work-1234abcd/lock`)
    expect(docketFile(paths, '10-22.jsonl')).toBe(`${DOCKET}/work-1234abcd/10-22.jsonl`)
    for (const name of ['../10-22.jsonl', '10-22.jsonl/../../x', '13-01.jsonl', '02-32.jsonl', 'lock', 'notes.txt', '..']) expect(docketFile(paths, name)).toBeUndefined()
    expect(docketPaths('C:\\Users\\me', 'work-1234abcd')?.folder).toBe('C:\\Users\\me/.claude/council/docket/work-1234abcd')
  })
})

describe('redaction and caps', () => {
  test('token-like strings are redacted; ordinary text is not', () => {
    const secrets = [
      'sk-abcdefghijklmnopqrstuvwxyz123456',
      `ghp_${'a1B2'.repeat(9)}`,
      'xoxb-1234567890-abcdefghijkl',
      'AKIAABCDEFGHIJKLMNOP',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
      'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODkw',
    ]
    for (const secret of secrets) {
      const redacted = redactSecrets(`use ${secret} here`)
      expect(redacted).not.toContain(secret)
      expect(redacted).toContain(REDACTED)
    }
    expect(redactSecrets('login with password=hunter2xyz and token=abcdef123456')).toBe(`login with password=${REDACTED} and token=${REDACTED}`)
    const plain = 'Rate-limit the billing API in api/routes.ts, then run the tests (about 20 minutes).'
    expect(redactSecrets(plain)).toBe(plain)
  })

  test('an entry is sealed: every text redacted, the question and plan cut at 4,000 characters, each detail at 600', () => {
    const sealed = sealEntry(
      entry(0, 'orders', {
        question: 'q'.repeat(5000),
        plan: `Deploy with token=supersecret99 ${'p'.repeat(5000)}`,
        votes: [{ id: 'castellan', title: 'The Castellan', status: 'done', concern: 3, verdict: 'Rotate sk-abcdefghijklmnopqrstuvwxyz1234', detail: `password=hunter2xyz ${'w'.repeat(1000)}`, check: 'Is AKIAABCDEFGHIJKLMNOP live?' }],
        conditions: ['The Castellan: drop ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
        findings: 'Found xoxb-1234567890-abcdefghijkl in .env',
      }),
    )
    expect(sealed.question!.length).toBe(DOCKET_LIMITS.question)
    expect(sealed.question!.endsWith('…')).toBe(true)
    expect(sealed.plan!.length).toBe(DOCKET_LIMITS.plan)
    expect(sealed.plan).toContain(`token=${REDACTED}`)
    const vote = sealed.votes![0]!
    expect(vote.detail.length).toBe(DOCKET_LIMITS.detail)
    expect(vote.detail).toContain(`password=${REDACTED}`)
    expect(vote.verdict).toBe(`Rotate ${REDACTED}`)
    expect(vote.check).toBe(`Is ${REDACTED} live?`)
    expect(sealed.conditions![0]).toBe(`The Castellan: drop ${REDACTED}`)
    expect(sealed.findings).toBe(`Found ${REDACTED} in .env`)
    // One line of JSON, whatever the text holds.
    expect(formatEntry(sealEntry(entry(1, 'consult', { question: 'two\nlines' }))).includes('\n')).toBe(false)
  })
})

describe('reading and retention', () => {
  test('a corrupt line or one of another version is skipped, not fatal; odd lists are dropped', () => {
    const text = [
      formatEntry(entry(1, 'consult')),
      '{"v":1,"id":"half',
      JSON.stringify({ ...entry(2, 'orders'), v: 2 }),
      'not json at all',
      '',
      JSON.stringify({ ...entry(3, 'recall'), votes: 'x', conditions: [1, 'kept'] }),
      JSON.stringify({ ...entry(4, 'consult'), kind: 'unknown' }),
    ].join('\n')
    const parsed = parseDocket(text)
    expect(parsed.map(item => item.id)).toEqual(['e01', 'e03'])
    expect(parsed[1]!.votes).toBeUndefined()
    expect(parsed[1]!.conditions).toEqual(['kept'])
  })

  test("appending keeps the day's lines and drops a year-old day of the same name and corrupt lines", () => {
    const lastYear = { ...entry(0, 'consult'), id: 'old', time: new Date(NOW - 365 * DAY_MS).toISOString() }
    const today = entry(5, 'council')
    const text = withEntryAppended([formatEntry(lastYear), formatEntry(today), '{broken'].join('\n'), entry(0, 'orders'))
    expect(parseDocket(text).map(item => item.id)).toEqual(['e05', 'e00'])
    expect(text.endsWith('\n')).toBe(true)
  })

  test('pruning drops lines older than 180 days and keeps the newest 2,000; an emptied file is left empty', () => {
    const old = (index: number) => ({ ...entry(index, 'consult'), time: new Date(NOW - 200 * DAY_MS - index).toISOString() })
    const files = [
      { name: '01-01.jsonl', text: `${formatEntry(old(1))}\n${formatEntry(old(2))}\n` },
      { name: '10-12.jsonl', text: `${formatEntry(old(3))}\n${formatEntry({ ...entry(9, 'orders'), time: new Date(NOW - 10 * DAY_MS).toISOString() })}\n` },
      { name: '10-22.jsonl', text: `${formatEntry(entry(1, 'council'))}\n` },
    ]
    expect(prunedFiles(files, NOW)).toEqual([
      { name: '01-01.jsonl', text: '' },
      { name: '10-12.jsonl', text: `${formatEntry({ ...entry(9, 'orders'), time: new Date(NOW - 10 * DAY_MS).toISOString() })}\n` },
    ])
    // Past 2,000, the oldest go.
    const many = Array.from({ length: DOCKET_LIMITS.entries + 5 }, (_, index) => formatEntry({ ...entry(index, 'consult'), id: `n${index}` }))
    const [pruned] = prunedFiles([{ name: '10-22.jsonl', text: `${many.join('\n')}\n` }], NOW)
    const left = parseDocket(pruned!.text)
    expect(left.length).toBe(DOCKET_LIMITS.entries)
    expect(left.some(item => item.id === `n${DOCKET_LIMITS.entries + 4}`)).toBe(false)
    expect(docketEntries([`${many.join('\n')}\n`, `${formatEntry(old(1))}\n`], NOW).length).toBe(DOCKET_LIMITS.entries)
  })

  test('the view pages through the filtered entries, newest first', () => {
    const kinds: DocketKind[] = ['consult', 'orders', 'amendment', 'leave', 'summons']
    const entries = docketEntries([Array.from({ length: 45 }, (_, index) => formatEntry(entry(index, kinds[index % kinds.length]!))).join('\n')], NOW)
    expect(entries[0]!.id).toBe('e00')
    expect(docketPage(entries, 'all', 0)).toMatchObject({ total: 45, offset: 0 })
    expect(docketPage(entries, 'all', 20).entries[0]!.id).toBe('e20')
    expect(docketPage(entries, 'all', 999)).toMatchObject({ offset: 40 })
    expect(docketPage(entries, 'orders', 0).total).toBe(18)
    expect(docketPage(entries, 'amendments', 0).entries.every(item => item.kind === 'amendment')).toBe(true)
    expect(docketPage(entries, 'other', 0).entries.every(item => item.kind === 'leave')).toBe(true)
    expect(offsetOf(entries, 'all', 'e25')).toBe(20)
  })
})

// ── Through the hooks ─────────────────────────────────────────────────────

type Spawn = { subagentType: string; description: string; prompt: string; model?: string; resume?: { agentId: string } }

function standIn(on: On, options: { verdict?: (system: string, prompt: string) => string; files?: Map<string, string>; failWrite?: (path: string) => boolean; onWrite?: (path: string, text: string) => void } = {}) {
  const files = options.files ?? new Map<string, string>()
  const ran: string[][] = []
  const spawned: Spawn[] = []
  const harness = baseStandIn(on, {
    root: ROOT,
    complete: ({ system, prompt }) =>
      system.includes('You sort a person') ? 'COUNCIL' : (options.verdict?.(system, prompt) ?? 'CONCERN: 2\nVERDICT: Reasonable.\nDETAIL: Scoped well.'),
  })
  mock.env(on, { HOME })
  on('fs.stat', ($, e) => (DIRS.some(folder => testPath(e.path) === `${ROOT}/${folder}`) ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: files.has(testPath(e.path)) }))
  on('fs.read', ($, e) => (files.has(testPath(e.path)) ? { value: files.get(testPath(e.path))! } : { deny: 'no such file' }))
  on('fs.write', ($, e) => {
    const path = testPath(e.path)
    if (options.failWrite?.(path)) return { deny: 'the disk is full' }
    files.set(path, e.text)
    options.onWrite?.(path, e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const prefix = `${testPath(e.path)}/`
    const names = [...files.keys()].filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    return names.length === 0 ? { deny: 'no such directory' } : { value: names.map(path => ({ name: path.slice(prefix.length), kind: 'file', size: files.get(path)!.length, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.fork', () => ({ value: { isAnswered: true, text: 'The person wants a decision.', usage: USAGE } }))
  on('agent.spawn', ($, e) => {
    const input = e as unknown as Spawn
    const subagentType = input.subagentType ?? (input as unknown as { subagent_type: string }).subagent_type
    spawned.push({ ...input, subagentType })
    return { model: input.model ?? 'inherit', agentId: input.resume?.agentId ?? `agent-${spawned.length}` }
  })
  on('agent.list', () => ({ value: spawned.map((_, index) => ({ id: `agent-${index + 1}`, status: 'running', description: '', type: 'x' })) }) as never)
  on('session.send', () => ({ isDelivered: true }))
  return Object.assign(harness, { files, ran, spawned })
}

const start = async ($: Engine, harness: { clock: { set: (ms: number) => Promise<void> } }) => {
  await harness.clock.set(NOW)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
}
const run = ($: Engine, args: string) => $.command.run(composer('council', args))
const text = (result: unknown) => String((result as { result?: unknown }).result ?? (result as { deny?: unknown }).deny)
const consult = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__council__consult', ...input } as never)
const propose = ($: Engine, plan: string, dispatches: Array<Record<string, unknown>>) =>
  $.tool.call({ tool: 'mcp__council__propose_orders', plan, dispatches: dispatches.map(dispatch => ({ task: `Work in ${String(dispatch.folder)}.`, todos: ['Do it'], ...dispatch })) } as never)
const finish = ($: Engine, agentId: string, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', agentId, reason: 'answer' } as never)
const mountPane = ($: Engine) => $.ui.mount({ plugin: 'council', surface: 'desktop', component: 'Pane', requestId: 'council-chamber', props: PANE })

// Every entry written to this project's docket, oldest first.
const written = (files: Map<string, string>) =>
  [...files.entries()]
    .filter(([path]) => path.startsWith(`${FOLDER}/`) && path.endsWith('.jsonl'))
    .flatMap(([, text]) => parseDocket(text))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time))

// Lets background work (the lock's waits, second rounds) run until `isDone` holds.
const until = async (harness: { clock: { advance: (ms: number) => Promise<void> } }, isDone: () => boolean, tries = 60) => {
  for (let attempt = 0; attempt < tries && !isDone(); attempt++) {
    await harness.clock.advance(50)
    await settle()
  }
}

test('a consult, a council and a court-mode council are each recorded with every vote; the chamber opens its entry', async ($, on) => {
  const harness = standIn(on, {
    verdict: (system, prompt) =>
      prompt.includes('OPTIONS:') ? (system.includes('You are The Castellan') ? 'CONCERN: 3\nVERDICT: Redis needs a password.\nDETAIL: Set requirepass.\nCHOICE: 1' : 'CONCERN: 1\nVERDICT: Either works.\nCHOICE: 2') : 'CONCERN: 2\nVERDICT: Reasonable.\nDETAIL: Scoped well.',
  })
  await start($, harness)
  expect(text(await consult($, { question: 'Which queue?', context: 'A small app on one host.', options: ['Redis', 'SQS'] }))).toContain('Most favor option 2.')
  await until(harness, () => written(harness.files).length === 1)
  const [consulted] = written(harness.files)
  expect(consulted).toMatchObject({ v: 1, kind: 'consult', session: 'session-1', project: ROOT, question: 'Which queue?', options: ['Redis', 'SQS'], outcome: 'option 2', threshold: 3, strictness: 0 })
  expect(consulted!.tally).toEqual({ gravest: 3, concerns: [4, 0, 1, 0, 0], abstained: 0, silent: 0, picks: [1, 4] })
  expect(consulted!.votes!.length).toBe(5)
  expect(consulted!.votes!.find(vote => vote.id === 'castellan')).toMatchObject({ title: 'The Castellan', status: 'done', concern: 3, verdict: 'Redis needs a password.', detail: 'Set requirepass.', choice: 1 })
  // The folder and the day's file are made owner-only (POSIX).
  expect(harness.ran).toContainEqual(['mkdir', '-p', '-m', '700', FOLDER])
  expect(harness.ran).toContainEqual(['chmod', '700', DOCKET, FOLDER])
  expect(harness.ran).toContainEqual(['chmod', '600', TODAY])
  expect(harness.files.get(LOCK)).toBe('')

  // The chamber links to the sitting's entry.
  const pane = await mountPane($)
  await pane.press({ key: 'docket' })
  expect(await pane.find({ text: /Docket · work/ })).toBeDefined()
  expect(await pane.find({ text: /Redis needs a password\./ })).toBeDefined()
  expect(await pane.find({ text: /picks 1/ })).toBeDefined()
  await pane.press({ key: 'docket-close' })
  await pane.unmount()

  await run($, 'Should we cache the reports?')
  await until(harness, () => written(harness.files).length === 2)
  expect(written(harness.files)[1]).toMatchObject({ kind: 'council', question: 'Should we cache the reports?', outcome: 'adjourned' })

  await run($, 'court on')
  await $.prompt.submit({ text: 'Rate-limit the billing API', origin: { kind: 'composer' } } as never)
  await until(harness, () => written(harness.files).length === 3)
  expect(written(harness.files)[2]).toMatchObject({ kind: 'court', question: 'Rate-limit the billing API', outcome: 'adjourned' })
  // One file for the day, three lines.
  expect(harness.files.get(TODAY)!.trim().split('\n').length).toBe(3)
})

test('a ruling records levels, conditions and its orders, and the court links to it; leave, an amendment and a recall are recorded too', async ($, on) => {
  const harness = standIn(on, {
    verdict: system =>
      system.includes('You are The Castellan') ? 'CONCERN: 3\nVERDICT: Mind the keys.\nDETAIL: The config has token=abcdef1234567890 in it.\nLEVEL 1: 3\nLEVEL 2: 1' : 'CONCERN: 2\nVERDICT: Fine.\nLEVEL 1: 2\nLEVEL 2: 1',
  })
  await start($, harness)
  const leave = 'May run npm install inside api to add the limiter package.'
  expect(text(await propose($, 'Rate-limit the API.', [{ folder: 'api', role: 'knight', leave: [leave] }, { folder: 'web', role: 'scout' }]))).toContain('The council approved the plan')
  await until(harness, () => written(harness.files).length === 1)
  const [ruled] = written(harness.files)
  expect(ruled).toMatchObject({ kind: 'orders', plan: 'Rate-limit the API.', outcome: 'approved', orderIds: ['O1', 'O2'], dispatches: [{ folder: 'api', role: 'knight', leave: [leave] }, { folder: 'web', role: 'scout' }] })
  expect(ruled!.votes!.find(vote => vote.id === 'castellan')).toMatchObject({ concern: 3, levels: [3, 1] })
  expect(ruled!.votes!.find(vote => vote.id === 'castellan')!.detail).toBe(`The config has token=${REDACTED} in it.`)
  expect(ruled!.conditions).toEqual([`The Castellan: Mind the keys. (The config has token=${REDACTED} in it.)`])

  // The court's latest ruling opens its entry.
  const pane = await mountPane($)
  await pane.press({ key: 'ruling-docket' })
  expect(await pane.find({ text: /^Conditions$/ })).toBeDefined()
  expect(await pane.find({ text: /levels 3, 1/ })).toBeDefined()
  expect(await pane.find({ text: /orders: O1, O2/ })).toBeDefined()
  await pane.unmount()

  await run($, 'grant O1')
  expect((await $.agent.spawn({ subagentType: 'council:knight', description: 'O1 api limits', prompt: 'Do it.' } as never) as { agentId?: string }).agentId).toBe('agent-1')
  expect(text(await $.tool.call({ tool: 'mcp__council__amend_order', id: 'O1', change: 'Also add tests for the limiter.', reason: 'Coverage.' } as never))).toContain('approved')
  await run($, 'recall O1 The plan changed.')
  await until(harness, () => written(harness.files).length === 4)
  const [, granted, amended, recalled] = written(harness.files)
  expect(granted).toMatchObject({ kind: 'leave', outcome: 'granted', orderIds: ['O1'], by: 'person', dispatches: [{ folder: 'api', role: 'knight', leave: [leave] }] })
  expect(amended).toMatchObject({ kind: 'amendment', plan: 'Amend O1: Also add tests for the limiter.\nWhy: Coverage.', outcome: 'approved', orderIds: ['O1'] })
  expect(amended!.votes!.length).toBe(5)
  expect(recalled).toMatchObject({ kind: 'recall', outcome: 'recalling', reason: 'The plan changed.', orderIds: ['O1'], by: 'person' })
})

test('entries from before 0.6.0 still show: a held ruling, its second round (summons) and an advisor the person sent (advise)', async ($, on) => {
  const held = entry(3, 'orders', {
    plan: 'Rate-limit the API.',
    outcome: 'held',
    runId: 'A1',
    orderIds: ['O1'],
    votes: [{ id: 'castellan', title: 'The Castellan', status: 'done', concern: 3, verdict: 'Is a key committed?', detail: 'Unclear.', check: 'Is an API key committed in api/?' }],
  })
  const second = entry(2, 'summons', { plan: 'Rate-limit the API.', outcome: 'approved', runId: 'A1', follows: 'e03', orderIds: ['O1'], findings: 'No key is committed; api/.env is ignored.' })
  const advised = entry(1, 'advise', { question: 'where does the client retry?', folders: ['web'], outcome: 'done', runId: 'A2', by: 'person', findings: 'Retries are in web/src/http.ts:40.' })
  const files = new Map([[TODAY, `${[held, second, advised].map(formatEntry).join('\n')}\n`]])
  const harness = standIn(on, { files })
  await start($, harness)
  expect(String((await run($, 'docket')).text)).toContain('The docket is open')
  const pane = await mountPane($)
  expect(await pane.find({ text: /^1–3 of 3$/ })).toBeDefined()
  expect(await pane.find({ text: /▸ where does the client retry\?/ })).toBeDefined()

  await pane.press({ key: 'docket-entry-e03' })
  expect(await pane.find({ text: /^orders · held/ })).toBeDefined()
  expect(await pane.find({ text: /check: Is an API key committed in api\/\?/ })).toBeDefined()
  await pane.press({ key: 'docket-entry-e02' })
  expect(await pane.find({ text: /^second round · approved/ })).toBeDefined()
  expect(await pane.find({ text: /^The advisor \(A1\)$/ })).toBeDefined()
  expect(await pane.find({ text: /^No key is committed; api\/\.env is ignored\.$/ })).toBeDefined()
  expect(await pane.find({ text: /^second round of e03$/ })).toBeDefined()
  await pane.press({ key: 'docket-entry-e01' })
  expect(await pane.find({ text: /^advisor · done/ })).toBeDefined()
  expect(await pane.find({ text: /^read web\/$/ })).toBeDefined()
  expect(await pane.find({ text: /^Retries are in web\/src\/http\.ts:40\.$/ })).toBeDefined()

  // They keep their filters: a second round with the orders, an advisor with the rest.
  await pane.press({ key: 'docket-filter-orders' })
  expect(await pane.find({ text: /^1–2 of 2$/ })).toBeDefined()
  await pane.press({ key: 'docket-filter-other' })
  expect(await pane.find({ text: /^1–1 of 1$/ })).toBeDefined()
  await pane.unmount()
  // Reading them rewrites nothing.
  expect(harness.files.get(TODAY)).toBe(`${[held, second, advised].map(formatEntry).join('\n')}\n`)
})

test('a failed write never breaks a consult: it answers as usual, and the failure is toasted once', async ($, on) => {
  const harness = standIn(on, { failWrite: path => path.startsWith(DOCKET) })
  await start($, harness)
  expect(text(await consult($, { question: 'Ship it?', context: 'All tests pass.' }))).toContain('The council on "Ship it?"')
  await until(harness, () => harness.toasts.some(toast => toast.includes('docket could not be written')))
  expect(text(await consult($, { question: 'Ship it now?', context: 'Still passing.' }))).toContain('The council on "Ship it now?"')
  await until(harness, () => false, 10)
  expect(harness.toasts.filter(toast => toast.includes('docket could not be written')).length).toBe(1)
  expect(harness.toasts.find(toast => toast.includes('docket could not be written'))).toContain('sittings go on unrecorded')
})

test('two sessions writing one project take turns through the lock: neither line is lost', async ($, on) => {
  const other = formatEntry(entry(30, 'council', { session: 'session-2' }))
  let isRaced = false
  const harness = standIn(on, {
    // Another session writes its own token just after this one's: this one must wait.
    onWrite: (path, written) => {
      if (path === LOCK && written !== '' && !isRaced) {
        isRaced = true
        harness.files.set(LOCK, formatLock({ token: 'session-2', at: harness.clock.now() }))
      }
    },
  })
  await start($, harness)
  await consult($, { question: 'Ship it?', context: 'All tests pass.' })
  await until(harness, () => false, 12)
  expect(isRaced).toBe(true)
  expect(harness.files.has(TODAY)).toBe(false)
  // The other session writes its line and lets go; this one's goes after it.
  harness.files.set(TODAY, `${other}\n`)
  harness.files.set(LOCK, '')
  await until(harness, () => written(harness.files).length === 2)
  expect(written(harness.files).map(item => item.session)).toEqual(['session-2', 'session-1'])
  expect(harness.files.get(LOCK)).toBe('')
})

test('a lock left by a session that died is taken over once it is stale', async ($, on) => {
  const files = new Map([[LOCK, formatLock({ token: 'dead-session', at: NOW - 5_000 })]])
  const harness = standIn(on, { files })
  await start($, harness)
  await consult($, { question: 'Ship it?', context: 'All tests pass.' })
  await until(harness, () => false, 20)
  // Held for under ten seconds: still waiting.
  expect(written(files).length).toBe(0)
  await harness.clock.advance(6_000)
  await until(harness, () => written(files).length === 1)
  expect(written(files).length).toBe(1)
})

test('retention prunes the docket once a session, touching only its own day files', async ($, on) => {
  const old = formatEntry({ ...entry(0, 'consult', { id: 'old' }), time: new Date(NOW - 200 * DAY_MS).toISOString() })
  const recent = formatEntry({ ...entry(0, 'orders', { id: 'recent' }), time: new Date(NOW - 2 * DAY_MS).toISOString() })
  const otherProject = `${DOCKET}/${projectKey('/dev/other')}/04-05.jsonl`
  const files = new Map([
    [`${FOLDER}/04-05.jsonl`, `${old}\n`],
    [`${FOLDER}/10-20.jsonl`, `${recent}\n`],
    [`${FOLDER}/notes.txt`, `${old}\n`],
    [otherProject, `${old}\n`],
  ])
  const harness = standIn(on, { files })
  await start($, harness)
  await consult($, { question: 'Ship it?', context: 'All tests pass.' })
  await until(harness, () => written(files).some(item => item.session === 'session-1'))
  expect(files.get(`${FOLDER}/04-05.jsonl`)).toBe('')
  expect(files.get(`${FOLDER}/10-20.jsonl`)).toBe(`${recent}\n`)
  expect(files.get(`${FOLDER}/notes.txt`)).toBe(`${old}\n`)
  expect(files.get(otherProject)).toBe(`${old}\n`)
  // Not again in this session.
  files.set(`${FOLDER}/04-05.jsonl`, `${old}\n`)
  await consult($, { question: 'Ship it now?', context: 'Still passing.' })
  await until(harness, () => written(files).length === 4)
  expect(files.get(`${FOLDER}/04-05.jsonl`)).toBe(`${old}\n`)
})

test('/council docket lists entries newest first, filters by kind, pages, and opens one to every vote', async ($, on) => {
  const kinds: DocketKind[] = ['consult', 'orders', 'amendment', 'council', 'court']
  const lines = Array.from({ length: 24 }, (_, index) => formatEntry(entry(index + 1, kinds[index % kinds.length]!, { question: `Question ${index + 1}` })))
  const ruled = entry(0, 'orders', {
    plan: 'Rate-limit the billing API.',
    outcome: 'approved',
    tally: { gravest: 3, concerns: [0, 4, 1, 0, 0], abstained: 0, silent: 0 },
    threshold: 3,
    votes: [
      { id: 'castellan', title: 'The Castellan', status: 'done', concern: 3, verdict: 'Mind the keys.', detail: 'Rotate them first.', levels: [2, null], check: 'Is a key committed?' },
      { id: 'jester', title: 'The Court Jester', status: 'abstained', concern: 0, verdict: 'Not my remit.', detail: '' },
    ],
    abstentions: [{ id: 'jester', title: 'The Court Jester', reason: 'Not my remit.' }],
    conditions: ['The Castellan: Mind the keys.'],
    notes: ['Kept: it is warranted.'],
    findings: 'No key is committed.',
    orderIds: ['O7', 'O8'],
  })
  const files = new Map([[TODAY, `${[formatEntry(ruled), '{corrupt', ...lines].join('\n')}\n`]])
  const harness = standIn(on, { files })
  await start($, harness)
  expect(String((await run($, 'docket')).text)).toContain('The docket is open')
  const pane = await mountPane($)
  expect(await pane.find({ text: /^1–20 of 25$/ })).toBeDefined()
  expect(await pane.find({ text: /▸ Rate-limit the billing API\./ })).toBeDefined()
  expect(await pane.find({ text: /Castellan 3/ })).toBeDefined()
  expect(await pane.find({ text: /Question 24/ })).toBeUndefined()

  await pane.press({ key: 'docket-more' })
  expect(await pane.find({ text: /^21–25 of 25$/ })).toBeDefined()
  expect(await pane.find({ text: /Question 24/ })).toBeDefined()
  await pane.press({ key: 'docket-less' })
  expect(await pane.find({ text: /^1–20 of 25$/ })).toBeDefined()

  await pane.press({ key: 'docket-filter-amendments' })
  expect(await pane.find({ text: /^1–5 of 5$/ })).toBeDefined()
  expect(await pane.find({ text: /Rate-limit the billing API/ })).toBeUndefined()
  await pane.press({ key: 'docket-filter-orders' })
  expect(await pane.find({ text: /^1–6 of 6$/ })).toBeDefined()

  await pane.press({ key: 'docket-entry-e00' })
  expect(await pane.find({ text: /Castellan ●●●○○ Mind the keys\./ })).toBeDefined()
  expect(await pane.find({ text: /^Rotate them first\.$/ })).toBeDefined()
  expect(await pane.find({ text: /levels 2, –/ })).toBeDefined()
  expect(await pane.find({ text: /check: Is a key committed\?/ })).toBeDefined()
  expect(await pane.find({ text: /Court Jester abstains: Not my remit\./ })).toBeDefined()
  expect(await pane.find({ text: /· The Castellan: Mind the keys\./ })).toBeDefined()
  expect(await pane.find({ text: /· Kept: it is warranted\./ })).toBeDefined()
  expect(await pane.find({ text: /^No key is committed\.$/ })).toBeDefined()
  expect(await pane.find({ text: /orders: O7, O8/ })).toBeDefined()
  await pane.press({ key: 'docket-entry-e00' })
  expect(await pane.find({ text: /Rotate them first/ })).toBeUndefined()

  await pane.press({ key: 'docket-close' })
  expect(await pane.find({ text: /Docket ·/ })).toBeUndefined()
  await pane.unmount()
})
