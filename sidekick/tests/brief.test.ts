import { describe, expect, test } from 'claude-code/testing'

import {
  MAX_CHUNKS,
  baseName,
  briefSummaryText,
  chunkLines,
  claimsCheck,
  condensedLog,
  elapsedStamp,
  formatDuration,
  handoffMarkdown,
  parentFolder,
  parseBriefReply,
  pathInRepo,
  planBrief,
  repoGroupFolder,
  sessionHandoffMarkdown,
  spanStats,
  statLines,
} from '../hooks/brief'
import {
  answerEntry,
  callEntry,
  describeCall,
  expiredLedgers,
  isNewSay,
  isTestCommand,
  LEDGER_RETENTION_MS,
  parseSegment,
  promptEntry,
  responseText,
  safeSessionFolder,
  sayEntry,
  sayKey,
  serializeSegment,
  spanEntries,
  type LedgerEntry,
} from '../hooks/ledger'
import { modelFailureText } from '../hooks/values'
import { REDACTED, redactSecrets } from '../hooks/secrets'
import type { Brief } from '../types'

const call = (tool: string, input: Record<string, unknown>, extra: Partial<Parameters<typeof callEntry>[0]> = {}) =>
  callEntry({ tool, input, at: 1000, durationMs: 5, isError: false, ...extra })

