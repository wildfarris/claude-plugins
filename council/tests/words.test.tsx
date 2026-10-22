// The person's own words: their main-session prompts recorded as typed
// (redacted, the last ten, for the session), the window a sitting Claude
// starts carries (consult, orders, an amendment and the arbiter), the
// members told whose words are whose, and the BEYOND line shown in the
// ruling, the court, the chamber and the docket.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Council, PersonWords } from '../types'
import { advisorPrompt, beyondOf, beyondText, newCouncil, parseVerdict, reconsiderPrompt, withVerdict, withAdvisorsDeliberating } from '../hooks/council'
import { formatEntry, parseDocket, parseDocketLine, projectKey, sealEntry, sittingFields } from '../hooks/docket'
import { ruling, rulingText } from '../hooks/court'
import { REDACTED } from '../hooks/redact'
import { BEYOND_ASK, WORDS_INSTRUCTION, WORDS_LIMITS, emptyWords, parseBeyond, tailOf, withAnswerRecorded, withPromptRecorded, wordsBlock, wordsWindow } from '../hooks/words'
import { baseStandIn, composer, presentation, settle, testPath } from './stand-in'

const ROOT = '/dev/work'
const HOME = '/home/me'
const NOW = Date.parse('2026-10-22T10:00:00.000Z')
const FOLDER = `${HOME}/.claude/council/docket/${projectKey(ROOT)}`
const PANE = { title: 'The Council', isFocused: false, bodyColumns: 100, bodyRows: 40 }
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const DIRS = ['api', 'web']
const KEY = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'

const recorded = (...texts: string[]) => texts.reduce((words, text) => withPromptRecorded(words, text), emptyWords())
const letters = (count: number, letter = 'a') => letter.repeat(count)

// ── Recording and the window (pure) ───────────────────────────────────────

describe('recording', () => {
  test('a prompt is kept as typed, redacted; the last ten stay', () => {
    const words = recorded(`Deploy with ${KEY} please`)
    expect(words.prompts).toEqual([{ text: `Deploy with ${REDACTED} please` }])
    const many = recorded(...Array.from({ length: 12 }, (_, index) => `prompt number ${index + 1}, long enough to be no short reply`))
    expect(many.prompts.length).toBe(WORDS_LIMITS.kept)
    expect(many.prompts[0]!.text).toContain('prompt number 3,')
    expect(many.prompts[9]!.text).toContain('prompt number 12,')
    expect(recorded('   ').prompts).toEqual([])
  })

  test('a long prompt keeps its end (no window holds more); a short one keeps the answer it followed', () => {
    const long = recorded(`${letters(3000)}END`).prompts[0]!.text
    expect(long.length).toBe(WORDS_LIMITS.cap)
    expect(long.startsWith('…')).toBe(true)
    expect(long.endsWith('END')).toBe(true)
    let words = withAnswerRecorded(emptyWords(), `${letters(1000, 'x')} Shall I migrate the database?`)
    expect(words.answer!.length).toBe(WORDS_LIMITS.answer)
    expect(words.answer!.endsWith('Shall I migrate the database?')).toBe(true)
    words = withPromptRecorded(words, 'do it')
    expect(words.prompts[0]).toEqual({ text: 'do it', answered: words.answer })
    // A prompt of 40 characters or more takes no answer; an empty answer leaves the last one.
    words = withPromptRecorded(words, 'Please migrate the database and keep a backup first.')
    expect(words.prompts[1]!.answered).toBeUndefined()
    expect(withAnswerRecorded(words, '  ').answer).toBe(words.answer)
    expect(withAnswerRecorded(emptyWords(), `token=${KEY}`).answer).toBe(`token=${REDACTED}`)
  })
})

