import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { SessionContextBreakdown } from 'claude-code'

import { serializeSegment, promptEntry } from '../hooks/ledger'
import { BAND_PROPS, baseStandIn, composer, settle } from './stand-in'

const ROOT = '/dev/work'
const mountBar = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'sidekick', surface, component: 'AbovePrompt', props: BAND_PROPS })
const exchange = (prompt: string, answer: string) => [
  { role: 'user' as const, text: prompt, toolUses: [] },
  { role: 'assistant' as const, text: answer, toolUses: [] },
]

// ── The bar ───────────────────────────────────────────────────────────────

test('the bar shows its on-demand buttons, and replay only after an edit', async ($, on) => {
  baseStandIn(on, { root: ROOT })
  for (const surface of ['terminal', 'desktop'] as const) {
    const bar = await mountBar($, surface)
    expect(await bar.find({ key: 'bar-tldr' })).toBeDefined()
    expect(await bar.find({ key: 'bar-replay' })).toBeUndefined()
    await bar.unmount()
  }
})

test('a successful edit shows its stats on the bar; a failed one is left out', async ($, on) => {
  let isError = false
  baseStandIn(on, { root: ROOT, toolResult: () => (isError ? { result: 'failed', text: 'failed', isError: true } : { result: 'ok', text: 'ok' }) })
  const edit = async (turnId: string) => {
    await $.turn.start({ text: 'rename it', turnId })
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/project/a.ts`, old_string: 'greet', new_string: 'welcome' })
    await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId, reason: 'answer' })
  }
  await edit('t1')
  let bar = await mountBar($)
  expect(await bar.find({ text: /▶ 1 edit \+1 −1/ })).toBeDefined()
  await bar.unmount()

  isError = true
  await edit('t2')
  bar = await mountBar($)
  // The failed edit added nothing: the last successful turn's replay remains.
  expect(await bar.find({ text: /▶ 1 edit \+1 −1/ })).toBeDefined()
  await bar.unmount()
})

test('with replay off, edits are not recorded', { options: { replayEnabled: false } }, async ($, on) => {
  baseStandIn(on, { root: ROOT })
  await $.turn.start({ text: 'rename it', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/project/a.ts`, old_string: 'a', new_string: 'b' })
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  const bar = await mountBar($)
  expect(await bar.find({ key: 'bar-replay' })).toBeUndefined()
  await bar.unmount()
})

// ── TL;DR and heads-up ────────────────────────────────────────────────────

test('TL;DR runs only when clicked, once per answer, on Haiku 5.5', async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT, complete: () => 'SUMMARY: Moved billing to Stripe.' })
  harness.messages = exchange('move billing to stripe', 'x'.repeat(3000))
  await $.turn.start({ text: 'move billing to stripe', turnId: 't1' })
  await $.turn.complete({ answer: 'x'.repeat(3000), durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle()
  // A long answer alone makes no model call.
  expect(harness.completions.length).toBe(0)
  const callsBefore = harness.completions.length

  const bar = await mountBar($)
  await bar.press({ key: 'bar-tldr' })
  await harness.clock.settle()
  await settle()
  expect(await bar.find({ text: /Moved billing to Stripe\./ })).toBeDefined()
  expect(harness.completions.length).toBe(callsBefore + 1)
  expect(harness.completions[harness.completions.length - 1]!.model).toBe('claude-haiku-5-5')
  // Closing and reopening reuses it.
  for (let press = 0; press < 2; press++) {
    await bar.press({ key: 'bar-tldr' })
    await harness.clock.settle()
  }
  expect(await bar.find({ text: /Moved billing to Stripe\./ })).toBeDefined()
  expect(harness.completions.length).toBe(callsBefore + 1)
  await bar.unmount()
})

test('a TL;DR that lands after the next prompt is dropped', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const harness = baseStandIn(on, {
    root: ROOT,
    complete: async () => {
      await gate
      return 'SUMMARY: Stale summary.'
    },
  })
  harness.messages = exchange('first', 'an answer')
  await $.turn.start({ text: 'first', turnId: 't1' })
  const bar = await mountBar($)
  const pressed = bar.press({ key: 'bar-tldr' })
  await harness.clock.settle()
  await settle()
  await $.turn.start({ text: 'second', turnId: 't2' })
  release()
  await pressed
  await settle()
  expect(await bar.find({ text: /Stale summary/ })).toBeUndefined()
  await bar.unmount()
})

