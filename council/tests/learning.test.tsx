import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { newCouncil, withAdvisorsDeliberating, withReconsidering, withVerdict } from '../hooks/council'
import {
  EVERYWHERE,
  formatProposal,
  isSummaryDue,
  lessonFromReconsider,
  mergeGuidance,
  parseGuidance,
  parseProposal,
  parseSummary,
  scrubSecrets,
  standingContext,
} from '../hooks/learning'
import { BUILT_IN_SEATS } from '../hooks/members'
import type { Lesson } from '../types'
import { baseStandIn, composer, settle } from './stand-in'

const ROOT = '/dev/game'
const HOME = '/home/me'
const LEARNING = `${HOME}/.claude/council/learning`
const PANE = { title: 'The Council', isFocused: false, bodyColumns: 100, bodyRows: 40 }

const lesson = (id: string, project = ROOT, added = 'It is a local game; security barely matters.'): Lesson => ({ id, project, at: '2026-10-09T00:00:00.000Z', topic: 'Add multiplayer?', added, moves: ['Castellan 4→2'] })

describe('lessons', () => {
  test('a finished reconsider becomes a lesson in the person\'s words, with who moved', () => {
    let council = withAdvisorsDeliberating(newCouncil('Add online play?'), 'A brief.')
    for (const seat of BUILT_IN_SEATS) council = withVerdict(council, seat.id, `CONCERN: ${seat.id === 'castellan' ? 4 : 2}\nVERDICT: Hm.`)
    council = withReconsidering(council, 'It runs on my LAN only. password=hunter2')
    for (const seat of BUILT_IN_SEATS) council = withVerdict(council, seat.id, 'CONCERN: 2\nVERDICT: Fine.')
    const entry = lessonFromReconsider(council, ROOT, '2026-10-09T00:00:00.000Z', 'l1', true)!
    expect(entry.added).toBe('It runs on my LAN only. password=[redacted]')
    expect(entry.moves).toContain('Castellan 4→2')
    expect(entry.moves).toContain('Treasurer held at 2')
    expect(lessonFromReconsider(council, ROOT, '', 'l2', false)!.topic).toBeNull()
  })

  test('secrets are scrubbed', () => {
    expect(scrubSecrets('key sk-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz12')).toBe('key [redacted] and [redacted]')
  })

  test("advisors get guidance for everywhere and this project, and only this project's lessons", () => {
    const guidance = parseGuidance(`## Everywhere\n- Prefers Go.\n\n## ${ROOT}\n- Local only.\n\n## /dev/bank\n- Strict audits.\n`)
    const text = standingContext(guidance, [lesson('a'), lesson('b', '/dev/bank', 'Client data here.')], ROOT)!
    expect(text).toContain('never lowers a concern about security')
    expect(text).toContain('- Prefers Go.')
    expect(text).toContain('- Local only. (this project)')
    expect(text).toContain('security barely matters')
    expect(text).not.toContain('Strict audits')
    expect(text).not.toContain('Client data')
    expect(standingContext([], [], ROOT)).toBeNull()
  })

  test('summaries: due at ten, five more after a rejection; drafts keep scope; approval merges', () => {
    const ten = Array.from({ length: 10 }, (_, index) => lesson(`l${index}`))
    expect(isSummaryDue(ten.slice(0, 9), ROOT, undefined)).toBe(false)
    expect(isSummaryDue(ten, ROOT, undefined)).toBe(true)
    expect(isSummaryDue(ten, ROOT, 10)).toBe(false)
    const draft = parseSummary('EVERYWHERE: Prefers Go.\nPROJECT: Security concerns are low for this LAN-only game.\nnoise')
    const file = formatProposal(ROOT, draft, ['l1', 'l2'])
    const proposal = parseProposal(file.replace('Prefers Go.', 'Prefers Go for services.'))!
    expect(proposal.covers).toEqual(['l1', 'l2'])
    expect(proposal.guidance).toEqual([
      { scope: EVERYWHERE, items: ['Prefers Go for services.'] },
      { scope: ROOT, items: ['Security concerns are low for this LAN-only game.'] },
    ])
    expect(mergeGuidance([{ scope: EVERYWHERE, items: ['Prefers Go for services.'] }], proposal.guidance)).toEqual(proposal.guidance)
  })
})

