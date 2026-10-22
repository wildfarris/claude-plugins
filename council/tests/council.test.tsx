import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { USAGE, baseStandIn, composer, settle, testPath, type Harness } from './stand-in'

const ROOT = '/dev/work'
const COUNCIL_PANE_ID = 'council-chamber'
const VERDICTS: Record<string, string> = {
  Castellan: 'CONCERN: 5\nVERDICT: An API key is exposed.\nDETAIL: An API key is committed to the repo.',
  Treasurer: 'CONCERN: 2\nVERDICT: Costs are small.\nDETAIL: Costs are a few cents per run.',
  Seneschal: 'CONCERN: 3\nVERDICT: Sound plan, a bit long.\nDETAIL: Two of the five steps could be merged.',
  Justiciar: 'CONCERN: 1\nVERDICT: No legal issue.\nDETAIL: Licenses are compatible.',
  Jester: 'I simply refuse to answer in your format.',
}
const BRIEF = 'The flow charges cards through Stripe.\n- An API key sits in config.ts.'

type ForkAnswer = { brief: string } | { reason: 'nothing-to-fork' }
type CouncilHarness = Harness & { forks: string[]; fork: { answer: ForkAnswer; gate?: Promise<void> } }

// The shared stand-in plus the council's own: the herald's brief is a fork of
// the conversation; the advisors and their follow-ups are model calls,
// answered by the advisor named in the system prompt.
function councilStandIn(on: On): CouncilHarness {
  const harness = baseStandIn(on, {
    root: ROOT,
    cwd: `${ROOT}/project`,
    complete: ({ system, prompt }) =>
      system.includes("advisory council's session")
        ? 'Council report: asked about shipping billing; the Castellan moved 5→2 once the key was rotated.'
        : prompt.includes('FOLLOW-UP QUESTION')
        ? 'Rotate the key today; it grants full account access.'
        : prompt.includes('NEW CONTEXT') && system.includes('Castellan')
          ? 'CONCERN: 2\nVERDICT: The key is already rotated.\nDETAIL: It was rotated and moved to the vault.'
          : (VERDICTS[Object.keys(VERDICTS).find(name => system.includes(name)) ?? ''] ?? 'CONCERN: 1\nVERDICT: Fine.'),
  })
  const council = Object.assign(harness, { forks: [] as string[], fork: { answer: { brief: BRIEF } as ForkAnswer } as CouncilHarness['fork'] })
  on('model.fork', async ($, e) => {
    council.forks.push(e.prompt)
    // Each fork answers with what was set when it was asked, however late.
    const { answer } = council.fork
    await council.fork.gate
    return { value: 'brief' in answer ? { isAnswered: true, text: answer.brief, usage: USAGE } : { isAnswered: false, reason: answer.reason } }
  })
  return council
}

const chamberProps = { title: 'The Council', isFocused: false, bodyColumns: 140, bodyRows: 30 }
const start = ($: Engine) => $.session.start({ cwd: `${ROOT}/project`, surface: 'desktop', isInteractive: true })
const mountChamber = ($: Engine, surface: 'desktop' | 'terminal' = 'desktop') =>
  $.ui.mount({ plugin: 'council', surface, component: 'Pane', requestId: COUNCIL_PANE_ID, props: chamberProps })

test('the herald briefs as a fork, the five advisors answer as model calls, and the chamber shows their verdicts', async ($, on) => {
  const harness = councilStandIn(on)
  await start($)
  const convened = await $.command.run(composer('council', 'Ship the billing flow?'))
  expect(convened.text).toContain('The council convenes')
  await settle()
  // One fork for the brief, with the topic; no agent anywhere.
  expect(harness.forks.length).toBe(1)
  expect(harness.forks[0]).toContain('Ship the billing flow?')
  expect(harness.completions.length).toBe(5)
  expect(harness.completions.every(call => call.model === 'sonnet' && call.prompt.includes('An API key sits in config.ts.'))).toBe(true)

  for (const surface of ['desktop', 'terminal'] as const) {
    const chamber = await mountChamber($, surface)
    expect(await chamber.find({ text: /An API key is exposed\./ })).toBeDefined()
    expect(await chamber.find({ text: /Gravest: Castellan 5\/5/ })).toBeDefined()
    expect(await chamber.find({ text: /fell silent|Fell silent/ })).toBeDefined()
    expect(await chamber.find({ type: surface === 'terminal' ? 'Raster' : 'Svg' })).toBeDefined()
    await chamber.unmount()
  }
})