test('heads-up runs only when clicked: no call after a long answer, the note on click', async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT, complete: () => 'HEADLINE: The old webhook still points at production.\nDETAIL: Test events will charge real cards.' })
  harness.messages = exchange('move billing to stripe', 'x'.repeat(3000))
  await $.turn.start({ text: 'move billing to stripe', turnId: 't1' })
  await $.turn.complete({ answer: 'x'.repeat(3000), durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle()
  expect(harness.completions.length).toBe(0)

  const bar = await mountBar($)
  await bar.press({ key: 'bar-headsUp' })
  await harness.clock.settle()
  await settle()
  expect(harness.completions.length).toBe(1)
  expect(await bar.find({ text: /old webhook still points at production/ })).toBeDefined()
  await bar.press({ key: 'known' })
  expect(await bar.find({ text: /old webhook/ })).toBeUndefined()
  await bar.unmount()
})

// ── TL;DR briefs from the ledger ──────────────────────────────────────────

const HOME = '/home/me'
const LEDGER = `${HOME}/.claude/sidekick/ledgers/session-1`
// chmod and the git calls a brief makes, for one repo at ROOT/project.
const machine = (argv: readonly string[]) => {
  if (argv[0] === 'chmod') return { exitCode: 0, stdout: '' }
  if (argv[0] !== 'git') return undefined
  if (argv.includes('rev-parse')) return { exitCode: 0, stdout: `${ROOT}/project\n` }
  if (argv.includes('status')) return { exitCode: 0, stdout: ' M a.ts\n' }
  if (argv.includes('log')) return { exitCode: 0, stdout: '' }
  return undefined
}

test('TL;DR of a working turn: figures, the claims check, the record on disk, and a handoff', async ($, on) => {
  const files = new Map([[`${ROOT}/project/a.ts`, 'greet']])
  let isFailing = false
  const harness = baseStandIn(on, {
    root: ROOT,
    files,
    run: machine,
    env: { HOME },
    toolResult: () => (isFailing ? { result: 'failed', text: '1 failing', isError: true } : { result: 'ok', text: 'ok' }),
    complete: () => 'DONE: Fixed the parser.\nSTUCK: The tests still fail.\nNEEDS YOU: NONE\nPHASES:\n- +0:00 Edited the parser',
  })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'fix the parser', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/project/a.ts`, old_string: 'greet', new_string: 'welcome' })
  isFailing = true
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })
  await $.turn.complete({ answer: 'Fixed a.ts and all tests pass.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle()
  // Recorded as it happened, with no model call.
  expect(files.get(`${LEDGER}/000000.jsonl`)).toContain('"tool":"Bash"')
  expect(harness.completions.length).toBe(0)

  const bar = await mountBar($)
  await bar.press({ key: 'bar-tldr' })
  await harness.clock.settle()
  await settle()
  expect(harness.completions.length).toBe(1)
  expect(harness.completions[0]!.prompt).toContain('FIGURES (counted from the log)')
  expect(await bar.find({ text: /Done: Fixed the parser\./ })).toBeDefined()
  expect(await bar.find({ text: /⚠ Says tests pass, but the last test run failed \(Run the tests\)\./ })).toBeDefined()
  await bar.press({ key: 'brief-detail' })
  expect(await bar.find({ text: /project: 1 file \+1 −1 · 1 uncommitted/ })).toBeDefined()
  await bar.press({ key: 'write-handoff' })
  expect(files.get(`${ROOT}/project/HANDOFF.md`)).toContain('# Handoff: project')
  await bar.unmount()
})

test('/tldr full of a long session waits for a go-ahead, then condenses it part by part', async ($, on) => {
  const files = new Map<string, string>()
  for (let segment = 0; segment < 5; segment++) {
    const entries = Array.from({ length: 250 }, (_, index) => promptEntry(segment * 250 + index, `t${index}`, `step ${index} ${'x'.repeat(1400)}`))
    files.set(`${LEDGER}/${String(segment).padStart(6, '0')}.jsonl`, serializeSegment(entries))
  }
  const harness = baseStandIn(on, {
    root: ROOT,
    files,
    run: machine,
    env: { HOME },
    complete: request => (request.prompt.startsWith('PART') ? '- worked on it' : 'DONE: A long night of steps.\nSTUCK: NONE\nNEEDS YOU: NONE\nPHASES:\n- +0:00 Steps'),
  })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  expect((await $.command.run(composer('tldr', 'whole'))).text).toBe('This TL;DR needs 13 Haiku calls: confirm it on the bar above the prompt.')
  expect(harness.completions.length).toBe(0)

  const bar = await mountBar($)
  expect(await bar.find({ text: /TL;DR •/ })).toBeDefined()
  await bar.press({ key: 'run-brief' })
  await harness.clock.settle()
  await settle()
  expect(harness.completions.length).toBe(13)
  expect(await bar.find({ text: /Done: A long night of steps\./ })).toBeDefined()
  await bar.press({ key: 'brief-detail' })
  expect(await bar.find({ text: /The earliest \d+ of \d+ parts were left out/ })).toBeDefined()
  await bar.unmount()
  expect((await $.command.run(composer('tldr', 'yesterday'))).text).toMatch(/^Usage: \/tldr/)
})

// ── Scope guard and rules ─────────────────────────────────────────────────

test('with no scope set, edits anywhere go through and never set one', async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/project/src/a.ts`, old_string: 'a', new_string: 'b' })
  const elsewhere = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/other/a.ts`, old_string: 'a', new_string: 'b' })
  expect(elsewhere.deny).toBeUndefined()
  const atRoot = await $.tool.call({ tool: 'Bash', command: `sed -i '' 's/foo/bar/g' $(grep -rl foo .)` })
  expect(atRoot.deny).toBeUndefined()
  expect(harness.tools).toEqual(['Edit', 'Edit', 'Bash'])
  expect((await $.command.run(composer('scope', 'show'))).text).toContain('idle until /scope set or add')
})

test('a scope set with /scope set blocks a sed run at the root and edits in siblings', async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT })
  on('fs.list', () => ({ value: [] }))
  expect((await $.command.run(composer('scope', 'set project'))).text).toBe('Scope: project/.')
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/project/src/a.ts`, old_string: 'a', new_string: 'b' })
  const blocked = await $.tool.call({ tool: 'Bash', command: `sed -i '' 's/foo/bar/g' $(grep -rl foo .)` })
  expect(blocked.deny).toContain('sidekick scope guard')
  expect(blocked.deny).toContain('cd project')
  const scoped = await $.tool.call({ tool: 'Bash', command: `cd project && sed -i '' 's/foo/bar/g' $(grep -rl foo .)` })
  expect(scoped.deny).toBeUndefined()
  const sibling = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/other/a.ts`, old_string: 'a', new_string: 'b' })
  expect(sibling.deny).toContain('outside the target folder')
  // A file edit can't be re-run from another folder: no cd advice, just the scope to add.
  expect(sibling.deny).not.toContain('cd project')
  expect(sibling.deny).toContain('/scope add other')
  // The blocked calls never reached the tool; other tools pass untouched.
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/other/a.ts` })
  expect(harness.tools).toEqual(['Edit', 'Bash', 'Read'])
})