describe('the window', () => {
  test('nothing recorded: no window', () => {
    expect(wordsWindow(emptyWords())).toBeUndefined()
    expect(wordsWindow(undefined)).toBeUndefined()
  })

  test('the latest prompts, newest first, until three of them', () => {
    const words = recorded('one first prompt here', 'two second prompt here', 'three third prompt here', 'four fourth prompt here')
    expect(wordsWindow(words)).toEqual({ prompts: ['two second prompt here', 'three third prompt here', 'four fourth prompt here'] })
  })

  test('or until 600 characters, whichever comes first; the latest is always in', () => {
    const words = recorded(letters(100, 'o'), letters(550, 'p'), letters(100, 'q'))
    // 100 (q), then 550 (p) reaches 600: o is left out.
    expect(wordsWindow(words)!.prompts).toEqual([letters(550, 'p'), letters(100, 'q')])
    expect(wordsWindow(recorded(letters(100, 'o'), letters(700, 'z')))!.prompts).toEqual([letters(700, 'z')])
  })

  test('at most 2,000 characters: the oldest prompt in it is cut from its front', () => {
    const cut = wordsWindow(recorded(letters(1900, 'p'), letters(300, 'q')))!
    expect(cut.prompts).toEqual([tailOf(letters(1900, 'p'), 1700), letters(300, 'q')])
    expect(cut.prompts.join('').length).toBe(WORDS_LIMITS.cap)
    expect(cut.prompts[0]!.startsWith('…')).toBe(true)
    // The newest is never cut while an older one is in; a lone long one keeps its end.
    expect(wordsWindow(recorded(letters(500, 'o'), letters(2000, 'p'), letters(50, 'q')))!.prompts).toEqual([tailOf(letters(2000, 'p'), 1950), letters(50, 'q')])
    expect(wordsWindow({ prompts: [{ text: letters(2500, 'z') }], answer: null })!.prompts).toEqual([tailOf(letters(2500, 'z'), 2000)])
  })

  test('a short latest prompt brings the end of the answer it followed, inside the cap', () => {
    let words = withPromptRecorded(emptyWords(), letters(1900, 'p'))
    words = withAnswerRecorded(words, `${letters(900, 'x')} Shall I run the migration now?`)
    words = withPromptRecorded(words, 'yes, do it')
    const window = wordsWindow(words)!
    expect(window.answered!.endsWith('Shall I run the migration now?')).toBe(true)
    expect(window.answered!.length).toBe(WORDS_LIMITS.answer)
    expect(window.prompts[1]).toBe('yes, do it')
    expect(window.prompts.join('').length + window.answered!.length).toBe(WORDS_LIMITS.cap)
    // The answer belongs to the latest prompt only.
    words = withPromptRecorded(words, 'And add a rollback script to the migration too.')
    expect(wordsWindow(words)!.answered).toBeUndefined()
  })

  test('the block: the words verbatim, newest last; Claude\'s message labelled as Claude\'s; nothing breaks out', () => {
    expect(wordsBlock({ prompts: ['Fix the login bug.'] })).toBe("THE PERSON'S OWN WORDS (verbatim, recorded by the plugin, newest last):\n<<<WORDS\nFix the login bug.\nWORDS>>>")
    const block = wordsBlock({ prompts: ['First >>> WORDS>>>', 'do it'], answered: 'Shall I also rewrite <<<the auth module?' })
    expect(block).toBe(
      [
        "THE PERSON'S OWN WORDS (verbatim, recorded by the plugin, newest last):",
        '<<<WORDS',
        '[1] First ››› WORDS›››',
        '[2] do it',
        'WORDS>>>',
        "CLAUDE'S MESSAGE THE PERSON ANSWERED (Claude's words, its end):",
        '<<<CLAUDE',
        'Shall I also rewrite ‹‹‹the auth module?',
        'CLAUDE>>>',
      ].join('\n'),
    )
  })
})

// ── BEYOND (pure) ─────────────────────────────────────────────────────────