test('verdicts stay short until opened; ask keeps the draft; a follow-up fills in under the card', async ($, on) => {
  const harness = councilStandIn(on)
  await start($)
  const run = (args: string) => $.command.run(composer('council', args))
  await run('Ship the billing flow?')
  await settle()

  let chamber = await mountChamber($)
  expect(await chamber.find({ text: /The flow charges cards through Stripe\./ })).toBeDefined()
  expect(await chamber.find({ text: /An API key is committed/ })).toBeUndefined()
  await chamber.press({ key: 'more-castellan' })
  expect(await chamber.find({ text: /An API key is committed/ })).toBeDefined()
  harness.draft.text = 'what would it cost to fix?'
  await chamber.press({ key: 'ask-seneschal' })
  expect(harness.filled[harness.filled.length - 1]).toBe('/council ask seneschal what would it cost to fix?')
  await chamber.unmount()

  expect((await run('ask security How bad is the key leak?')).text).toContain('considers your question')
  await settle()
  const followUp = harness.completions[harness.completions.length - 1]!
  expect(followUp.system).toContain('Castellan')
  expect(followUp.prompt).toContain('How bad is the key leak?')

  chamber = await mountChamber($)
  expect(await chamber.find({ text: /Rotate the key today/ })).toBeDefined()
  await chamber.unmount()
  // Subcommand words only act as subcommands: these are questions.
  expect((await run('ask users for consent first?')).text).toContain('The council convenes on: ask users for consent first?')
  await settle()
  expect((await run('reset the DB before migrating?')).text).toContain('The council convenes on: reset the DB before migrating?')
})

test('an adjourned council reconsiders with new context and shows how each concern moved', async ($, on) => {
  const harness = councilStandIn(on)
  await start($)
  const run = (args: string) => $.command.run(composer('council', args))
  expect((await run('reconsider the key was rotated')).text).toContain('has not convened')
  await run('Ship the billing flow?')
  await settle()

  // The chamber's button puts the command in front of the draft; Enter sends it.
  let chamber = await mountChamber($)
  harness.draft.text = 'The key was rotated yesterday.'
  await chamber.press({ key: 'reconsider' })
  expect(harness.filled[harness.filled.length - 1]).toBe('/council reconsider The key was rotated yesterday.')
  await chamber.unmount()
  expect((await run('reconsider The key was rotated yesterday.')).text).toContain('reconsiders')
  await settle()
  expect(harness.forks.length).toBe(1)
  const reconsiderations = harness.completions.slice(5)
  expect(reconsiderations.length).toBe(5)
  expect(reconsiderations.every(call => call.prompt.includes('1. The key was rotated yesterday.') && call.prompt.includes('An API key sits in config.ts.'))).toBe(true)
  const castellanCall = reconsiderations.find(call => call.system.includes('Castellan'))
  expect(castellanCall?.prompt).toContain('YOUR EARLIER VERDICT (concern 5/5): An API key is exposed.')

  chamber = await mountChamber($)
  expect(await chamber.find({ text: /\+ The key was rotated yesterday\./ })).toBeDefined()
  expect(await chamber.find({ text: /The key is already rotated\./ })).toBeDefined()
  expect(await chamber.find({ text: /\(was 5\)/ })).toBeDefined()
  expect(await chamber.find({ text: /\(held\)/ })).toBeDefined()
  expect(await chamber.find({ text: /Gravest: Seneschal 3\/5/ })).toBeDefined()
  await chamber.unmount()

  // A second round sees all the context so far.
  await run('reconsider It only runs in staging.')
  await settle()
  expect(harness.completions.slice(10).every(call => call.prompt.includes('1. The key was rotated yesterday.\n2. It only runs in staging.'))).toBe(true)

  // The report: one call over the whole record, written into the prompt box ahead of the draft.
  harness.draft.text = 'so, ship it?'
  expect((await run('report')).text).toContain('being written')
  await settle()
  const reportCall = harness.completions[harness.completions.length - 1]!
  expect(reportCall.system).toContain("advisory council's session")
  expect(reportCall.prompt).toContain('ROUND 1:')
  expect(reportCall.prompt).toContain('THE PERSON ADDED: The key was rotated yesterday.')
  expect(reportCall.prompt).toContain('ROUND 3 (FINAL):')
  expect(reportCall.prompt).toMatch(/ROUND 1:\n- The Castellan: concern 5\/5/)
  expect(harness.filled[harness.filled.length - 1]).toBe('Council report: asked about shipping billing; the Castellan moved 5→2 once the key was rotated.\n\nso, ship it?')
})