test('/scope add . lets the root\'s own files change, but not the folders under it', async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT })
  on('fs.list', () => ({ value: [] }))
  await $.command.run(composer('scope', 'set project'))
  const before = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/CLAUDE.md`, old_string: 'a', new_string: 'b' })
  expect(before.deny).toContain('/scope add .')
  expect((await $.command.run(composer('scope', 'add .'))).text).toBe('Scope: project/, ./ (root files).')
  const rootFile = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/CLAUDE.md`, old_string: 'a', new_string: 'b' })
  expect(rootFile.deny).toBeUndefined()
  const sibling = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/other/a.ts`, old_string: 'a', new_string: 'b' })
  expect(sibling.deny).toContain('outside the target folder')
  expect((await $.command.run(composer('scope', 'remove .'))).text).toBe('Scope: project/.')
  expect(harness.tools).toEqual(['Edit'])
})

test('with the guard off, nothing is blocked', { options: { scopeGuardEnabled: false } }, async ($, on) => {
  baseStandIn(on, { root: ROOT })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/project/a.ts`, old_string: 'a', new_string: 'b' })
  const result = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/other/a.ts`, old_string: 'a', new_string: 'b' })
  expect(result.deny).toBeUndefined()
})

test('a guard error blocks guarded calls every time, and nothing else', async ($, on) => {
  const ran: string[] = []
  on('ui.toast', () => ({ value: undefined }))
  // No session.root or session.cwd: every guard check throws.
  on('tool.call', ($, e) => {
    ran.push(String(e.tool))
    return { result: 'ok', text: 'ok' }
  })
  const first = await $.tool.call({ tool: 'Edit', file_path: '/x/a.ts', old_string: 'a', new_string: 'b' })
  expect(first.deny).toContain('internal error')
  const second = await $.tool.call({ tool: 'Edit', file_path: '/x/a.ts', old_string: 'a', new_string: 'b' })
  expect(second.deny).toContain('internal error')
  await $.tool.call({ tool: 'Read', file_path: '/x/a.ts' })
  expect(ran).toEqual(['Read'])
})

test('a blocked call puts Rule? on the bar; a click suggests one; add writes and verifies it', async ($, on) => {
  const files = new Map<string, string>()
  const settingsPath = `${ROOT}/.claude/settings.local.json`
  const harness = baseStandIn(on, {
    root: ROOT,
    complete: () => 'RULE: fence other | a separate repo this session must not touch',
    // The engine enforces the deny rule once settings.local.json holds it.
    decide: (tool, input) =>
      tool === 'Edit' && String((input as { file_path?: string }).file_path).startsWith(`${ROOT}/other/`) && (files.get(settingsPath) ?? '').includes('Edit(//dev/work/other/**)') ? 'deny' : 'ask',
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
  on('fs.list', ($, e) => ({ value: e.path === ROOT ? [dir('project'), dir('other'), dir('.git')] : [] }))

  await $.command.run(composer('scope', 'set project'))
  await $.turn.start({ text: 'fix the typo everywhere', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/project/a.ts`, old_string: 'a', new_string: 'b' })
  expect((await $.tool.call({ tool: 'Bash', command: `sed -i '' 's/teh/the/g' $(grep -rl teh .)` })).deny).toBeDefined()
  await $.turn.complete({ answer: 'Fixed it in project.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle()
  // Nothing ran on its own: the rule waits for a click.
  expect(harness.completions.length).toBe(0)

  const bar = await mountBar($)
  expect(await bar.find({ text: /Rule\? \(1 blocked\)/ })).toBeDefined()
  await bar.press({ key: 'bar-rule' })
  await harness.clock.settle()
  await settle()
  expect(harness.completions.length).toBe(1)
  expect(harness.completions[0]!.prompt).toContain('Bash: .')
  expect(await bar.find({ text: /never edit other\// })).toBeDefined()
  // The fence check waits on the clock between probes; move it along.
  const adding = bar.press({ key: 'add-rule' })
  for (let step = 0; step < 10; step++) await harness.clock.advance(400)
  await adding
  expect(await bar.find({ key: 'bar-rule' })).toBeUndefined()
  await bar.unmount()

  expect((JSON.parse(files.get(settingsPath) ?? '{}') as { permissions?: { deny?: string[] } }).permissions?.deny).toEqual(['Edit(//dev/work/other/**)'])
  expect((await $.command.run(composer('rules', 'list'))).text).toContain('1. never edit other/')
  const removing = $.command.run(composer('rules', 'remove 1'))
  for (let step = 0; step < 10; step++) await harness.clock.advance(400)
  expect((await removing).text).toContain('Removed')
  expect(JSON.parse(files.get(settingsPath) ?? '{}')).toEqual({})
})

test('a malformed settings file stops add before anything is stored', async ($, on) => {
  const files = new Map<string, string>([[`${ROOT}/.claude/settings.local.json`, '{ not json']])
  baseStandIn(on, { root: ROOT })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.list', () => ({ value: [] }))
  expect((await $.command.run(composer('rules', 'add fence other'))).text).toContain('could not be read')
  expect((await $.command.run(composer('rules', 'list'))).text).toContain('No long-lived rules')
})

// ── Resume warning ────────────────────────────────────────────────────────

test('a resumed session with an expired cache holds the first prompt until Send', async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT })
  on('classic.SessionStart', () => ({}))
  await $.classic.SessionStart({ source: 'resume', prompt_cache_likely_expired: true, seconds_since_last_response: 7200, context_tokens: 120000 })
  const held = await $.prompt.submit({ text: 'carry on', origin: { kind: 'composer' }, wait: false })
  expect(held.drop).toBeDefined()
  expect(harness.prompts).toEqual([])

  const bar = await mountBar($)
  expect(await bar.find({ text: /2 hours/ })).toBeDefined()
  expect(await bar.find({ text: /120k tokens/ })).toBeDefined()
  await bar.press({ key: 'send-held' })
  expect(harness.prompts).toEqual(['carry on'])
  expect(await bar.find({ text: /2 hours/ })).toBeUndefined()
  await bar.unmount()
})