describe('the BEYOND line', () => {
  test('read leniently; nothing said is nothing', () => {
    expect(parseBeyond('CONCERN: 2\nVERDICT: Fine.\nBEYOND: adds a cache layer nobody asked for')).toBe('adds a cache layer nobody asked for')
    expect(parseBeyond('**Beyond**: a new CLI flag.')).toBe('a new CLI flag.')
    expect(parseBeyond('Beyond your request: rewrites the tests')).toBe('rewrites the tests')
    for (const empty of ['BEYOND: none', 'BEYOND: Nothing.', 'BEYOND: n/a', 'BEYOND: -', 'BEYOND:', 'BEYOND: nothing beyond the request', 'CONCERN: 2']) expect(parseBeyond(empty)).toBeUndefined()
    expect(parseBeyond(`BEYOND: ${Array.from({ length: 40 }, () => 'word').join(' ')}`)!.split(' ').length).toBe(30)
  })

  test('it ends the DETAIL and rides on the verdict; a new answer replaces it', () => {
    const verdict = parseVerdict('CONCERN: 3\nVERDICT: Too wide.\nDETAIL: Two changes in one.\nBEYOND: also renames the API\nLEVEL 1: 2')
    expect(verdict).toMatchObject({ concern: 3, detail: 'Two changes in one.', beyond: 'also renames the API' })
    let council: Council = withAdvisorsDeliberating(newCouncil('t'), 'b')
    council = withVerdict(council, 'seneschal', 'CONCERN: 3\nVERDICT: Too wide.\nBEYOND: also renames the API')
    expect(council.advisors.seneschal!.beyond).toBe('also renames the API')
    council = withVerdict(council, 'seneschal', 'CONCERN: 2\nVERDICT: Fine now.')
    expect(council.advisors.seneschal!.beyond).toBeUndefined()
  })

  test('identical lines merge, the members named; at most three; none without one', () => {
    let council: Council = withAdvisorsDeliberating(newCouncil('t'), 'b')
    council = withVerdict(council, 'castellan', 'CONCERN: 2\nVERDICT: Fine.\nBEYOND: Adds a cache layer.')
    council = withVerdict(council, 'seneschal', 'CONCERN: 3\nVERDICT: Wide.\nBEYOND: adds a cache layer')
    council = withVerdict(council, 'treasurer', 'CONCERN: 2\nVERDICT: Fine.\nBEYOND: a paid plan')
    council = withVerdict(council, 'justiciar', 'CONCERN: 1\nVERDICT: Fine.\nBEYOND: a new license')
    council = withVerdict(council, 'jester', 'CONCERN: 1\nVERDICT: Fine.\nBEYOND: a dark mode')
    expect(beyondOf(council)).toEqual([
      { text: 'Adds a cache layer.', by: ['Castellan', 'Seneschal'] },
      { text: 'a paid plan', by: ['Lord Treasurer'] },
      { text: 'a new license', by: ['High Justiciar'] },
    ])
    expect(beyondText(beyondOf(council)[0]!)).toBe('Beyond your request (per Castellan, Seneschal): Adds a cache layer.')
    const result = ruling(council, 'p')
    expect(result.beyond).toHaveLength(3)
    const text = rulingText(result, [])
    expect(text).toContain('Beyond your request (per Castellan, Seneschal): Adds a cache layer.')
    // Without any BEYOND line, the ruling says nothing of it.
    let plain: Council = withAdvisorsDeliberating(newCouncil('t'), 'b')
    for (const id of ['castellan', 'treasurer', 'seneschal', 'justiciar', 'jester']) plain = withVerdict(plain, id, 'CONCERN: 2\nVERDICT: Fine.')
    expect(ruling(plain, 'p').beyond).toBeUndefined()
    expect(rulingText(ruling(plain, 'p'), [])).not.toContain('Beyond')
  })
})

describe("members' prompts", () => {
  test('without words, the prompt is the plain one, unchanged', () => {
    expect(advisorPrompt('Topic.', 'The brief.')).toBe("TOPIC:\nTopic.\n\nTHE HERALD'S BRIEF:\nThe brief.\n\nGive your three lines.")
    expect(advisorPrompt('Topic.', 'The brief.', undefined, 'LEVEL ask')).toBe("TOPIC:\nTopic.\n\nTHE HERALD'S BRIEF:\nThe brief.\n\nGive your three lines.\n\nLEVEL ask")
    const council = withVerdict(withAdvisorsDeliberating(newCouncil('Topic.'), 'The brief.'), 'castellan', 'CONCERN: 2\nVERDICT: Fine.')
    const again = reconsiderPrompt({ ...council, context: ['More.'] }, council.advisors.castellan!)
    expect(again).toContain("TOPIC:\nTopic.\n\nTHE HERALD'S BRIEF:\nThe brief.")
    expect(again).not.toContain('WORDS')
    expect(again).not.toContain('BEYOND')
  })

  test("with words: the person's words, Claude's request labelled as Claude's, whose words are whose, and the BEYOND ask", () => {
    const prompt = advisorPrompt('Orders: Rewrite auth.', 'Claude proposes: Rewrite auth.', undefined, 'LEVEL ask', { prompts: ['Fix the login bug.'] })
    expect(prompt).toBe(
      [
        "TOPIC (Claude's words):\nOrders: Rewrite auth.",
        "THE PERSON'S OWN WORDS (verbatim, recorded by the plugin, newest last):\n<<<WORDS\nFix the login bug.\nWORDS>>>",
        "CLAUDE'S REQUEST (Claude's words, not the person's):\nClaude proposes: Rewrite auth.",
        WORDS_INSTRUCTION,
        'Give your three lines.',
        'LEVEL ask',
        BEYOND_ASK,
      ].join('\n\n'),
    )
  })
})