test('a report before the council adjourns, or with none, says so', async ($, on) => {
  councilStandIn(on)
  await start($)
  expect((await $.command.run(composer('council', 'report'))).text).toContain('has not convened')
})

test('with no conversation yet, the council says so instead of hanging', async ($, on) => {
  const harness = councilStandIn(on)
  harness.fork.answer = { reason: 'nothing-to-fork' }
  await start($)
  await $.command.run(composer('council', 'Anything?'))
  await settle()
  expect(harness.completions.length).toBe(0)
  const chamber = await mountChamber($)
  expect(await chamber.find({ text: /could not prepare a brief/ })).toBeDefined()
  await chamber.unmount()
  // A failed council doesn't block the next one.
  harness.fork.answer = { brief: BRIEF }
  expect((await $.command.run(composer('council', 'Try again'))).text).toContain('The council convenes')
})

test('a second /council while one is working is refused; reset frees it', async ($, on) => {
  const harness = councilStandIn(on)
  let release = () => {}
  harness.fork.gate = new Promise<void>(resolve => (release = resolve))
  harness.fork.answer = { brief: 'The FIRST brief, too late.' }
  await start($)
  const run = (args: string) => $.command.run(composer('council', args))
  await run('First topic')
  expect((await run('Second topic')).text).toContain('already in session')
  expect((await run('reset')).text).toContain('dismissed')
  harness.fork.answer = { brief: 'The second brief.' }
  expect((await run('Second topic')).text).toContain('The council convenes')
  // Both briefs arrive now; the first council's must not land on the second.
  release()
  await settle()
  const chamber = await mountChamber($)
  expect(await chamber.find({ text: /The second brief\./ })).toBeDefined()
  expect(await chamber.find({ text: /FIRST brief/ })).toBeUndefined()
  await chamber.unmount()
})

// A stand-in git repo for review mode: what each git command prints.
const REPO = `${ROOT}/project`
const COMMON_DIR = `${REPO}/.git`
function repoStandIn(on: On, now: number) {
  const ran: Array<{ argv: string[]; cwd: string | undefined }> = []
  const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  mock.env(on, { HOME: '/home/me' })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    ran.push({ argv, cwd: e.init?.cwd })
    const command = argv.slice(1).join(' ')
    if (command === 'rev-parse --show-toplevel') return out(`${REPO}\n`)
    if (command.startsWith('rev-parse --verify')) return command.includes('abc123') ? out('abc1234567\n') : out('', 1)
    if (command.startsWith('rev-parse --path-format')) return out(`${COMMON_DIR}\n`)
    if (command === 'rev-parse --abbrev-ref HEAD') return out('mobile-work\n')
    if (command.startsWith('log')) return out('def456 2026-10-07 Add the billing endpoint\n')
    if (command.startsWith('diff') && command.includes('--stat=1000') && command.includes('abc1234567...HEAD')) return out(' src/api.ts | 40 +++++\n 1 file changed\n')
    if (command.startsWith('diff') && command.includes('--unified=2')) return out('+export function charge() {}\n')
    if (command.startsWith('show HEAD:')) {
      const text = files[`${REPO}/${command.slice('show HEAD:'.length)}`]
      return text === undefined ? out('', 128) : out(text)
    }
    if (command === 'ls-files') return out('README.md\npackage.json\nsrc/api.ts\nsrc/util.ts\n')
    return out('', 1)
  })
  const files: Record<string, string> = {
    [`${REPO}/README.md`]: '# Billing service',
    [`${REPO}/package.json`]: '{ "name": "billing" }',
    [`${REPO}/src/api.ts`]: 'export function charge() { /* uses STRIPE_KEY */ }',
  }
  // Files are read through git (HEAD), never the working tree.
  on('fs.read', () => ({ deny: 'read through git show instead' }))
  on('fs.exists', ($, e) => ({ value: testPath(e.path) === `${REPO}/.git` }))
  on('fs.stat', ($, e) =>
    testPath(e.path) === `${COMMON_DIR}/FETCH_HEAD`
      ? { value: { kind: 'file', size: 1, mtimeMs: now - 3 * 86_400_000, isLink: false } }
      : testPath(e.path) === REPO
        ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
        : { deny: 'no such file' },
  )
  return ran
}