test('handoff from the Cold cache card: the press returns at once, then HANDOFF.md beside the record and a first prompt copied', async ($, on) => {
  const files = new Map([[`${ROOT}/project/a.ts`, 'greet']])
  const copies: Array<{ text: string; surface: unknown }> = []
  on('ui.copy', ($, e) => {
    copies.push({ text: e.text, surface: e.surface })
    return { value: { isCopied: true as const } }
  })
  const harness = baseStandIn(on, {
    root: ROOT,
    files,
    run: machine,
    env: { HOME },
    complete: () => 'DONE: Fixed the parser.\nSTUCK: NONE\nNEEDS YOU: Run the tests.\nPHASES:\n- +0:00 Edited the parser',
  })
  on('classic.SessionStart', () => ({}))
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'fix the parser', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/project/a.ts`, old_string: 'greet', new_string: 'welcome' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })
  await $.turn.complete({ answer: 'Fixed a.ts.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle()
  await $.classic.SessionStart({ source: 'resume', prompt_cache_likely_expired: true, seconds_since_last_response: 36000, context_tokens: 400000 })
  const secret = `AKIA${'Q'.repeat(16)}`
  await $.prompt.submit({ text: `deploy it with ${secret}`, origin: { kind: 'composer' }, wait: false })

  const bar = await mountBar($)
  await bar.press({ key: 'handoff-resume' })
  // The press returned before any model call: the brief runs on a timer.
  expect(harness.completions.length).toBe(0)
  // The warning is answered: the held prompt is back in the prompt box, unsent.
  expect(harness.filled).toEqual([`deploy it with ${secret}`])
  expect(harness.prompts).toEqual([])
  await harness.clock.settle()
  await settle()
  expect(harness.completions.length).toBe(1)
  const handoff = files.get(`${LEDGER}/HANDOFF.md`) ?? ''
  for (const text of ['# Handoff: work', 'covering the whole session', 'Fixed the parser.', '## Held prompt', '«redacted»', '- project: 1 file +1 −1', `\`${LEDGER}\``]) {
    expect(handoff).toContain(text)
  }
  expect(handoff).not.toContain(secret)
  expect(copies).toEqual([{ text: `Read ${LEDGER}/HANDOFF.md first: it's where an earlier session left off. Then: deploy it with ${secret}`, surface: 'terminal' }])
  expect(await bar.find({ text: /Handoff written to .*HANDOFF\.md\. Its first prompt is copied/ })).toBeDefined()
  await bar.unmount()
})

