// Usage: every sidekick model call recorded as a `model` entry in the
// session's ledger (purpose, model, the four counts, the agent and order it
// was for), never part of a brief, and /scope usage's slice by purpose.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseSegment, serializeSegment, spanEntries, type LedgerEntry } from '../hooks/ledger'
import { SHARE_HEADING, costOf, modelEntries, modelEntry, parseSince, scopeUsageReport } from '../hooks/usage'
import { baseStandIn, composer, settle } from './stand-in'

const ROOT = '/dev/work'
const HOST = `${ROOT}/agent-host`
const HOME = '/home/me'
const LEDGER = `${HOME}/.claude/sidekick/ledgers/session-1`
const NOW = Date.parse('2026-10-22T10:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const M = 1_000_000

const entry = (purpose: string, model: string, counts: Partial<Record<'input' | 'cacheRead' | 'cacheWrite' | 'output', number>>, at = NOW) =>
  modelEntry({ at, purpose, model, session: 's', usage: { input_tokens: counts.input ?? 0, cache_read_input_tokens: counts.cacheRead ?? 0, cache_creation_input_tokens: counts.cacheWrite ?? 0, output_tokens: counts.output ?? 0 } })

describe('the model entry', () => {
  test("its shape: kind, version, time, plugin, purpose, model, effort, four counts, the session; the agent and order when there are some", () => {
    const judged = modelEntry({ at: NOW, purpose: 'judge', model: 'claude-haiku-5-5', effort: 'low', session: 'session-1', usage: { input_tokens: 900, output_tokens: 12, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 }, agentId: 'agent-1', orderId: 'O3' })
    expect(judged).toEqual({ kind: 'model', v: 1, at: NOW, plugin: 'sidekick', purpose: 'judge', model: 'claude-haiku-5-5', effort: 'low', input: 900, cacheRead: 4000, cacheWrite: 0, output: 12, session: 'session-1', agentId: 'agent-1', orderId: 'O3' })
    expect(Object.keys(modelEntry({ at: 1, purpose: 'tldr', model: 'haiku', session: 's', usage: undefined }))).toEqual(['kind', 'v', 'at', 'plugin', 'purpose', 'model', 'input', 'cacheRead', 'cacheWrite', 'output', 'session'])
  })

  test('kept in the ledger, read back, and never part of a brief', () => {
    const entries: LedgerEntry[] = [
      { kind: 'prompt', at: 1, turnId: 't1', text: 'Fix it.' },
      entry('judge', 'haiku', { input: 5 }, 2),
      { kind: 'answer', at: 3, turnId: 't1', text: 'Fixed.', durationMs: 1 },
    ]
    const read = parseSegment(serializeSegment(entries))
    expect(read).toEqual(entries)
    for (const span of ['last', 'since', 'full'] as const) expect(spanEntries(read, span).some(item => item.kind === 'model')).toBe(false)
    expect(modelEntries(serializeSegment(entries))).toEqual([entries[1]])
  })

  test("/scope usage's table: calls, tokens, output and each purpose's approximate price-weighted share of sidekick's own", () => {
    // The judge: 3 units (haiku, 1M in, 0.4M out); the stop review 1; a TL;DR 1 (cache reads count 0.1×).
    const entries = [
      entry('judge', 'claude-haiku-5-5', { input: M / 2 }),
      entry('judge', 'claude-haiku-5-5', { input: M / 2, output: 400_000 }),
      entry('stop-review', 'haiku', { input: M }),
      entry('tldr', 'haiku', { cacheRead: 10 * M }),
      entry('brief', 'haiku', { input: 50 * M }, NOW - 30 * DAY_MS),
    ]
    expect(costOf({ input: 0, cacheRead: 10 * M, cacheWrite: 0, output: 0 }, 'haiku')).toBe(1)
    const report = scopeUsageReport(entries, { since: NOW - 7 * DAY_MS, label: 'the last 7 days' }, NOW).split('\n')
    expect(report[0]).toBe("Sidekick's model calls, the last 7 days:")
    expect(report[1]).toContain(SHARE_HEADING)
    const line = (label: string) => report.find(row => row.trimStart().startsWith(label))!.replace(/\s+/g, ' ').trim()
    expect(line('Sidekick ')).toBe('Sidekick 4 12.4M 400k 100%')
    expect(line('judge')).toBe('judge 2 1.4M 400k 60%')
    expect(line('stop-review')).toBe('stop-review 1 1.0M 0 20%')
    expect(line('tldr')).toBe('tldr 1 10.0M 0 20%')
    expect(report.some(row => row.includes('brief'))).toBe(false)
    expect(report.at(-1)).toBe('For the whole split (main sessions, council dispatches, members and sidekick), run /council usage.')
    expect(report.join('\n')).toContain('from sidekick 0.19.0 on')
    // Nothing in the span: not recorded, still with the pointer.
    expect(scopeUsageReport([], { since: NOW - DAY_MS, label: 'since 2026-10-21' }, NOW)).toContain("Sidekick's model calls, since 2026-10-21: not recorded.")
    expect(scopeUsageReport([], { since: NOW - 30 * DAY_MS, label: 'since then' }, NOW)).toContain('Ledgers keep 14 days')
  })

  test('the span: 7 days by default, or since a day', () => {
    expect((parseSince([], NOW) as { label: string }).label).toContain('the last 7 days')
    expect(parseSince(['since', '2026-10-01'], NOW)).toMatchObject({ label: 'since 2026-10-01' })
    expect(parseSince(['2026-02-30'], NOW)).toHaveProperty('error')
  })
})

// ── Through the hooks ─────────────────────────────────────────────────────

// A POSIX test path as the engine hands it to the fs hooks on Windows (C:\dev\work), read back.
const testPath = (path: string) => (/^[A-Za-z]:[\\/]/.test(path) ? path.slice(2).replace(/\\/g, '/') : path)

function standIn(on: On, options: { failWrite?: boolean } = {}) {
  const files = new Map<string, string>()
  // The stop review finds nothing, the heads-up review says nothing, the judge allows.
  const judge = (request: { system: string }) => (request.system.startsWith('You review the whole run') ? 'OK' : request.system.startsWith("You review an AI coding assistant's final answer") ? 'NONE' : 'ALLOW')
  const harness = baseStandIn(on, { root: ROOT, cwd: HOST, decide: () => 'allow', complete: judge, env: { HOME } })
  const children = (folder: string) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of files.keys()) {
      if (!path.startsWith(`${folder}/`)) continue
      const [name, ...rest] = path.slice(folder.length + 1).split('/')
      names.set(name!, rest.length > 0 ? 'dir' : 'file')
    }
    return names
  }
  on('fs.write', ($, e) => {
    if (options.failWrite) return { deny: 'the disk is full' }
    files.set(testPath(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => (files.has(testPath(e.path)) ? { value: files.get(testPath(e.path))! } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: files.has(testPath(e.path)) || children(testPath(e.path)).size > 0 }))
  on('fs.list', ($, e) => ({ value: [...children(testPath(e.path))].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: NOW, isLink: false })) }))
  on('fs.stat', ($, e) => (files.has(testPath(e.path)) ? { value: { kind: 'file', size: 0, mtimeMs: NOW, isLink: false } } : { deny: 'no such file' }))
  // Order O3 at work in agent-host (agent-1).
  on('command.list', () => ({ value: [{ name: 'council', description: '', source: 'plugin' }] }))
  on('state.get', ($, e, next) => (String(e.plugin) === 'council' && String(e.key) === 'court' ? { value: { value: { orders: [{ id: 'O3', agentId: 'agent-1', status: 'dispatched', folder: HOST }] }, version: 1 } } : next(e)))
  return Object.assign(harness, { files })
}