describe('secrets', () => {
  test('redacts token shapes, secret assignments, URL passwords and private keys', () => {
    const text = [
      'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop',
      'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" https://api.example.com',
      'git clone https://jeremy:hunter2hunter2@example.com/repo.git',
      'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'aws AKIAABCDEFGHIJKLMNOP',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    ].join('\n')
    const redacted = redactSecrets(text)
    for (const secret of ['sk-ant-api03', 'abcdefghijklmnopqrstuvwxyz123456', 'hunter2hunter2', 'ghp_abc', 'AKIAABCD', 'MIIEow']) expect(redacted).not.toContain(secret)
    expect(redacted).toContain('ANTHROPIC_API_KEY=')
    expect(redacted).toContain(REDACTED)
  })

  test('leaves ordinary text alone', () => {
    const text = 'Run the tests in sidekick and fix the token counter in values.ts'
    expect(redactSecrets(text)).toBe(text)
  })
})

describe('ledger entries', () => {
  test('a call in a few words: Bash description, else a path or pattern; secrets redacted', () => {
    expect(describeCall('Bash', { command: 'go test ./...', description: 'Run the Go tests' })).toBe('Run the Go tests')
    expect(describeCall('Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnop1234"' })).toContain(REDACTED)
    expect(describeCall('Read', { file_path: '/dev/work/a.ts' })).toBe('/dev/work/a.ts')
    expect(describeCall('Grep', { pattern: 'TODO' })).toBe('TODO')
  })

  test('test commands are recognized by runner', () => {
    for (const command of ['go test ./...', 'cd sidekick && claude plugin test .', 'npm test', 'pnpm run test', 'pytest -q', 'cargo test', 'git fetch -q; node --test verification/go-serving.test.mjs 2>&1 | grep pass', 'npx playwright test', 'swift test']) expect(isTestCommand(command)).toBe(true)
    for (const command of ['git status', 'cat test.txt', 'ls tests', 'node --version']) expect(isTestCommand(command)).toBe(false)
  })

  test('a Bash call keeps its commit, push, changed files and test flag; an Agent its report', () => {
    const bash = call(
      'Bash',
      { command: 'go test ./... && git commit -am x && git push', description: 'Test, commit and push' },
      {
        isError: true,
        result: {
          gitOperation: { commit: { sha: '0123456789abcdef', kind: 'committed' }, push: { branch: 'main' } },
          bashEditDiff: { files: [{ filePath: '/dev/work/a.go', hunks: [{ lines: ['+one', '+two', '-old', ' same'] }] }] },
        },
      },
    )
    expect(bash).toMatchObject({ isError: true, commit: '0123456789ab', push: 'main', isTest: true, files: [{ path: '/dev/work/a.go', added: 2, removed: 1 }] })
    expect(call('Agent', { description: 'Survey the repo' }, { resultText: 'Found three services.' }).report).toBe('Found three services.')
  })

  test('a response row gives its text blocks only', () => {
    expect(responseText([{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Now the tests.' }, { type: 'tool_use', name: 'Bash' }])).toBe('Now the tests.')
    expect(responseText('plain')).toBe('plain')
  })

  test('segments round-trip and skip torn lines', () => {
    const entries: LedgerEntry[] = [promptEntry(1, 't1', 'fix it'), call('Read', { file_path: '/a' })]
    expect(parseSegment(serializeSegment(entries))).toEqual(entries)
    expect(parseSegment(`${serializeSegment(entries)}{"kind":"call","at":`)).toEqual(entries)
    expect(safeSessionFolder('ab/../c d')).toBe('ab____c_d')
  })

  test('spans: last turn, since the last brief, whole session', () => {
    const entries: LedgerEntry[] = [
      promptEntry(1, 't1', 'one'),
      answerEntry(2, 't1', 'done one', 1, false),
      { kind: 'brief', at: 3 },
      promptEntry(4, 't2', 'two'),
      answerEntry(5, 't2', 'done two', 1, false),
      promptEntry(6, 't3', 'three'),
    ]
    expect(spanEntries(entries, 'last').map(entry => entry.at)).toEqual([6])
    expect(spanEntries(entries, 'since').map(entry => entry.at)).toEqual([4, 5, 6])
    expect(spanEntries(entries, 'full').map(entry => entry.at)).toEqual([1, 2, 4, 5, 6])
  })

  test('expired ledgers: old ones go, the current one and odd names never', () => {
    const now = 100 * LEDGER_RETENTION_MS
    const folders = [
      { name: 'old', newestMs: 0 },
      { name: 'recent', newestMs: now - 1000 },
      { name: 'current', newestMs: 0 },
      { name: '..', newestMs: 0 },
    ]
    expect(expiredLedgers(folders, 'current', now)).toEqual(['old'])
  })
})

describe('figures and the claims check', () => {
  const turn = (answer: string, calls: LedgerEntry[]): LedgerEntry[] => [promptEntry(0, 't1', 'fix the parser'), ...calls, answerEntry(3_600_000, 't1', answer, 3_600_000, false)]
  const edit = call('Edit', { file_path: '/dev/work/parser.ts' }, { editedFile: { path: '/dev/work/parser.ts', added: 3, removed: 1 } })
  const failingTest = call('Bash', { command: 'npm test', description: 'Run the tests' }, { isError: true })

  test('counts calls, errors, files, tests and commits', () => {
    const stats = spanStats(turn('Fixed parser.ts.', [edit, failingTest, call('Read', { file_path: '/a' }), call('Bash', { command: 'ls' }, { agentId: 'sub' })]))
    expect(stats).toMatchObject({ prompts: 1, calls: 3, errors: 1, agentCalls: 1, tests: { runs: 1, lastFailed: true } })
    expect(stats.files).toEqual([{ path: '/dev/work/parser.ts', added: 3, removed: 1 }])
    expect(statLines(stats)[0]).toBe('1h 0m · 1 prompt · 3 tool calls (Edit 1, Bash 1, Read 1) · 1 error')
  })

  test('says tests pass but the last run failed; says it committed with no commit', () => {
    const findings = claimsCheck(spanStats(turn('Fixed parser.ts and all tests pass. I committed the change.', [edit, failingTest])))
    expect(findings).toContain('Says tests pass, but the last test run failed (Run the tests).')
    expect(findings).toContain('Says it committed, but no commit was recorded in this span.')
  })

  test('says it changed a file it never edited; edited a file it never names', () => {
    const findings = claimsCheck(spanStats(turn('I updated lexer.ts to handle quotes.', [edit])))
    expect(findings).toContain('Says it changed lexer.ts, but no edit to it was recorded.')
    expect(findings).toContain('Edited but never named in the answer: parser.ts.')
  })

  test('negated claims and honest answers raise nothing', () => {
    const passing = call('Bash', { command: 'npm test', description: 'Run the tests' })
    expect(claimsCheck(spanStats(turn("Fixed parser.ts; tests pass. I didn't commit it.", [edit, passing])))).toEqual([])
  })

  test('a failed edit never redone, and an interrupted turn', () => {
    const failedEdit = call('Edit', { file_path: '/dev/work/lexer.ts' }, { isError: true })
    const entries = [promptEntry(0, 't1', 'go'), failedEdit, answerEntry(10, 't1', '', 10, true)]
    expect(claimsCheck(spanStats(entries))).toEqual(['The turn was interrupted before Claude finished.', 'An edit to lexer.ts failed and was never redone.'])
  })
})

describe('condensing and planning', () => {
  test('routine calls group, notable ones stand alone, subagent calls and repeated narration drop', () => {
    const entries: LedgerEntry[] = [
      promptEntry(0, 't1', 'fix it'),
      sayEntry(1, 'Reading the code first.'),
      call('Read', { file_path: '/w/a.ts' }),
      call('Read', { file_path: '/w/b.ts' }),
      call('Bash', { command: 'ls' }, { agentId: 'sub' }),
      call('Edit', { file_path: '/w/a.ts' }, { editedFile: { path: '/w/a.ts', added: 2, removed: 0 } }),
      sayEntry(2, 'Fixed a.ts.'),
      answerEntry(65 * 60_000, 't1', 'Fixed a.ts.', 1, false),
    ]
    expect(condensedLog(entries)).toEqual(['[+0:00] YOU: fix it', 'CLAUDE: Reading the code first.', '· Read ×2: a.ts, b.ts', '· Edit: a.ts (+2 −0)', '[+1:05] FINAL ANSWER: Fixed a.ts.'])
    expect(condensedLog(entries, true)).not.toContain('· Read ×2: a.ts, b.ts')
  })

  test('a tool-less turn is the old one-line TL;DR; a working one is one call', () => {
    expect(planBrief([promptEntry(0, 't', 'hi'), answerEntry(1, 't', 'hello', 1, false)])).toMatchObject({ isTrivial: true, calls: 1 })
    expect(planBrief([promptEntry(0, 't', 'go'), call('Read', { file_path: '/a' }), answerEntry(1, 't', 'ok', 1, false)])).toMatchObject({ isTrivial: false, calls: 1 })
  })

  test('a huge span is chunked, capped, and says what it left out', () => {
    const entries: LedgerEntry[] = []
    for (let index = 0; index < 1200; index++) entries.push(promptEntry(index, `t${index}`, `prompt ${index} ${'x'.repeat(1400)}`), call('Read', { file_path: `/w/${index}.ts` }))
    const plan = planBrief(entries)
    expect(plan.chunks.length).toBe(MAX_CHUNKS)
    expect(plan.calls).toBe(MAX_CHUNKS + 1)
    expect(plan.skippedNote).toMatch(/^The earliest \d+ of \d+ parts were left out/)
    expect(chunkLines(['a'.repeat(10), 'b'.repeat(10)], 15)).toEqual(['a'.repeat(10), 'b'.repeat(10)])
  })

  test('time formats', () => {
    expect(formatDuration(192 * 60_000)).toBe('3h 12m')
    expect(formatDuration(42 * 60_000)).toBe('42m')
    expect(elapsedStamp(65 * 60_000, 0)).toBe('+1:05')
  })
})

describe('the reply and the handoff', () => {
  const brief: Brief = {
    span: 'full',
    label: 'whole session · 3h 12m',
    line: null,
    done: 'Moved billing to Stripe.',
    stuck: 'Webhook tests still fail.',
    needsYou: null,
    findings: ['Says tests pass, but the last test run failed (Run the tests).'],
    phases: ['+0:00 Read the billing code'],
    stats: ['3h 12m · 4 prompts · 120 tool calls · 3 errors'],
    repos: [{ folder: '/w/billing', name: 'billing', files: [{ path: 'src/pay.ts', added: 40, removed: 2 }], added: 40, removed: 2, commits: ['abc1234 Move to Stripe'], uncommitted: 1, unpushed: 1 }],
    skippedNote: null,
    isExpanded: false,
  }

  test('the reply parses into lines, with NONE as nothing', () => {
    const reply = 'DONE: Moved billing.\nSTUCK: NONE\nNEEDS YOU: Pick a webhook secret.\nPHASES:\n- +0:00 Read code\n- +1:10 Rewrote client\n'
    expect(parseBriefReply(reply)).toEqual({ done: 'Moved billing.', stuck: null, needsYou: 'Pick a webhook secret.', phases: ['+0:00 Read code', '+1:10 Rewrote client'] })
  })

  test('the handoff has the brief, the claims check and the repo, and says it was generated', () => {
    const markdown = handoffMarkdown(brief, brief.repos[0]!, '2026-10-09T08:00:00.000Z')
    for (const text of ['# Handoff: billing', 'not reviewed by a person', '## Stuck', 'Webhook tests still fail.', '## Claims check', '`src/pay.ts` +40 −2', 'commit abc1234 Move to Stripe', 'billing: 1 file +40 −2 · 1 commit · 1 uncommitted · 1 unpushed']) {
      expect(markdown).toContain(text)
    }
    expect(markdown).not.toContain('## Needs you')
    expect(briefSummaryText(brief)).toContain('⚠ Says tests pass')
  })
})

describe('what the record keeps', () => {
  test("Claude's new words, not empty rows or a compaction's re-appended ones", () => {
    const compacted = new Set([sayKey('Round 3 is done.\nPushed design.')])
    expect(isNewSay('Round 3 is done. Pushed  design.', compacted)).toBe(false)
    expect(isNewSay('(no content)', compacted)).toBe(false)
    expect(isNewSay('  ', compacted)).toBe(false)
    expect(isNewSay('Starting round 4.', compacted)).toBe(true)
  })

  test('a failed model call says why', () => {
    expect(modelFailureText({ reason: 'api-error', status: 429, error: 'rate_limit' })).toBe('API error: rate_limit (429)')
    expect(modelFailureText({ reason: 'api-error', status: null, error: 'unknown' })).toBe('API error: unknown, no response')
    expect(modelFailureText({ reason: 'aborted' })).toBe('timed out or cancelled')
  })
})

describe('Windows paths in the brief', () => {
  const ROOT_WIN = 'C:\\claude\\workspace'
  const turn = (answer: string, calls: LedgerEntry[]): LedgerEntry[] => [promptEntry(0, 't1', 'fix it'), ...calls, answerEntry(60_000, 't1', answer, 60_000, false)]

  test('file names are found after a backslash, so the claims check matches them', () => {
    expect(baseName('C:\\claude\\workspace\\agent-host\\docs\\build.md')).toBe('build.md')
    expect(baseName('C:/claude/workspace/agent-host')).toBe('agent-host')
    expect(baseName('C:\\claude\\workspace\\')).toBe('workspace')
    expect(baseName('/dev/work/parser.ts')).toBe('parser.ts')
    expect(baseName('/')).toBe('')
    const edit = call('Edit', { file_path: 'C:\\claude\\workspace\\api\\parser.ts' }, { editedFile: { path: 'C:\\claude\\workspace\\api\\parser.ts', added: 1, removed: 0 } })
    expect(claimsCheck(spanStats(turn('Fixed parser.ts.', [edit])))).toEqual([])
    const failed = call('Edit', { file_path: 'C:\\claude\\workspace\\api\\lexer.ts' }, { isError: true })
    expect(claimsCheck(spanStats(turn('Done.', [failed])))).toContain('An edit to lexer.ts failed and was never redone.')
  })

  test('changed files group under the top-level folder below the root, however they are spelled', () => {
    for (const path of [
      'C:\\claude\\workspace\\agent-host\\docs\\build.md',
      'C:/claude/workspace/agent-host/docs/build.md',
      'c:\\Claude\\workspace\\agent-host\\a.md',
      'C:\\claude/workspace\\agent-host/src\\a.ts',
    ]) {
      expect([path, repoGroupFolder(ROOT_WIN, path)]).toEqual([path, 'C:\\claude\\workspace\\agent-host'])
    }
    // Outside the root: the file's own folder.
    expect(repoGroupFolder(ROOT_WIN, 'D:\\other\\repo\\a.ts')).toBe('D:\\other\\repo')
    expect(repoGroupFolder(ROOT_WIN, 'C:\\claude\\workspace\\agent-host\\..\\..\\x\\a.ts')).toBe('C:\\claude\\workspace\\agent-host\\..\\..\\x')
    // POSIX is unchanged.
    expect(repoGroupFolder('/dev/work', '/dev/work/project/src/a.ts')).toBe('/dev/work/project')
    expect(repoGroupFolder('/dev/work', '/elsewhere/a.ts')).toBe('/elsewhere')
    expect(parentFolder('C:\\a\\b.ts')).toBe('C:\\a')
  })

  test("paths inside a repo are relative to git's top folder, whichever separators either uses", () => {
    expect(pathInRepo('C:/claude/workspace/agent-host', 'C:\\claude\\workspace\\agent-host\\docs\\build.md')).toBe('docs/build.md')
    expect(pathInRepo('C:\\claude\\workspace\\agent-host', 'c:/claude/workspace/agent-host/a.md')).toBe('a.md')
    expect(pathInRepo('C:/claude/workspace/agent-host', 'C:\\claude\\workspace\\agent-host2\\a.md')).toBe('C:\\claude\\workspace\\agent-host2\\a.md')
    expect(pathInRepo('/dev/work/project', '/dev/work/project/src/a.ts')).toBe('src/a.ts')
    expect(pathInRepo('/dev/work/project', '/dev/work/project2/a.ts')).toBe('/dev/work/project2/a.ts')
  })

  test("the session handoff's title is the root's last folder", () => {
    const brief: Brief = { span: 'full', label: 'whole session', line: 'x', done: null, stuck: null, needsYou: null, findings: [], phases: [], stats: [], repos: [], skippedNote: null, isExpanded: false }
    const markdown = sessionHandoffMarkdown({ brief, root: ROOT_WIN, sessionId: 's', recordFolder: 'C:\\Users\\me\\.claude\\sidekick\\ledgers\\s', heldPrompt: null, writtenAt: 'now' })
    expect(markdown.split('\n')[0]).toBe('# Handoff: workspace')
  })
})