test('review mode briefs from the repo alone: commits, diff, map, and the files the herald asks for', async ($, on) => {
  const now = 10 * 86_400_000
  const harness = baseStandIn(on, {
    root: ROOT,
    cwd: REPO,
    complete: ({ system }) =>
      system.includes('pick the few files')
        ? 'FILES: src/api.ts, ../../secrets.env, src/missing.ts'
        : system.includes('You prepare one factual brief')
          ? 'Adds a Stripe billing endpoint.\n- src/api.ts charges cards using STRIPE_KEY.'
          : (VERDICTS[Object.keys(VERDICTS).find(name => system.includes(name)) ?? ''] ?? 'CONCERN: 1\nVERDICT: Fine.'),
  })
  const ran = repoStandIn(on, now)
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
  await start($)
  // A fresh session: nothing to fork, but a review needs no conversation.
  expect((await $.command.run(composer('council', 'review abc123 is the billing API safe?'))).text).toContain('Review since abc123')
  await settle()

  expect(ran.every(entry => entry.argv[0] === 'git' && entry.cwd === REPO)).toBe(true)
  const pick = harness.completions[0]!
  expect(pick.model).toBe('opus')
  expect(pick.prompt).toContain('def456 2026-10-07 Add the billing endpoint')
  expect(pick.prompt).toContain('src/ (2 files)')
  expect(pick.prompt).toContain('# Billing service')
  const brief = harness.completions[1]!
  expect(brief.model).toBe('opus')
  expect(brief.prompt).toContain('FILE src/api.ts')
  expect(brief.prompt).toContain('uses STRIPE_KEY')
  expect(brief.prompt).not.toContain('secrets.env')
  expect(brief.prompt).toContain('+export function charge() {}')
  // Then the five advisors judge the brief.
  expect(harness.completions.slice(2).length).toBe(5)
  expect(harness.completions.slice(2).every(call => call.prompt.includes('Adds a Stripe billing endpoint.'))).toBe(true)

  const chamber = await mountChamber($)
  expect(await chamber.find({ text: /Review since abc123: is the billing API safe\?/ })).toBeDefined()
  expect(await chamber.find({ text: /Gravest: Castellan 5\/5/ })).toBeDefined()
  await chamber.unmount()
})

