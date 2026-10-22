// Usage: what this session's model calls and model requests cost, in tokens,
// kept on this machine only. Pure: the hooks module reads and writes the files.
//
// Two kinds of line in ~/.claude/council/usage/<session>.jsonl, a file each
// session writes alone (no lock):
// - a call record: one of the council's own model calls ($.model.complete or
//   $.model.fork: a member's vote, the herald, the arbiter, ...), its purpose,
//   model and token counts;
// - a step total: the session's model requests (turn.step), summed per day,
//   category (main, dispatch, advisor, other) and model, one line per order
//   for dispatches, rewritten as the totals grow.
// /council usage reads them back, with sidekick's own records from its ledgers.

import type { ModelUsage } from 'claude-code'

export const USAGE_FOLDER = '.claude/council/usage'
export const SIDEKICK_LEDGERS = '.claude/sidekick/ledgers'
export const DAY_MS = 24 * 60 * 60 * 1000
// Files older than this are deleted, at most once a session.
export const USAGE_RETENTION_MS = 60 * DAY_MS
// Sidekick keeps its ledgers (and so its records) this long.
export const SIDEKICK_RETENTION_DAYS = 14
// Model requests summed in memory before the totals are written (a main turn's
// end and the session's end always write).
export const STEP_FLUSH_EVERY = 25
// Call records kept per session file; past it the oldest are folded into one
// record per day, purpose and model (`calls` says how many).
export const MAX_CALL_RECORDS = 2000
export const DEFAULT_REPORT_DAYS = 7

export type Tokens = { input: number; cacheRead: number; cacheWrite: number; output: number }

export type UsageRecord = Tokens & {
  v: 1
  at: number
  plugin: 'council' | 'sidekick'
  purpose: string
  model: string
  effort?: string
  session: string
  agentId?: string
  orderId?: string
  level?: number
  // A folded record: how many calls it sums.
  calls?: number
}

export type StepCategory = 'main' | 'dispatch' | 'advisor' | 'other'

export type StepTotal = Tokens & {
  v: 1
  // When it was last written.
  at: number
  // The local day its requests were counted on (YYYY-MM-DD).
  day: string
  category: StepCategory
  model: string
  requests: number
  session: string
  // A dispatch's order, its level, role and folder (relative to the root).
  orderId?: string
  level?: number
  role?: string
  folder?: string
}

// Who an agent is, for its model requests.
export type AgentKind = { category: 'dispatch'; orderId: string; level: number; role: string; folder: string } | { category: 'advisor' }

export const ZERO: Tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0)

// The engine's four counts, in our names; zeros for none.
export function tokensOf(usage: Partial<ModelUsage> | null | undefined): Tokens {
  if (usage === null || usage === undefined) return { ...ZERO }
  return { input: count(usage.input_tokens), cacheRead: count(usage.cache_read_input_tokens), cacheWrite: count(usage.cache_creation_input_tokens), output: count(usage.output_tokens) }
}

export const addTokens = (left: Tokens, right: Tokens): Tokens => ({
  input: left.input + right.input,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  output: left.output + right.output,
})

export const totalTokens = (tokens: Tokens) => tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output

export const isEmpty = (tokens: Tokens) => totalTokens(tokens) === 0