const start = async ($: Engine, harness: { clock: { set: (ms: number) => Promise<void> } }) => {
  await harness.clock.set(NOW)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await settle()
}
const bash = ($: Engine, command: string, agentId: string) => $.tool.call({ tool: 'Bash', command, agentId } as never) as Promise<{ deny?: string }>
const recorded = (files: Map<string, string>) => modelEntries([...files.entries()].filter(([path]) => path.startsWith(`${LEDGER}/`)).map(([, text]) => text).join('\n'))

test("every sidekick model call is recorded in the ledger with its purpose, agent and order; /scope usage shows sidekick's slice", async ($, on) => {
  const harness = standIn(on)
  await start($, harness)
  // The judge, twice, for order O3's agent; its stop review reads the run.
  expect((await bash($, 'systemctl restart agent-host-kiosk.service', 'agent-1')).deny).toBeUndefined()
  expect((await bash($, 'systemctl status agent-host-kiosk.service', 'agent-1')).deny).toBeUndefined()
  await $.turn.complete({ agentId: 'agent-1', answer: 'Done.', durationMs: 10, isAborted: false, turnId: 'a1', reason: 'answer' } as never)
  // A heads-up on request.
  harness.messages.push({ role: 'user', text: 'Ship the fix.', toolUses: [] } as never, { role: 'assistant', text: 'Shipped.', toolUses: [] } as never)
  await $.command.run(composer('heads-up', 'now'))
  await settle()

  const report = String((await $.command.run(composer('scope', 'usage'))).text)
  const entries = recorded(harness.files)
  // As many entries as calls the engine answered: none bypassed the helper.
  expect(entries.length).toBe(harness.completions.length)
  expect(entries.map(item => item.purpose).sort()).toEqual(['heads-up', 'judge', 'judge', 'stop-review'])
  expect(entries.find(item => item.purpose === 'judge')).toMatchObject({ kind: 'model', v: 1, plugin: 'sidekick', model: 'claude-haiku-5-5', input: 10, output: 5, session: 'session-1', agentId: 'agent-1', orderId: 'O3' })
  expect(entries.find(item => item.purpose === 'stop-review')).toMatchObject({ agentId: 'agent-1', orderId: 'O3' })
  expect(entries.find(item => item.purpose === 'heads-up')).not.toHaveProperty('agentId')
  // No prompt or command text rides on an entry.
  expect(JSON.stringify(entries)).not.toContain('systemctl')

  expect(report.split('\n')[0]).toContain("Sidekick's model calls, the last 7 days")
  expect(report).toMatch(/\n {2}judge\s+2\s+30\s+10\s+\d+%/)
  expect(report).toMatch(/\n {2}stop-review\s+1\s+15\s+5\s+\d+%/)
  expect(report).toContain('run /council usage')
  expect(String((await $.command.run(composer('scope', 'usage since 2026-99-01'))).text)).toContain('Usage: /scope usage [since YYYY-MM-DD]')
})

test("a ledger that can't be written never breaks the judge: its decision stands, and nothing else changes", async ($, on) => {
  const harness = standIn(on, { failWrite: true })
  await start($, harness)
  expect((await bash($, 'systemctl restart agent-host-kiosk.service', 'agent-1')).deny).toBeUndefined()
  expect(harness.completions.length).toBe(1)
  expect(harness.tools).toEqual(['Bash'])
  expect(String((await $.command.run(composer('scope', 'usage'))).text)).toContain('not recorded')
  expect(harness.toasts.filter(toast => toast.includes('usage')).length).toBe(0)
})