describe('the docket', () => {
  test("a sitting with words records them and the merged BEYOND, redacted and capped; one without records neither", () => {
    let council: Council = { ...withAdvisorsDeliberating(newCouncil('t'), 'b'), words: { prompts: [`use token=${KEY}`, letters(2500, 'z')], answered: 'Shall I?' } }
    council = withVerdict(council, 'seneschal', `CONCERN: 3\nVERDICT: Wide.\nBEYOND: adds password=${KEY}`)
    const fields = sittingFields(council)
    expect(fields.beyond).toEqual([{ text: `adds password=${KEY}`, by: ['Seneschal'] }])
    const sealed = sealEntry({ v: 1, id: 'e1', time: new Date(NOW).toISOString(), kind: 'orders', session: 's', project: ROOT, outcome: 'approved', ...fields })
    expect(sealed.words!.prompts[0]).toBe(`use token=${REDACTED}`)
    expect(sealed.words!.prompts[1]!.length).toBe(2000)
    expect(sealed.words!.answered).toBe('Shall I?')
    expect(sealed.beyond).toEqual([{ text: `adds password=${REDACTED}`, by: ['Seneschal'] }])
    expect(parseDocketLine(formatEntry(sealed))).toMatchObject({ words: sealed.words, beyond: sealed.beyond })
    const plain = sittingFields(withAdvisorsDeliberating(newCouncil('t'), 'b'))
    expect(plain.words).toBeUndefined()
    expect(plain.beyond).toBeUndefined()
  })
})

// ── Through the hooks ─────────────────────────────────────────────────────

type Spawn = { subagentType: string; description: string; prompt: string; model?: string }

