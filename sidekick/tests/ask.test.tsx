// ask_codex and ask_agy through the engine: a tool only for a CLI found on PATH
// at session start, every call asked about, and the call run on the path that
// was found. The CLIs are fakes: files on a disk in memory, and $.process.run
// answered here (a real call would bill the person's plan).

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { baseStandIn } from './stand-in'

const ROOT = '/dev/work'
const CODEX_PATH = '/opt/codex/bin/codex'
const resultOf = (answer: unknown) => answer as { result?: string; isError?: boolean; deny?: string }

// The stand-in, with tool.register recorded, PATH set, and process.run answered.
function standIn(on: On, options: { files: string[]; answer?: (argv: readonly string[], stdin: unknown) => { exitCode: number; stdout: string } }) {
  const registered: string[] = []
  const runs: Array<{ argv: readonly string[]; stdin: unknown }> = []
  const run = (argv: readonly string[], stdin: unknown) => {
    runs.push({ argv, stdin })
    return options.answer?.(argv, stdin)
  }
  baseStandIn(on, { root: ROOT, env: { PATH: `.:/usr/bin:/opt/codex/bin`, HOME: '/home/me' }, decide: () => 'allow', run })
  // The engine hands fs calls the host's own spelling (C:\usr\bin\codex on Windows): compare without it.
  const plain = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  on('fs.stat', ($, e) => {
    if (!options.files.some(path => plain(path) === plain(e.path))) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file' as const, size: 10, mtimeMs: 1_000_000, isLink: false } }
  })
  on('tool.register', ($, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__sidekick__${e.name}` } }
  })
  return { registered, runs }
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })

test('only the CLI on PATH gets a tool: codex found, agy missing', async ($, on) => {
  const { registered } = standIn(on, { files: [CODEX_PATH, `${ROOT}/agy`] })
  await start($)
  expect(registered).toContain('ask_codex')
  // An agy in the session folder (`.` on PATH) is not on PATH for sidekick.
  expect(registered).not.toContain('ask_agy')
})

test('neither CLI installed: no tool at all', async ($, on) => {
  const { registered } = standIn(on, { files: [] })
  await start($)
  expect(registered.filter(name => name.startsWith('ask_'))).toEqual([])
})

test('with the setting off, no CLI is looked for', { options: { askToolsEnabled: false } }, async ($, on) => {
  const { registered } = standIn(on, { files: [CODEX_PATH] })
  await start($)
  expect(registered).not.toContain('ask_codex')
})

test('every call is asked about, with the prompt, even when everything else would allow it', async ($, on) => {
  standIn(on, { files: [CODEX_PATH] })
  await start($)
  const check = await $.tool.check({ tool: 'mcp__sidekick__ask_codex', input: { prompt: 'Is this migration safe?' } })
  expect(check.decision).toBe('ask')
  expect(String(check.reason)).toContain('Send this prompt to Codex (OpenAI)?')
  expect(String(check.reason)).toContain('Is this migration safe?')
  expect((await $.tool.check({ tool: 'mcp__sidekick__ask_agy', input: { prompt: 'x' } })).decision).toBe('ask')
})

test('a call runs the codex found at start, read-only, with the prompt on stdin', async ($, on) => {
  const { runs } = standIn(on, { files: [CODEX_PATH], answer: argv => (argv[0] === CODEX_PATH ? { exitCode: 0, stdout: 'It is safe.' } : undefined) ?? { exitCode: 1, stdout: '' } })
  await start($)
  const answer = resultOf(await $.tool.call({ tool: 'mcp__sidekick__ask_codex', prompt: '-h is not a flag here' }))
  expect(answer.isError).not.toBe(true)
  expect(answer.result).toContain('It is safe.')
  expect(answer.result).toContain('untrusted')
  const run = runs.find(entry => entry.argv[0] === CODEX_PATH)!
  expect(run.argv).toContain('read-only')
  expect(run.argv).not.toContain('-h is not a flag here')
  expect(run.stdin).toBe('-h is not a flag here')
})

test('a non-zero exit comes back as a readable error', async ($, on) => {
  standIn(on, { files: [CODEX_PATH], answer: () => ({ exitCode: 3, stdout: '' }) })
  await start($)
  const answer = resultOf(await $.tool.call({ tool: 'mcp__sidekick__ask_codex', prompt: 'x' }))
  expect(answer.isError).toBe(true)
  expect(answer.result).toContain('exited with code 3')
})

test('asking agy when it was not found says so, and runs nothing', async ($, on) => {
  const { runs } = standIn(on, { files: [CODEX_PATH] })
  await start($)
  const answer = resultOf(await $.tool.call({ tool: 'mcp__sidekick__ask_agy', prompt: 'x' }))
  expect(answer.isError).toBe(true)
  expect(answer.result).toContain('no `agy` was found on PATH')
  expect(runs.some(entry => entry.argv[0]?.includes('agy'))).toBe(false)
})
