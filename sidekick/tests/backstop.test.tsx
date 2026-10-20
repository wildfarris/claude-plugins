import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { BACKSTOP_MARK, backstopWarning, changesSince, dirtyMatches, flaggedChanges, newSinceStart, parseNameStatus, parseStatus } from '../hooks/backstop'
import type { ActivePathRule } from '../hooks/scope-rules'
import { baseStandIn, settle } from './stand-in'

const ROOT = '/dev/work'
const WEB = `${ROOT}/web`
const TESTS: ActivePathRule = { glob: '**/*.spec.ts', ops: ['create', 'edit', 'delete'], reason: 'the tests are the spec', base: WEB, source: { kind: 'order', id: 'O7' } }
const NO_NEW_CSS: ActivePathRule = { glob: '*/src/**/*.css', ops: ['create'], reason: 'use the theme tokens', base: ROOT, source: { kind: 'standing' } }

describe('reading git', () => {
  test('status: untracked, added, modified, deleted, renamed, with leading spaces kept', () => {
    const status = ['?? src/new.spec.ts', ' M src/app.ts', 'A  src/added.css', ' D src/gone.spec.ts', 'R  src/b.spec.ts', 'src/a.spec.ts', ''].join('\0')
    expect(parseStatus(status)).toEqual([
      { path: 'src/new.spec.ts', op: 'create' },
      { path: 'src/app.ts', op: 'edit' },
      { path: 'src/added.css', op: 'create' },
      { path: 'src/gone.spec.ts', op: 'delete' },
      { path: 'src/b.spec.ts', op: 'create' },
      { path: 'src/a.spec.ts', op: 'delete' },
    ])
  })

  test('name-status since the start, and new files, once each', () => {
    const tracked = parseNameStatus(['A', 'src/x.spec.ts', 'D', 'src/y.spec.ts', 'M', 'src/z.ts', ''].join('\0'))
    expect(tracked).toEqual([
      { path: 'src/x.spec.ts', op: 'create' },
      { path: 'src/y.spec.ts', op: 'delete' },
      { path: 'src/z.ts', op: 'edit' },
    ])
    expect(changesSince(tracked, ['src/x.spec.ts', 'src/n.css'])).toEqual([...tracked, { path: 'src/n.css', op: 'create' }])
  })
})

describe('judging the changes', () => {
  const changes = [
    { path: 'src/a.spec.ts', op: 'delete' as const },
    { path: 'src/a.ts', op: 'edit' as const },
    { path: 'src/new.css', op: 'create' as const },
    { path: 'src/old.css', op: 'edit' as const },
  ]

  test('only changes a rule forbids are flagged, by their operation', () => {
    expect(flaggedChanges(changes, WEB, [TESTS, NO_NEW_CSS]).map(entry => entry.path)).toEqual(['src/a.spec.ts', 'src/new.css'])
  })

  test('a change already there at the start is not the order\'s, unless it changed it again', () => {
    const flagged = flaggedChanges([{ path: 'src/a.spec.ts', op: 'edit' }], WEB, [TESTS])
    expect(newSinceStart(flagged, { 'src/a.spec.ts': 'h1' }, { 'src/a.spec.ts': 'h1' }, WEB, [TESTS])).toEqual([])
    expect(newSinceStart(flagged, { 'src/a.spec.ts': 'h1' }, { 'src/a.spec.ts': 'h2' }, WEB, [TESTS])[0]!.hits[0]!.op).toBe('edit')
    // A new CSS file there before the order, edited by it: an edit, which "no new CSS" allows.
    const css = flaggedChanges([{ path: 'src/new.css', op: 'create' }], WEB, [NO_NEW_CSS])
    expect(newSinceStart(css, { 'src/new.css': 'h1' }, { 'src/new.css': 'h2' }, WEB, [NO_NEW_CSS])).toEqual([])
    expect(dirtyMatches([{ path: 'src/a.ts', op: 'edit' }, { path: 'src/b.spec.ts', op: 'edit' }], WEB, [TESTS])).toEqual([{ path: 'src/b.spec.ts', op: 'edit' }])
  })

  test('the warning names each file, its rule, its source, and the layer that found it', () => {
    const warning = backstopWarning({ orderId: 'O7', folder: WEB }, flaggedChanges(changes, WEB, [TESTS, NO_NEW_CSS]))!
    expect(warning.startsWith(`${BACKSTOP_MARK} Order O7 (${WEB}) stopped with 2 changes its path rules forbid. The stop backstop found them in git`)).toBe(true)
    expect(warning).toContain("- deleting src/a.spec.ts is forbidden by order O7's rule `**/*.spec.ts` (create, edit, delete), reason: the tests are the spec")
    expect(warning).toContain('- creating web/src/new.css is forbidden by the standing rule `*/src/**/*.css` (create), reason: use the theme tokens')
    expect(backstopWarning({ orderId: 'O7', folder: WEB }, [])).toBeUndefined()
  })
})

// ── At the agent's stop ────────────────────────────────────────────────────

// A repo at WEB as git reports it: HEAD, a status at the start, then what the
// agent's script left (the diff since the start, new files, hashes).
type Repo = { status: string; diff: string; untracked: string; hashes: Record<string, string>; calls: string[] }