function learningStandIn(on: On, files: Map<string, string>) {
  const harness = baseStandIn(on, {
    root: ROOT,
    complete: ({ system }) =>
      system.includes('You distill')
        ? 'PROJECT: Security matters little in this LAN-only game.\nEVERYWHERE: Prefers Go.'
        : 'CONCERN: 2\nVERDICT: Fine.\nDETAIL: Ok.',
  })
  on('process.run', ($, e) => (e.argv[0] === 'printenv' ? { value: { exitCode: 0, stdout: `${HOME}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } : { deny: 'no' }))
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path)! } : { deny: 'no such file' }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ deny: 'no such directory' }))
  on('model.fork', () => ({ value: { isAnswered: true, text: 'Should the game get online play?', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }))
  return harness
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
const run = ($: Engine, args: string) => $.command.run(composer('council', args))
const mountPane = ($: Engine) => $.ui.mount({ plugin: 'council', surface: 'desktop', component: 'Pane', requestId: 'council-chamber', props: PANE })

test('a reconsider is logged; the next council hears it; the tenth drafts a summary to approve', async ($, on) => {
  const files = new Map<string, string>([[`${LEARNING}/lessons.json`, JSON.stringify(Array.from({ length: 8 }, (_, index) => lesson(`old${index}`)))]])
  const harness = learningStandIn(on, files)
  await start($)

  await run($, 'Add online play?')
  await settle()
  await run($, 'reconsider It only runs on my LAN.')
  await settle()
  const lessons = JSON.parse(files.get(`${LEARNING}/lessons.json`)!) as Lesson[]
  expect(lessons.length).toBe(9)
  expect(lessons[8]).toMatchObject({ project: ROOT, topic: 'Add online play?', added: 'It only runs on my LAN.' })
  expect(files.get(`${LEARNING}/proposed-guidance.md`) ?? '').toBe('')

  // The next council's advisors hear it.
  harness.completions.length = 0
  await run($, 'Add a leaderboard?')
  await settle()
  expect(harness.completions.every(call => call.system.includes('they added "It only runs on my LAN."'))).toBe(true)

  // The tenth lesson drafts a summary; approving it moves it into the guidance.
  await run($, 'reconsider Still LAN only.')
  await settle()
  expect(files.get(`${LEARNING}/proposed-guidance.md`)).toContain('Security matters little in this LAN-only game.')
  expect(harness.toasts.some(text => text.includes('ready for you to approve'))).toBe(true)
  await run($, 'lessons')
  const pane = await mountPane($)
  expect(await pane.find({ text: /A summary is waiting for you/ })).toBeDefined()
  await pane.press({ key: 'approve-summary' })
  expect(files.get(`${LEARNING}/guidance.md`)).toContain(`## ${ROOT}\n- Security matters little in this LAN-only game.`)
  expect(files.get(`${LEARNING}/guidance.md`)).toContain('## Everywhere\n- Prefers Go.')
  expect(JSON.parse(files.get(`${LEARNING}/lessons.json`)!)).toEqual([])
  expect(files.get(`${LEARNING}/proposed-guidance.md`)).toBe('')
  await pane.unmount()
})

test("a consult's question stays out of lessons; forget removes one", async ($, on) => {
  const files = new Map<string, string>()
  learningStandIn(on, files)
  await start($)
  await $.tool.call({ tool: 'mcp__council__consult', question: 'Which protocol?', context: 'A LAN game.' } as never)
  await settle()
  await run($, 'reconsider UDP is fine here.')
  await settle()
  const lessons = JSON.parse(files.get(`${LEARNING}/lessons.json`)!) as Lesson[]
  expect(lessons[0]).toMatchObject({ topic: null, added: 'UDP is fine here.' })
  await run($, 'lessons')
  const pane = await mountPane($)
  await pane.press({ key: `forget-${lessons[0]!.id}` })
  expect(JSON.parse(files.get(`${LEARNING}/lessons.json`)!)).toEqual([])
  await pane.unmount()
})