// The local day of a time, YYYY-MM-DD.
export function dayOf(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// Local midnight of a YYYY-MM-DD day; undefined when it isn't one.
export function dayStart(day: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return undefined
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const start = new Date(year, month - 1, date)
  return start.getFullYear() === year && start.getMonth() === month - 1 && start.getDate() === date ? start.getTime() : undefined
}

// ── Records ───────────────────────────────────────────────────────────────

export function callRecord(fields: {
  at: number
  plugin: 'council' | 'sidekick'
  purpose: string
  model: string
  effort?: string | number
  session: string
  usage: Partial<ModelUsage> | null | undefined
  agentId?: string
  orderId?: string
  level?: number
}): UsageRecord {
  return {
    v: 1,
    at: fields.at,
    plugin: fields.plugin,
    purpose: fields.purpose,
    model: fields.model,
    ...(fields.effort !== undefined ? { effort: String(fields.effort) } : {}),
    ...tokensOf(fields.usage),
    session: fields.session,
    ...(fields.agentId !== undefined ? { agentId: fields.agentId } : {}),
    ...(fields.orderId !== undefined ? { orderId: fields.orderId } : {}),
    ...(fields.level !== undefined ? { level: fields.level } : {}),
  }
}

// The key a step total is summed under.
export const stepKey = (total: Pick<StepTotal, 'day' | 'category' | 'model' | 'orderId'>) => `${total.day}|${total.category}|${total.orderId ?? ''}|${total.model}`

// A delta of model requests added into the totals (by key), stamped `at`.
export function withStepsAdded(
  totals: ReadonlyMap<string, StepTotal>,
  delta: { day: string; at: number; session: string; category: StepCategory; model: string; tokens: Tokens; requests: number; agent?: AgentKind },
): Map<string, StepTotal> {
  const order = delta.agent?.category === 'dispatch' ? delta.agent : undefined
  const fields = { day: delta.day, category: delta.category, model: delta.model, ...(order ? { orderId: order.orderId } : {}) }
  const key = stepKey(fields)
  const existing = totals.get(key)
  const next = new Map(totals)
  next.set(key, {
    v: 1,
    at: delta.at,
    ...fields,
    requests: (existing?.requests ?? 0) + delta.requests,
    session: delta.session,
    ...addTokens(existing ?? ZERO, delta.tokens),
    ...(order ? { level: order.level, role: order.role, folder: order.folder } : {}),
  })
  return next
}

// Past `max` records, the oldest beyond half of it are folded into one record
// per day, purpose, model and effort.
export function foldCalls(calls: readonly UsageRecord[], max = MAX_CALL_RECORDS): UsageRecord[] {
  if (calls.length <= max) return [...calls]
  const keep = Math.floor(max / 2)
  const old = calls.slice(0, calls.length - keep)
  const folded = new Map<string, UsageRecord>()
  for (const record of old) {
    const key = `${dayOf(record.at)}|${record.purpose}|${record.model}|${record.effort ?? ''}`
    const existing = folded.get(key)
    folded.set(
      key,
      existing === undefined
        ? { ...record, calls: record.calls ?? 1, agentId: undefined, orderId: undefined }
        : { ...existing, ...addTokens(existing, record), at: Math.max(existing.at, record.at), calls: (existing.calls ?? 1) + (record.calls ?? 1) },
    )
  }
  const cleaned = [...folded.values()].map(record => JSON.parse(JSON.stringify(record)) as UsageRecord)
  return [...cleaned, ...calls.slice(calls.length - keep)]
}

const isTokens = (value: Record<string, unknown>) => ['input', 'cacheRead', 'cacheWrite', 'output'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key] as number))

// A usage file's lines: call records and step totals; any other line skipped.
export function parseUsageFile(text: string): { calls: UsageRecord[]; steps: StepTotal[] } {
  const calls: UsageRecord[] = []
  const steps: StepTotal[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let value: Record<string, unknown>
    try {
      value = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null || value.v !== 1 || typeof value.at !== 'number' || !isTokens(value) || typeof value.model !== 'string') continue
    if (typeof value.category === 'string' && typeof value.day === 'string' && typeof value.requests === 'number') steps.push(value as unknown as StepTotal)
    else if (typeof value.purpose === 'string' && (value.plugin === 'council' || value.plugin === 'sidekick')) calls.push(value as unknown as UsageRecord)
  }
  return { calls, steps }
}

export const serializeUsage = (calls: readonly UsageRecord[], steps: Iterable<StepTotal>) => {
  const lines = [...calls, ...steps].map(line => JSON.stringify(line))
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

// A session id as a file name: letters, digits, dashes and underscores.
export const usageFileName = (session: string) => `${session.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'session'}.jsonl`

export const isUsageFileName = (name: string) => /^[A-Za-z0-9_-]{1,120}\.jsonl$/.test(name)

// The usage files to delete: older than the retention, never the current one.
export function expiredUsageFiles(files: ReadonlyArray<{ name: string; mtimeMs: number; kind: string }>, current: string, now: number): string[] {
  return files.filter(file => file.kind === 'file' && file.name !== current && isUsageFileName(file.name) && now - file.mtimeMs > USAGE_RETENTION_MS).map(file => file.name)
}

// Sidekick's records, read loosely from its ledger segments: the `model` lines.
export function sidekickRecords(text: string): UsageRecord[] {
  const records: UsageRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"kind":"model"')) continue
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      if (value.kind !== 'model' || typeof value.at !== 'number' || !isTokens(value) || typeof value.purpose !== 'string') continue
      records.push({ ...(value as unknown as UsageRecord), plugin: 'sidekick', model: typeof value.model === 'string' ? value.model : 'unknown' })
    } catch {
      // skipped
    }
  }
  return records
}