test('review mode reports an unknown ref instead of hanging', async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT, cwd: REPO })
  repoStandIn(on, 0)
  await start($)
  await $.command.run(composer('council', 'review nope'))
  await settle()
  expect(harness.completions.length).toBe(0)
  const chamber = await mountChamber($)
  expect(await chamber.find({ text: /doesn't know "nope"/ })).toBeDefined()
  await chamber.unmount()
})

test('a plain council in a fresh session points to review mode', async ($, on) => {
  const harness = councilStandIn(on)
  harness.fork.answer = { reason: 'nothing-to-fork' }
  await start($)
  await $.command.run(composer('council', 'Is this good?'))
  await settle()
  const chamber = await mountChamber($)
  expect(await chamber.find({ text: /review <ref>/ })).toBeDefined()
  await chamber.unmount()
})

test('in a session over several repos, review names the repo by its folder', async ($, on) => {
  const harness = baseStandIn(on, {
    root: ROOT,
    cwd: ROOT,
    complete: ({ system }) => (system.includes('You prepare one factual brief') ? 'Adds a billing endpoint.' : 'CONCERN: 1\nVERDICT: Fine.'),
  })
  const ran = repoStandIn(on, 0)
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
  await start($)
  expect((await $.command.run(composer('council', 'review project abc123 ready?'))).text).toContain('Review since abc123: ready?')
  await settle()
  expect(ran.length).toBeGreaterThan(0)
  expect(ran.every(entry => entry.cwd === REPO)).toBe(true)
  expect(harness.completions.some(call => call.prompt.includes('Adds a billing endpoint.'))).toBe(true)
})

// ── Members, rosters and the brain trust ──────────────────────────────────

const HOME = '/home/me'

function memberFiles(on: On, files: Record<string, string>) {
  mock.env(on, { HOME })
  on('fs.list', ($, e) => {
    const prefix = `${testPath(e.path)}/`
    const names = Object.keys(files).filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    return names.length === 0 ? { deny: 'no such directory' } : { value: names.map(path => ({ name: path.slice(prefix.length), kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($, e) => (files[testPath(e.path)] !== undefined ? { value: files[testPath(e.path)]! } : { deny: 'no such file' }))
}

test('member files seat new members with their references; the roster unseats per project', async ($, on) => {
  const harness = councilStandIn(on)
  memberFiles(on, {
    [`${HOME}/.claude/council/members/auditor.md`]: '---\ntitle: The Auditor\nconcern: Compliance\nreferences:\n  - ./retention.md\n---\ncompliance with our data-retention rules',
    [`${HOME}/.claude/council/members/retention.md`]: 'Keep logs 30 days.',
    [`${ROOT}/.claude/council/members/castellan.md`]: '---\ntitle: The Gatekeeper\n---\n',
  })
  await start($)
  const run = (args: string) => $.command.run(composer('council', args))

  expect((await run('members off treasurer')).text).toContain("off this project's council")
  await run('Ship the billing flow?')
  await settle()
  const systems = harness.completions.map(call => call.system)
  expect(systems.length).toBe(5)
  expect(systems.some(system => system.includes('You are The Auditor') && system.includes('REFERENCE (retention.md):\nKeep logs 30 days.'))).toBe(true)
  expect(systems.some(system => system.includes('You are The Gatekeeper'))).toBe(true)
  expect(systems.some(system => system.includes('Lord Treasurer'))).toBe(false)

  const chamber = await mountChamber($)
  expect(await chamber.find({ text: /Auditor/ })).toBeDefined()
  await chamber.press({ key: 'members' })
  expect(await chamber.find({ text: /5 of 6 seated/ })).toBeDefined()
  await chamber.press({ key: 'seat-treasurer' })
  expect(await chamber.find({ text: /6 of 6 seated/ })).toBeDefined()
  await chamber.unmount()
})

test('a bad member file is reported, not seated', async ($, on) => {
  councilStandIn(on)
  memberFiles(on, { [`${HOME}/.claude/council/members/broken.md`]: 'no header at all' })
  await start($)
  await $.command.run(composer('council', 'members'))
  const chamber = await mountChamber($)
  expect(await chamber.find({ text: /broken\.md: needs a title/ })).toBeDefined()
  await chamber.unmount()
})

test('the brain trust runs every call on the deep model', async ($, on) => {
  const harness = councilStandIn(on)
  await start($)
  expect((await $.command.run(composer('council', 'deep Should we rewrite the parser?'))).text).toContain('The brain trust convenes on: Should we rewrite the parser?')
  await settle()
  expect(harness.completions.length).toBe(5)
  expect(harness.completions.every(call => call.model === 'opus')).toBe(true)
  const chamber = await mountChamber($)
  expect(await chamber.find({ text: /The Brain Trust/ })).toBeDefined()
  await chamber.unmount()
})