function gitStandIn(repo: Repo) {
  return (argv: readonly string[]) => {
    const args = argv.slice(3)
    repo.calls.push(args.join(' '))
    if (argv[0] !== 'git') return undefined
    if (args[0] === 'rev-parse') return { exitCode: 0, stdout: args[1] === '--show-toplevel' ? `${WEB}\n` : 'abc123\n' }
    if (args[0] === 'status') return { exitCode: 0, stdout: repo.status }
    if (args[0] === 'diff') return { exitCode: 0, stdout: repo.diff }
    if (args[0] === 'ls-files') return { exitCode: 0, stdout: repo.untracked }
    if (args[0] === 'hash-object') return { exitCode: 0, stdout: args.slice(2).map(path => repo.hashes[path] ?? 'h?').join('\n') }
    return undefined
  }
}

function orderStandIn(on: Parameters<typeof baseStandIn>[0], repo: Repo) {
  const harness = baseStandIn(on, { root: ROOT, cwd: WEB, decide: () => 'allow', complete: () => 'ALLOW', run: gitStandIn(repo), store: { [`rules:${ROOT}`]: [{ kind: 'forbid', glob: '*/src/**/*.css', ops: ['create'], reason: 'use the theme tokens' }] } })
  on('command.list', () => ({ value: [{ name: 'council', description: '', source: 'plugin' }] }))
  on('state.get', ($, e, next) =>
    String(e.plugin) === 'council' && String(e.key) === 'court'
      ? { value: { value: { orders: [{ id: 'O7', agentId: 'agent-1', status: 'dispatched', folder: WEB, forbid: [{ glob: '**/*.spec.ts', reason: 'the tests are the spec' }] }] }, version: 1 } }
      : next(e),
  )
  on('fs.exists', () => ({ value: false }))
  return harness
}

const stop = ($: Engine) => $.turn.complete({ agentId: 'agent-1', answer: 'Done: specs cleaned up.', durationMs: 10, isAborted: false, turnId: 'a1', reason: 'answer' } as never) as Promise<{ text?: string }>

test('the backstop catches an indirect write the Bash layer misses, and names it to the main session', async ($, on) => {
  const repo: Repo = { status: [' M src/app.spec.ts', ''].join('\0'), diff: '', untracked: '', hashes: { 'src/app.spec.ts': 'h1' }, calls: [] }
  const harness = orderStandIn(on, repo)
  await $.session.start({ cwd: WEB, surface: 'desktop', isInteractive: true })
  await settle()

  // The Bash layer can't see what a script does: the call goes through.
  const ran = (await $.tool.call({ tool: 'Bash', agentId: 'agent-1', command: 'node scripts/clean-specs.js' } as never)) as { deny?: string }
  expect(ran.deny).toBeUndefined()
  expect(repo.calls).toContain('status --porcelain=v1 -z --untracked-files=all')

  // What the script did: deleted one spec, added another and a CSS file, and
  // left the spec that was already changed before the order as it was.
  repo.diff = ['D', 'src/old.spec.ts', 'M', 'src/app.spec.ts', 'M', 'src/app.ts', ''].join('\0')
  repo.untracked = ['src/new.spec.ts', 'src/theme.css', ''].join('\0')

  const report = (await stop($)).text ?? ''
  expect(report.startsWith('Done: specs cleaned up.')).toBe(true)
  expect(report).toContain(`${BACKSTOP_MARK} Order O7 (${WEB}) stopped with 3 changes its path rules forbid`)
  expect(report).toContain("deleting src/old.spec.ts is forbidden by order O7's rule `**/*.spec.ts`")
  expect(report).toContain("creating src/new.spec.ts is forbidden by order O7's rule")
  expect(report).toContain('creating web/src/theme.css is forbidden by the standing rule `*/src/**/*.css` (create)')
  expect(report).not.toContain('src/app.spec.ts is')
  expect(report).not.toContain('src/app.ts is')
  expect(harness.toasts.some(toast => toast.includes('Path rules backstop: O7 changed 3 protected paths'))).toBe(true)

  // The baseline went with the stop: a second stop says nothing more.
  expect((await stop($)).text).toBe('Done: specs cleaned up.')
})

test('a change already there at the start is blamed on the order only if it changed it again', async ($, on) => {
  const repo: Repo = { status: [' M src/app.spec.ts', ''].join('\0'), diff: '', untracked: '', hashes: { 'src/app.spec.ts': 'h1' }, calls: [] }
  orderStandIn(on, repo)
  await $.session.start({ cwd: WEB, surface: 'desktop', isInteractive: true })
  await settle()
  await $.tool.call({ tool: 'Read', agentId: 'agent-1', file_path: `${WEB}/src/app.ts` } as never)
  repo.diff = ['M', 'src/app.spec.ts', ''].join('\0')
  repo.hashes['src/app.spec.ts'] = 'h2'
  expect((await stop($)).text).toContain('editing src/app.spec.ts is forbidden')
})

test('with nothing forbidden changed, the report is untouched; agents without an order get no backstop', async ($, on) => {
  const repo: Repo = { status: '', diff: '', untracked: '', hashes: {}, calls: [] }
  orderStandIn(on, repo)
  await $.session.start({ cwd: WEB, surface: 'desktop', isInteractive: true })
  await settle()
  await $.tool.call({ tool: 'Bash', agentId: 'agent-1', command: 'npm test' } as never)
  repo.diff = ['M', 'src/app.ts', ''].join('\0')
  expect((await stop($)).text).toBe('Done: specs cleaned up.')

  repo.calls.length = 0
  await $.tool.call({ tool: 'Bash', agentId: 'agent-9', command: 'npm test' } as never)
  expect(repo.calls).toEqual([])
})