// ── Prices ────────────────────────────────────────────────────────────────

// Dollars per million tokens, input and output, by model family. Approximate,
// and only for weighing one row against another.
export const PRICES = { opus: { input: 5, output: 25 }, sonnet: { input: 3, output: 15 }, haiku: { input: 1, output: 5 } } as const
export const CACHE_READ_FACTOR = 0.1
export const CACHE_WRITE_FACTOR = 1.25

export type Family = keyof typeof PRICES

// A model's family by its name; a model of no known family is priced as opus.
export function familyOf(model: string): Family {
  const name = model.toLowerCase()
  if (name.includes('haiku')) return 'haiku'
  if (name.includes('sonnet')) return 'sonnet'
  return 'opus'
}

export function costOf(tokens: Tokens, model: string): number {
  const price = PRICES[familyOf(model)]
  return (tokens.input * price.input + tokens.cacheRead * price.input * CACHE_READ_FACTOR + tokens.cacheWrite * price.input * CACHE_WRITE_FACTOR + tokens.output * price.output) / 1_000_000
}

// ── The report ────────────────────────────────────────────────────────────

// `/council usage`'s arguments: nothing (the last 7 days), or `since
// YYYY-MM-DD` (or the day alone).
export function parseSince(args: string, now: number): { since: number; day: string; label: string } | { error: string } {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    const day = dayOf(now - (DEFAULT_REPORT_DAYS - 1) * DAY_MS)
    return { since: dayStart(day)!, day, label: `the last ${DEFAULT_REPORT_DAYS} days (since ${day})` }
  }
  const given = words[0] === 'since' ? words.slice(1) : words
  const start = given.length === 1 ? dayStart(given[0]!) : undefined
  if (start === undefined) return { error: 'Usage: /council usage [since YYYY-MM-DD]. The default is the last 7 days.' }
  return { since: start, day: given[0]!, label: `since ${given[0]}` }
}

export type Row = { label: string; tokens: Tokens; cost: number; depth: 0 | 1; note?: string }

type Sum = { tokens: Tokens; cost: number }
const NONE: Sum = { tokens: ZERO, cost: 0 }
const plus = (sum: Sum, tokens: Tokens, model: string): Sum => ({ tokens: addTokens(sum.tokens, tokens), cost: sum.cost + costOf(tokens, model) })

function grouped<T>(items: readonly T[], keyOf: (item: T) => string, tokensOfItem: (item: T) => Tokens, modelOf: (item: T) => string): Map<string, Sum> {
  const sums = new Map<string, Sum>()
  for (const item of items) {
    const key = keyOf(item)
    sums.set(key, plus(sums.get(key) ?? NONE, tokensOfItem(item), modelOf(item)))
  }
  return sums
}

const COUNCIL_PURPOSES = ['member votes', 'herald', 'brief', 'triage', 'arbiter', 'summons-round2', 'amend', 'report', 'guidance']
const purposeGroup = (purpose: string) => (purpose.startsWith('member:') ? 'member votes' : purpose)