test('a brief whose part fails says why, and writes no handoff', async ($, on) => {
  // One segment: two parts to condense, under the go-ahead threshold.
  const entries = Array.from({ length: 250 }, (_, index) => promptEntry(index, `t${index}`, `step ${index} ${'x'.repeat(400)}`))
  const files = new Map([[`${LEDGER}/000000.jsonl`, serializeSegment(entries)]])
  const harness = baseStandIn(on, {
    root: ROOT,
    files,
    run: machine,
    env: { HOME },
    complete: request => (request.prompt.startsWith('PART') ? { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit' } : 'DONE: Steps.'),
  })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const bar = await mountBar($)
  await bar.press({ key: 'bar-tldr' })
  await harness.clock.settle()
  await settle()
  await bar.press({ key: 'handoff' })
  await harness.clock.settle()
  await settle()
  expect(harness.completions.length).toBeGreaterThan(0)
  expect(await bar.find({ text: /could not be condensed \(API error: rate_limit \(429\)\)/ })).toBeDefined()
  expect(files.has(`${LEDGER}/HANDOFF.md`)).toBe(false)
  await bar.unmount()
})

test('a handoff of a long session waits for the go-ahead, then writes HANDOFF.md', async ($, on) => {
  const files = new Map<string, string>()
  for (let segment = 0; segment < 5; segment++) {
    const entries = Array.from({ length: 250 }, (_, index) => promptEntry(segment * 250 + index, `t${index}`, `step ${index} ${'x'.repeat(1400)}`))
    files.set(`${LEDGER}/${String(segment).padStart(6, '0')}.jsonl`, serializeSegment(entries))
  }
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('classic.SessionStart', () => ({}))
  const harness = baseStandIn(on, {
    root: ROOT,
    files,
    run: machine,
    env: { HOME },
    complete: request => (request.prompt.startsWith('PART') ? '- worked on it' : 'DONE: A long night of steps.\nSTUCK: NONE\nNEEDS YOU: NONE\nPHASES:\n- +0:00 Steps'),
  })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.classic.SessionStart({ source: 'resume', prompt_cache_likely_expired: true, seconds_since_last_response: 36000, context_tokens: 400000 })

  const bar = await mountBar($)
  await bar.press({ key: 'bar-resume' })
  await bar.press({ key: 'handoff-resume' })
  await harness.clock.settle()
  await settle()
  expect(harness.completions.length).toBe(0)
  expect(await bar.find({ text: /This needs 13 Haiku calls/ })).toBeDefined()
  expect(files.has(`${LEDGER}/HANDOFF.md`)).toBe(false)

  await bar.press({ key: 'run-brief' })
  await harness.clock.settle()
  await settle()
  expect(harness.completions.length).toBe(13)
  expect(files.get(`${LEDGER}/HANDOFF.md`)).toContain('A long night of steps.')
  expect(await bar.find({ text: /Handoff written to/ })).toBeDefined()
  await bar.unmount()
})

test('a fresh start never holds a prompt', async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT })
  on('classic.SessionStart', () => ({}))
  await $.classic.SessionStart({ source: 'startup' })
  const sent = await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false })
  expect(sent.drop).toBeUndefined()
  expect(harness.prompts).toEqual(['hello'])
})

// ── Trim instead of summary compaction ────────────────────────────────────

const READ_TURN = (index: number, size: number) => [
  { role: 'user' as const, text: `prompt ${index}`, toolUses: [] },
  { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: `t${index}`, tool: 'Read', input: { file_path: `/dev/work/f${index}.ts` } }] },
  { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: `t${index}`, text: 'x'.repeat(size), isError: false }] },
  { role: 'assistant' as const, text: `answer ${index}`, toolUses: [] },
]