function standIn(on: On, options: { verdict?: (system: string, prompt: string) => string; arbiter?: (prompt: string) => string } = {}) {
  const files = new Map<string, string>()
  const spawned: Spawn[] = []
  const harness = baseStandIn(on, {
    root: ROOT,
    complete: ({ system, prompt }) =>
      system.includes('You sort a person')
        ? 'COUNCIL'
        : system.includes('CONDITIONS TO REVIEW')
          ? (options.arbiter?.(prompt) ?? 'NONE')
          : (options.verdict?.(system, prompt) ?? 'CONCERN: 2\nVERDICT: Reasonable.\nDETAIL: Scoped well.'),
  })
  mock.env(on, { HOME })
  on('fs.stat', ($, e) => (DIRS.some(folder => testPath(e.path) === `${ROOT}/${folder}`) ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: files.has(testPath(e.path)) }))
  on('fs.read', ($, e) => (files.has(testPath(e.path)) ? { value: files.get(testPath(e.path))! } : { deny: 'no such file' }))
  on('fs.write', ($, e) => {
    files.set(testPath(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const prefix = `${testPath(e.path)}/`
    const names = [...files.keys()].filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    return names.length === 0 ? { deny: 'no such directory' } : { value: names.map(path => ({ name: path.slice(prefix.length), kind: 'file', size: files.get(path)!.length, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.fork', () => ({ value: { isAnswered: true, text: 'The person wants work done.', usage: USAGE } }))
  on('agent.spawn', ($, e) => {
    const input = e as unknown as Spawn
    const subagentType = input.subagentType ?? (input as unknown as { subagent_type: string }).subagent_type
    spawned.push({ ...input, subagentType })
    return { model: input.model ?? 'inherit', agentId: `agent-${spawned.length}` }
  })
  on('agent.list', () => ({ value: spawned.map((_, index) => ({ id: `agent-${index + 1}`, status: 'running', description: '', type: 'x' })) }) as never)
  on('session.send', () => ({ isDelivered: true }))
  return Object.assign(harness, { files, spawned })
}

const start = async ($: Engine, harness: { clock: { set: (ms: number) => Promise<void> } }) => {
  await harness.clock.set(NOW)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
}
const say = ($: Engine, text: string, origin: Record<string, unknown> = { kind: 'composer' }, extra: Record<string, unknown> = {}) => $.prompt.submit({ text, origin, ...extra } as never)
const answer = ($: Engine, text: string, agentId?: string) => $.turn.complete({ answer: text, durationMs: 1, isAborted: false, turnId: 'm', reason: 'answer', ...(agentId ? { agentId } : {}) } as never)
const text = (result: unknown) => String((result as { result?: unknown }).result ?? (result as { deny?: unknown }).deny)
const consult = ($: Engine) => $.tool.call({ tool: 'mcp__council__consult', question: 'Which cache?', context: 'Claude says the person wants a cache layer too.' } as never)
const propose = ($: Engine, plan = 'Fix the login bug and rewrite auth.') =>
  $.tool.call({ tool: 'mcp__council__propose_orders', plan, dispatches: [{ folder: 'api', role: 'knight', task: 'Fix it.', todos: ['Do it'] }] } as never)
const memberCalls = (harness: { completions: Array<{ system: string; prompt: string }> }) => harness.completions.filter(call => call.system.startsWith('You are The') && !call.system.includes('CONDITIONS TO REVIEW'))
const arbiterCalls = (harness: { completions: Array<{ system: string; prompt: string }> }) => harness.completions.filter(call => call.system.includes('CONDITIONS TO REVIEW'))
const written = (files: Map<string, string>) => [...files.entries()].filter(([path]) => path.startsWith(`${FOLDER}/`) && path.endsWith('.jsonl')).flatMap(([, body]) => parseDocket(body))
const until = async (harness: { clock: { advance: (ms: number) => Promise<void> } }, isDone: () => boolean, tries = 60) => {
  for (let attempt = 0; attempt < tries && !isDone(); attempt++) {
    await harness.clock.advance(50)
    await settle()
  }
}
const WORDS_HEAD = "THE PERSON'S OWN WORDS (verbatim, recorded by the plugin, newest last):"

test("only the person's typed main-session prompts are recorded; a sitting carries them, and nothing when none were", async ($, on) => {
  const harness = standIn(on)
  await start($, harness)
  // Nothing recorded yet: the consult's prompts carry no words and no instruction.
  await consult($)
  expect(memberCalls(harness).length).toBe(5)
  expect(memberCalls(harness).every(call => !call.prompt.includes('WORDS') && !call.prompt.includes('BEYOND') && call.prompt.includes("THE HERALD'S BRIEF:"))).toBe(true)
  harness.completions.length = 0

  await say($, `Fix the login bug, the key is ${KEY}`)
  // Not the person's: a plugin's, a peer's, a hidden row, a command, a slash line, a subagent's.
  await say($, 'A plugin wrote this.', { kind: 'plugin', name: 'other' })
  await say($, 'A peer wrote this.', { kind: 'peer' })
  await say($, 'A hidden row.', { kind: 'composer' }, { isMeta: true })
  await say($, '/council docket')
  await say($, 'Run the review skill.', { kind: 'composer' }, { command: { name: 'review' } })
  await say($, 'A subagent prompt.', { kind: 'composer' }, { agentId: 'agent-9' })
  await consult($)
  const prompt = memberCalls(harness)[0]!.prompt
  expect(prompt).toContain(`${WORDS_HEAD}\n<<<WORDS\nFix the login bug, the key is ${REDACTED}\nWORDS>>>`)
  expect(prompt).toContain("CLAUDE'S REQUEST (Claude's words, not the person's):\nClaude says the person wants a cache layer too.")
  expect(prompt).toContain(WORDS_INSTRUCTION)
  expect(prompt).toContain(BEYOND_ASK)
  for (const other of ['A plugin wrote', 'A peer wrote', 'A hidden row', '/council', 'review skill', 'A subagent']) expect(prompt).not.toContain(other)
  // Through Remote Control counts as the person's own.
  await say($, 'From my phone: keep it small.', { kind: 'bridge' })
  harness.completions.length = 0
  await consult($)
  expect(memberCalls(harness)[0]!.prompt).toContain('[2] From my phone: keep it small.')
})

test("a short prompt brings the end of Claude's message it answered; a subagent's answer is never recorded", async ($, on) => {
  const harness = standIn(on, { verdict: (system, prompt) => (system.includes('You are The Seneschal') && prompt.includes('<<<WORDS') ? 'CONCERN: 2\nVERDICT: Fine.\nBEYOND: a cache layer' : 'CONCERN: 1\nVERDICT: Fine.') })
  await start($, harness)
  await answer($, 'I found the bug. Shall I also rewrite the whole auth module while I am at it?')
  await answer($, 'A subagent report.', 'agent-3')
  await say($, 'do it')
  const advice = text(await consult($))
  const prompt = memberCalls(harness)[0]!.prompt
  expect(prompt).toContain("CLAUDE'S MESSAGE THE PERSON ANSWERED (Claude's words, its end):\n<<<CLAUDE\nI found the bug. Shall I also rewrite the whole auth module while I am at it?\nCLAUDE>>>")
  expect(prompt).not.toContain('A subagent report.')
  // The consult's answer and its chamber show what goes beyond.
  expect(advice).toContain('Beyond your request (per Seneschal): a cache layer')
  const pane = await $.ui.mount({ plugin: 'council', surface: 'desktop', component: 'Pane', requestId: 'council-chamber', props: PANE })
  expect(await pane.find({ text: /^Beyond your request \(per Seneschal\): a cache layer$/ })).toBeDefined()
  await pane.unmount()
})

test('/council forget-words clears them; only the person can', async ($, on) => {
  const harness = standIn(on)
  await start($, harness)
  await say($, 'Fix the login bug in the api folder, nothing else.')
  expect(String((await $.command.run({ command: 'council', args: 'forget-words', origin: { kind: 'sdk' }, presentation } as never)).text)).toContain('Only the person')
  await consult($)
  expect(memberCalls(harness)[0]!.prompt).toContain('Fix the login bug')
  harness.completions.length = 0
  expect(String((await $.command.run(composer('council', 'forget-words'))).text)).toContain('forgot 1 prompt of yours')
  await consult($)
  expect(memberCalls(harness)[0]!.prompt).not.toContain('WORDS')
  expect(String((await $.command.run(composer('council', 'forget-words'))).text)).toContain('none of your words')
})

// A reload: the module starts over; the words in $.state stay.
let savedWords: unknown

function wordsStore(on: On, record: (words: unknown) => void, saved?: unknown) {
  let isWritten = false
  if (saved !== undefined) {
    on('state.get', async ($, e, next) => {
      const result = (await next(e)) as { value?: { value?: unknown; version: number } }
      if (isWritten || (e as { key?: string }).key !== 'words' || result.value?.value !== undefined) return result as never
      return { value: { value: saved, version: result.value?.version ?? 0 } } as never
    })
  }
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'words') {
      isWritten = true
      record((e as { value?: unknown }).value)
    }
    return next(e)
  })
}

test('before a reload: the prompts are recorded in session state', async ($, on) => {
  const harness = standIn(on)
  wordsStore(on, words => (savedWords = words))
  await start($, harness)
  await say($, 'Only fix the login bug; do not touch the billing code.')
  expect((savedWords as PersonWords).prompts).toEqual([{ text: 'Only fix the login bug; do not touch the billing code.' }])
})

test('after a reload: a sitting still carries them', async ($, on) => {
  expect(savedWords).toBeDefined()
  const harness = standIn(on)
  wordsStore(on, () => undefined, savedWords)
  await start($, harness)
  await propose($)
  expect(memberCalls(harness)[0]!.prompt).toContain('<<<WORDS\nOnly fix the login bug; do not touch the billing code.\nWORDS>>>')
})

test('orders and an amendment carry the words in place of the old petition; the arbiter reads them too', { options: { arbiter: 'jester' } }, async ($, on) => {
  const harness = standIn(on, {
    verdict: (system, prompt) =>
      system.includes('You are The Seneschal')
        ? `CONCERN: 3\nVERDICT: Wider than asked.\nDETAIL: The auth rewrite was not asked.${prompt.includes('<<<WORDS') ? '\nBEYOND: rewrites the auth module and the session store, migrates every stored token to the new format, and renames the login routes across the whole API surface' : ''}`
        : 'CONCERN: 2\nVERDICT: Fine.',
    arbiter: () => '{"decisions":[{"index":1,"keep":true,"reason":"Warranted."}]}',
  })
  await start($, harness)
  // Court mode's petition is no longer carried into a later proposal: the words are, as typed.
  await $.command.run(composer('council', 'court on'))
  await say($, 'Fix the login bug.')
  await $.command.run(composer('council', 'court off'))
  harness.completions.length = 0
  const ruled = text(await propose($))
  const members = memberCalls(harness)
  expect(members.length).toBe(5)
  expect(members.every(call => call.prompt.includes('<<<WORDS\nFix the login bug.\nWORDS>>>'))).toBe(true)
  expect(members.every(call => !call.prompt.includes('The person asked:'))).toBe(true)
  expect(members[0]!.prompt).toContain("CLAUDE'S REQUEST (Claude's words, not the person's):\nClaude proposes: Fix the login bug and rewrite auth.")
  // The arbiter reads the same words.
  expect(arbiterCalls(harness)[0]!.prompt).toContain('<<<WORDS\nFix the login bug.\nWORDS>>>')
  expect(arbiterCalls(harness)[0]!.prompt).not.toContain('REQUEST>>>')
  // Claude is told what goes beyond, once.
  expect(ruled).toContain('Beyond your request (per Seneschal): rewrites the auth module and the session store, migrates every stored token to the new format, and renames the login routes across the whole API surface')
  expect(ruled.split('Beyond your request').length).toBe(2)

  // The court shows it under the latest ruling.
  let pane = await $.ui.mount({ plugin: 'council', surface: 'desktop', component: 'Pane', requestId: 'council-chamber', props: PANE })
  expect(await pane.find({ text: /· Beyond your request \(per Seneschal\): rewrites the auth module and the session store, migrates every stored token to the new format, and renames the login routes across the whole API surface/ })).toBeDefined()
  await pane.unmount()

  // An amendment carries them too.
  expect((await $.agent.spawn({ subagentType: 'council:knight', description: 'O1 api', prompt: 'Do it.' } as never) as { agentId?: string }).agentId).toBe('agent-1')
  await say($, 'Also fix the logout button while you are in there.')
  harness.completions.length = 0
  const amended = text(await $.tool.call({ tool: 'mcp__council__amend_order', id: 'O1', change: 'Also fix logout and add SSO.', reason: 'The person asked.' } as never))
  expect(memberCalls(harness)[0]!.prompt).toContain('<<<WORDS\n[1] Fix the login bug.\n[2] Also fix the logout button while you are in there.\nWORDS>>>')
  expect(memberCalls(harness)[0]!.prompt).not.toContain('The person asked:')
  expect(amended).toContain('Beyond your request (per Seneschal): rewrites the auth module and the session store, migrates every stored token to the new format, and renames the login routes across the whole API surface')

  // The docket keeps the words and the BEYOND line of each sitting that carried them.
  await until(harness, () => written(harness.files).filter(entry => entry.kind === 'orders' || entry.kind === 'amendment').length === 2)
  const orders = written(harness.files).find(entry => entry.kind === 'orders')!
  expect(orders.words).toEqual({ prompts: ['Fix the login bug.'] })
  expect(orders.beyond).toEqual([{ text: 'rewrites the auth module and the session store, migrates every stored token to the new format, and renames the login routes across the whole API surface', by: ['Seneschal'] }])
  const court = written(harness.files).find(entry => entry.kind === 'court')!
  expect(court.words).toBeUndefined()
  // And the docket view shows them.
  await $.command.run(composer('council', 'docket'))
  pane = await $.ui.mount({ plugin: 'council', surface: 'desktop', component: 'Pane', requestId: 'council-chamber', props: PANE })
  await pane.press({ key: `docket-entry-${orders.id}` })
  expect(await pane.find({ text: /^Your words$/ })).toBeDefined()
  expect(await pane.find({ text: /Beyond your request \(per Seneschal\): rewrites the auth module and the session store, migrates every stored token to the new format, and renames the login routes across the whole API surface/ })).toBeDefined()
  await pane.unmount()
})

test('a ruling with no BEYOND line says nothing of it, to Claude or in the court', async ($, on) => {
  const harness = standIn(on)
  await start($, harness)
  const plain = text(await propose($))
  expect(plain).not.toContain('Beyond')
  const pane = await $.ui.mount({ plugin: 'council', surface: 'desktop', component: 'Pane', requestId: 'council-chamber', props: PANE })
  expect(await pane.find({ text: /Beyond your request/ })).toBeUndefined()
  await pane.unmount()
})