// The rows of the report: main sessions, dispatches (by level, then the top
// five orders), advisors, other subagents, the council's own calls by
// purpose, and sidekick's by purpose (null: not recorded).
export function usageRows(input: { steps: readonly StepTotal[]; calls: readonly UsageRecord[]; sidekick: readonly UsageRecord[] | null; sinceDay: string; since: number; now: number }): Row[] {
  const steps = input.steps.filter(total => total.day >= input.sinceDay)
  const calls = input.calls.filter(record => record.at >= input.since)
  const sum = (items: readonly StepTotal[]) => items.reduce((total, item) => plus(total, item, item.model), NONE)
  const rows: Row[] = []
  const row = (label: string, value: Sum, depth: 0 | 1 = 0, note?: string) => rows.push({ label, tokens: value.tokens, cost: value.cost, depth, ...(note ? { note } : {}) })

  row('Main sessions', sum(steps.filter(total => total.category === 'main')))
  const dispatches = steps.filter(total => total.category === 'dispatch')
  row('Dispatches', sum(dispatches))
  const byLevel = grouped(dispatches, total => String(total.level ?? '?'), total => total, total => total.model)
  for (const level of [...byLevel.keys()].sort()) row(`level ${level}`, byLevel.get(level)!, 1)
  const byOrder = grouped(dispatches, total => `${total.session}|${total.orderId ?? '?'}`, total => total, total => total.model)
  const top = [...byOrder].sort((left, right) => right[1].cost - left[1].cost).slice(0, 5)
  for (const [key, value] of top) {
    const sample = dispatches.find(total => `${total.session}|${total.orderId ?? '?'}` === key)!
    row(`${sample.orderId ?? '?'} ${sample.role ?? ''} ${sample.folder ?? ''}`.replace(/\s+/g, ' ').trim() + ` · ${sample.session.slice(0, 8)}`, value, 1)
  }
  row('Advisors (council:advisor)', sum(steps.filter(total => total.category === 'advisor')))
  row('Other subagents', sum(steps.filter(total => total.category === 'other')))

  const council = calls.filter(record => record.plugin === 'council')
  row("Council members' calls", council.reduce((total, record) => plus(total, record, record.model), NONE))
  const byPurpose = grouped(council, record => purposeGroup(record.purpose), record => record, record => record.model)
  const rank = (purpose: string) => (COUNCIL_PURPOSES.includes(purpose) ? COUNCIL_PURPOSES.indexOf(purpose) : COUNCIL_PURPOSES.length)
  const purposes = [...byPurpose.keys()].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))
  for (const purpose of purposes) row(purpose, byPurpose.get(purpose)!, 1)

  if (input.sidekick === null) {
    row('Sidekick', NONE, 0, 'not recorded')
  } else {
    const sidekick = input.sidekick.filter(record => record.at >= input.since)
    const isClipped = input.since < input.now - SIDEKICK_RETENTION_DAYS * DAY_MS
    row('Sidekick', sidekick.reduce((total, record) => plus(total, record, record.model), NONE), 0, isClipped ? `its ledgers keep ${SIDEKICK_RETENTION_DAYS} days` : undefined)
    const bySidekickPurpose = grouped(sidekick, record => record.purpose, record => record, record => record.model)
    for (const purpose of [...bySidekickPurpose.keys()].sort()) row(purpose, bySidekickPurpose.get(purpose)!, 1)
  }
  return rows
}

// 1234 → 1.2k; 1234567 → 1.2M.
export function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 100_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`
  return String(value)
}

const percent = (part: number, whole: number) => {
  if (whole <= 0) return '—'
  const value = (part / whole) * 100
  return value > 0 && value < 1 ? '<1%' : `${Math.round(value)}%`
}

export const SHARE_HEADING = '≈ share (price-weighted, approximate)'

// One short table: tokens (all four counts), output alone, and each row's
// share of the whole by an approximate price; a share is of the top rows' sum.
export function formatUsageTable(rows: readonly Row[]): string {
  const whole = rows.filter(row => row.depth === 0).reduce((total, row) => total + row.cost, 0)
  const cells = rows.map(row => [
    `${row.depth === 1 ? '  ' : ''}${row.label}`,
    row.note === 'not recorded' ? 'not recorded' : compactCount(totalTokens(row.tokens)),
    row.note === 'not recorded' ? '' : compactCount(row.tokens.output),
    row.note === 'not recorded' ? '' : `${percent(row.cost, whole)}${row.note ? ` (${row.note})` : ''}`,
  ])
  const heading = ['', 'tokens', 'output', SHARE_HEADING]
  const widths = [0, 1, 2].map(index => Math.max(...[heading, ...cells].map(cell => cell[index]!.length)))
  const line = (cell: string[]) => `${cell[0]!.padEnd(widths[0]!)}  ${cell[1]!.padStart(widths[1]!)}  ${cell[2]!.padStart(widths[2]!)}  ${cell[3]}`.trimEnd()
  return [line(heading), ...cells.map(line)].join('\n')
}

export const COVERAGE_NOTE =
  'Counted: only sessions on this machine where the council plugin was loaded, from council 0.4.0 on (sidekick 0.19.0 for its rows). Tokens are input + cache read + cache write + output. The share prices each model family per million tokens (opus $5/$25, sonnet $3/$15, haiku $1/$5 in/out; cache reads 0.1×, cache writes 1.25× input; other models as opus), so it is approximate.'

export function usageReport(input: { label: string; steps: readonly StepTotal[]; calls: readonly UsageRecord[]; sidekick: readonly UsageRecord[] | null; sinceDay: string; since: number; now: number }): string {
  const rows = usageRows(input)
  return [`Usage, ${input.label}:`, formatUsageTable(rows), COVERAGE_NOTE].join('\n')
}

// An order's tokens, compactly, for the court ("1.2M tok"); '' for none.
export const tokensLabel = (usage: Tokens | undefined) => (usage === undefined || isEmpty(usage) ? '' : `${compactCount(totalTokens(usage))} tok`)