function trimStandIn(on: Parameters<typeof baseStandIn>[0], context: { tokens: number; window: number }) {
  const harness = baseStandIn(on, { root: ROOT })
  const { toasts } = harness
  const compactions: Array<{ trigger: string; isCore: boolean }> = []
  const usage = { isDown: false }
  const categories = [{ name: 'Messages', tokens: 200_000, color: 'inactive', isDeferred: false, kind: 'messages' }]
  // sidekick reads only the categories of a breakdown; the rest is the engine's.
  const breakdown = { categories } as Partial<SessionContextBreakdown> as SessionContextBreakdown
  on('session.usage', ($, e) =>
    usage.isDown
      ? { deny: 'usage unavailable' }
      : { value: { startedAt: 0, context: { ...context, ...(e?.breakdown ? { breakdown } : {}) }, rateLimits: [] } },
  )
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.compact', ($, e) => {
    compactions.push({ trigger: e.trigger, isCore: true })
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  return { harness, toasts, compactions, usage }
}

test('past 80%, a trim that gets to 50% or less replaces the summary', async ($, on) => {
  const { harness, toasts, compactions } = trimStandIn(on, { tokens: 170_000, window: 200_000 })
  const messages = [...READ_TURN(1, 200_000), ...READ_TURN(2, 200_000), ...READ_TURN(3, 1_000)]
  harness.messages.push(...(messages as never[]))
  // The built-in automatic compaction: trimmed instead, core never reached.
  const result = await $.session.compact({ trigger: 'auto', messages })
  expect(compactions.length).toBe(0)
  expect('messages' in result && result.messages?.length).toBe(messages.length)
  expect(toasts.some(text => text.startsWith('Trimmed 2 old tool outputs'))).toBe(true)
  // A /compact you run is yours.
  await $.session.compact({ trigger: 'manual', messages })
  expect(compactions).toEqual([{ trigger: 'manual', isCore: true }])
})

test('a trim that would only reach 70% leaves compaction to the engine', async ($, on) => {
  const { harness, toasts, compactions } = trimStandIn(on, { tokens: 170_000, window: 200_000 })
  const messages = [...READ_TURN(1, 120_000), ...READ_TURN(2, 1_000)]
  harness.messages.push(...(messages as never[]))
  await $.session.compact({ trigger: 'auto', messages })
  expect(compactions).toEqual([{ trigger: 'auto', isCore: true }])
  expect(toasts.length).toBe(0)
})

test('below the trim threshold, the automatic compaction is left alone', async ($, on) => {
  const { harness, toasts, compactions } = trimStandIn(on, { tokens: 150_000, window: 200_000 })
  const messages = [...READ_TURN(1, 400_000), ...READ_TURN(2, 1_000)]
  harness.messages.push(...(messages as never[]))
  await $.session.compact({ trigger: 'auto', messages })
  expect(compactions).toEqual([{ trigger: 'auto', isCore: true }])
  expect(toasts.length).toBe(0)
})

test('past 80% the bar offers a trim; /compact trim runs it, whatever it reaches', async ($, on) => {
  const { harness, toasts, compactions, usage } = trimStandIn(on, { tokens: 170_000, window: 200_000 })
  const messages = [...READ_TURN(1, 200_000), ...READ_TURN(2, 200_000), ...READ_TURN(3, 1_000)]
  harness.messages.push(...(messages as never[]))
  const measure = (tokens: number) => $.session.measure({ context: { tokens, window: 200_000, percent: Math.round(tokens / 2000) }, rateLimits: [], changed: ['context'] } as never)

  await measure(170_000)
  const bar = await mountBar($, 'desktop')
  expect(await bar.find({ text: /Trim → ~35%/ })).toBeDefined()
  await bar.press({ key: 'bar-trim' })
  expect(await bar.find({ text: /Context 85% full/ })).toBeDefined()
  await bar.press({ key: 'fill-trim' })
  expect(harness.filled[harness.filled.length - 1]).toBe('/compact trim')

  // You run it: trimmed, the summary never reached, the offer gone.
  await $.session.compact({ trigger: 'manual', instructions: 'trim', messages })
  expect(compactions.length).toBe(0)
  expect(toasts.some(text => text.startsWith('Trimmed 2 old tool outputs'))).toBe(true)
  expect(await bar.find({ text: /Trim →/ })).toBeUndefined()
  await bar.unmount()

  // Asked for, a trim runs even when it won't reach the target; with nothing stale it says so.
  const small = [...READ_TURN(1, 120_000), ...READ_TURN(2, 1_000)]
  expect('messages' in (await $.session.compact({ trigger: 'manual', instructions: 'trim', messages: small }))).toBe(true)
  expect(await $.session.compact({ trigger: 'manual', instructions: 'trim', messages: READ_TURN(1, 10) })).toMatchObject({ skip: expect.stringContaining('no old tool output') })
  // `trim all` takes the newest turn's output too: one long overnight turn.
  const overnight = READ_TURN(1, 300_000)
  expect(await $.session.compact({ trigger: 'manual', instructions: 'trim', messages: overnight })).toMatchObject({ skip: expect.stringContaining('no old tool output') })
  const all = await $.session.compact({ trigger: 'manual', instructions: 'trim all', messages: overnight })
  expect('messages' in all && all.messages?.[2]?.toolResults?.[0]?.text.startsWith('[trimmed by sidekick: Read')).toBe(true)
  expect('messages' in all && all.messages?.[3]?.text).toBe('answer 1')

  // A trim that fails never becomes a summary.
  usage.isDown = true
  expect(await $.session.compact({ trigger: 'manual', instructions: 'trim', messages })).toMatchObject({ skip: expect.stringContaining('the trim failed') })
  expect(compactions.length).toBe(0)

  usage.isDown = false

  // Under the threshold there's no offer.
  await measure(120_000)
  const quiet = await mountBar($, 'desktop')
  expect(await quiet.find({ text: /Trim →/ })).toBeUndefined()
  await quiet.unmount()
})

// ── Context readout and the council button ────────────────────────────────

test('the bar reads out the context after each turn; its panel breaks it down', async ($, on) => {
  const { harness } = trimStandIn(on, { tokens: 300_000, window: 1_000_000 })
  on('command.list', () => ({ value: [] }))
  const measure = (tokens: number) => $.session.measure({ context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) }, rateLimits: [], changed: ['context'] } as never)
  await measure(250_000)
  await $.turn.start({ text: 'read the whole api folder', turnId: 't1' })
  await measure(300_000)
  const bar = await mountBar($, 'desktop')
  expect(await bar.find({ text: /ctx 30% · \+50k/ })).toBeDefined()
  await bar.press({ key: 'bar-context' })
  await settle()
  expect(await bar.find({ text: /Context 30% full/ })).toBeDefined()
  expect(await bar.find({ text: /\+50k · read the whole api folder/ })).toBeDefined()
  expect(await bar.find({ text: /200k  Messages/ })).toBeDefined()
  // A turn ending while the panel is open reads the breakdown again.
  await measure(310_000)
  await settle()
  expect(await bar.find({ text: /reading the breakdown/ })).toBeUndefined()
  expect(await bar.find({ text: /200k  Messages/ })).toBeDefined()
  await bar.unmount()
  expect(harness.toasts.length).toBe(0)
})

test('with the council mod installed, the bar has a council button that fills the prompt', async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT })
  on('command.list', () => ({ value: [{ name: 'council', description: '', source: 'plugin' }] }))
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await settle()
  const bar = await mountBar($, 'desktop')
  await bar.press({ key: 'bar-council' })
  expect(await bar.find({ text: /Ask the council about this session/ })).toBeDefined()
  harness.draft.text = 'is the mono session a good idea?'
  await bar.press({ key: 'ask-council' })
  expect(harness.filled[harness.filled.length - 1]).toBe('/council is the mono session a good idea?')
  // The brain trust: the same draft behind /council deep.
  await bar.press({ key: 'bar-council' })
  harness.draft.text = '/council is the mono session a good idea?'
  await bar.press({ key: 'ask-brain-trust' })
  expect(harness.filled[harness.filled.length - 1]).toBe('/council deep is the mono session a good idea?')
  await bar.unmount()
})

test('without the council mod, there is no council button', async ($, on) => {
  baseStandIn(on, { root: ROOT })
  on('command.list', () => ({ value: [] }))
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await settle()
  const bar = await mountBar($, 'desktop')
  expect(await bar.find({ key: 'bar-council' })).toBeUndefined()
  await bar.unmount()
})

// ── Audit fixes ───────────────────────────────────────────────────────────

test('a session restores the scope it set', async ($, on) => {
  baseStandIn(on, { root: ROOT, store: { 'scope:session-1': { folders: [`${ROOT}/project`], savedAt: 1_000_000 } } })
  on('command.list', () => ({ value: [] }))
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await settle()
  const sibling = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/other/a.ts`, old_string: 'a', new_string: 'b' })
  expect(sibling.deny).toContain('outside the target folder')
})

test('a scope an earlier version inferred is not restored', async ($, on) => {
  baseStandIn(on, { root: ROOT, store: { 'scope:session-1': { folders: [`${ROOT}/project`], isInferred: true, savedAt: 1_000_000 } } })
  on('command.list', () => ({ value: [] }))
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await settle()
  const sibling = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/other/a.ts`, old_string: 'a', new_string: 'b' })
  expect(sibling.deny).toBeUndefined()
})

test('when the scope classifier cannot answer, an unclear command is blocked', async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT, complete: () => '', decide: () => 'allow' })
  on('fs.list', () => ({ value: [] }))
  await $.command.run(composer('scope', 'set project'))
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/project/a.ts`, old_string: 'a', new_string: 'b' })
  const unclear = await $.tool.call({ tool: 'Bash', command: './scripts/deploy.sh' })
  expect(unclear.deny).toContain('could not judge it')
  expect(harness.tools).toEqual(['Edit'])
})

test('/clear drops the old conversation from the bar', async ($, on) => {
  trimStandIn(on, { tokens: 300_000, window: 1_000_000 })
  on('command.list', () => ({ value: [] }))
  on('classic.SessionStart', () => ({}))
  await $.session.measure({ context: { tokens: 300_000, window: 1_000_000, percent: 30 }, rateLimits: [], changed: ['context'] } as never)
  let bar = await mountBar($, 'desktop')
  expect(await bar.find({ text: /ctx 30%/ })).toBeDefined()
  await bar.unmount()
  await $.classic.SessionStart({ source: 'clear' } as never)
  bar = await mountBar($, 'desktop')
  expect(await bar.find({ text: /ctx 30%/ })).toBeUndefined()
  await bar.unmount()
})

test("a council knight's Bash is held to its order's folder", async ($, on) => {
  baseStandIn(on, { root: ROOT, decide: () => 'allow' })
  on('command.list', () => ({ value: [{ name: 'council', description: '', source: 'plugin' }] }))
  // The council mod's court, as its state holds it; sidekick's own state as usual.
  // sidekick's contract types only its own keys, so the council's are compared as strings.
  on('state.get', ($, e, next) =>
    String(e.plugin) === 'council' && String(e.key) === 'court'
      ? { value: { value: { orders: [{ agentId: 'agent-1', status: 'dispatched', folder: `${ROOT}/project` }] }, version: 1 } }
      : next(e),
  )
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await settle()
  const outside = await $.tool.call({ tool: 'Bash', agentId: 'agent-1', command: 'rm -rf other/build' } as never)
  expect((outside as { deny?: string }).deny).toContain('outside the target folder')
  const inside = await $.tool.call({ tool: 'Bash', agentId: 'agent-1', command: 'rm -rf project/build' } as never)
  expect((inside as { deny?: string }).deny).toBeUndefined()
})

test("on Windows, a council knight edits inside its order's folder and nowhere else under the root", async ($, on) => {
  const WINDOWS_ROOT = 'C:\\claude\\workspace'
  baseStandIn(on, { root: WINDOWS_ROOT, decide: () => 'allow' })
  on('command.list', () => ({ value: [{ name: 'council', description: '', source: 'plugin' }] }))
  // The order's folder as the council writes it: the root, then a forward slash.
  on('state.get', ($, e, next) =>
    String(e.plugin) === 'council' && String(e.key) === 'court'
      ? { value: { value: { orders: [{ agentId: 'agent-1', status: 'dispatched', folder: `${WINDOWS_ROOT}/agent-host` }] }, version: 1 } }
      : next(e),
  )
  await $.session.start({ cwd: WINDOWS_ROOT, surface: 'desktop', isInteractive: true })
  await settle()
  const edit = (file_path: string) => $.tool.call({ tool: 'Edit', agentId: 'agent-1', file_path, old_string: 'a', new_string: 'b' } as never) as Promise<{ deny?: string }>
  const bash = (command: string) => $.tool.call({ tool: 'Bash', agentId: 'agent-1', command } as never) as Promise<{ deny?: string }>
  for (const inside of [
    'C:\\claude\\workspace\\agent-host\\docs\\build-prompt.md',
    'C:/claude/workspace/agent-host/docs/build-prompt.md',
    'c:\\claude\\workspace\\agent-host\\docs\\build-prompt.md',
    'C:\\claude/workspace\\agent-host/docs\\build-prompt.md',
    '/c/claude/workspace/agent-host/docs/build-prompt.md',
  ]) {
    expect((await edit(inside)).deny).toBeUndefined()
  }
  for (const outside of [
    'C:\\claude\\workspace\\castra\\README.md',
    'C:\\claude\\workspace\\agent-host2\\a.md',
    'C:\\claude\\workspace\\agent-host\\..\\castra\\a.md',
    'C:\\claude\\workspace\\CLAUDE.md',
    '\\\\localhost\\c$\\claude\\workspace\\castra\\a.md',
  ]) {
    expect((await edit(outside)).deny).toContain('sidekick scope guard')
  }
  // Outside the root: never policed.
  expect((await edit('D:\\scratch\\notes.md')).deny).toBeUndefined()
  expect((await bash("rm -rf 'C:\\claude\\workspace\\agent-host\\build'")).deny).toBeUndefined()
  expect((await bash('cd /c/claude/workspace/agent-host && rm -rf build')).deny).toBeUndefined()
  expect((await bash("rm -rf 'C:\\claude\\workspace\\castra\\build'")).deny).toContain('outside the target folder')
  expect((await bash('rm -rf /c/claude/workspace/castra/build')).deny).toContain('outside the target folder')
})
