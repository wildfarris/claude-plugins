// Usage: what sidekick's own model calls cost, in tokens, kept as `model`
// entries in the session's ledger (ledger.ts), on this machine only. Pure:
// the hooks module writes the entries and reads the ledgers back.
//
// /scope usage shows sidekick's slice by purpose; the council plugin's
// /council usage reads the same entries for the whole split. The price table
// matches the council's (council/hooks/usage.ts).

import type { ModelUsage } from 'claude-code'

import type { ModelEntry } from './ledger'

export const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_REPORT_DAYS = 7

export type Tokens = { input: number; cacheRead: number; cacheWrite: number; output: number }

const ZERO: Tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0)

export function tokensOf(usage: Partial<ModelUsage> | null | undefined): Tokens {
  if (usage === null || usage === undefined) return { ...ZERO }
  return { input: count(usage.input_tokens), cacheRead: count(usage.cache_read_input_tokens), cacheWrite: count(usage.cache_creation_input_tokens), output: count(usage.output_tokens) }
}

const addTokens = (left: Tokens, right: Tokens): Tokens => ({
  input: left.input + right.input,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  output: left.output + right.output,
})

export const totalTokens = (tokens: Tokens) => tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output

// One model call as a ledger entry.
export function modelEntry(fields: { at: number; purpose: string; model: string; effort?: string | number; session: string; usage: Partial<ModelUsage> | null | undefined; agentId?: string; orderId?: string }): ModelEntry {
  return {
    kind: 'model',
    v: 1,
    at: fields.at,
    plugin: 'sidekick',
    purpose: fields.purpose,
    model: fields.model,
    ...(fields.effort !== undefined ? { effort: String(fields.effort) } : {}),
    ...tokensOf(fields.usage),
    session: fields.session,
    ...(fields.agentId !== undefined ? { agentId: fields.agentId } : {}),
    ...(fields.orderId !== undefined ? { orderId: fields.orderId } : {}),
  }
}

const isTokens = (value: Record<string, unknown>) => ['input', 'cacheRead', 'cacheWrite', 'output'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key] as number))

// The `model` entries of a ledger segment, read without parsing the rest.
export function modelEntries(text: string): ModelEntry[] {
  const entries: ModelEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"kind":"model"')) continue
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      if (value.kind === 'model' && typeof value.at === 'number' && typeof value.purpose === 'string' && typeof value.model === 'string' && isTokens(value)) entries.push(value as unknown as ModelEntry)
    } catch {
      // skipped
    }
  }
  return entries
}

// ── Prices ────────────────────────────────────────────────────────────────

// Dollars per million tokens, input and output, by model family; approximate.
export const PRICES = { opus: { input: 5, output: 25 }, sonnet: { input: 3, output: 15 }, haiku: { input: 1, output: 5 } } as const

// A model of no known family is priced as opus.
export function familyOf(model: string): keyof typeof PRICES {
  const name = model.toLowerCase()
  if (name.includes('haiku')) return 'haiku'
  if (name.includes('sonnet')) return 'sonnet'
  return 'opus'
}

export function costOf(tokens: Tokens, model: string): number {
  const price = PRICES[familyOf(model)]
  return (tokens.input * price.input + tokens.cacheRead * price.input * 0.1 + tokens.cacheWrite * price.input * 1.25 + tokens.output * price.output) / 1_000_000
}

// ── The report ────────────────────────────────────────────────────────────

export function dayOf(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dayStart(day: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return undefined
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const start = new Date(year, month - 1, date)
  return start.getFullYear() === year && start.getMonth() === month - 1 && start.getDate() === date ? start.getTime() : undefined
}

// `/scope usage`'s arguments: nothing (the last 7 days) or `since YYYY-MM-DD`.
export function parseSince(words: readonly string[], now: number): { since: number; label: string } | { error: string } {
  if (words.length === 0) {
    const day = dayOf(now - (DEFAULT_REPORT_DAYS - 1) * DAY_MS)
    return { since: dayStart(day)!, label: `the last ${DEFAULT_REPORT_DAYS} days (since ${day})` }
  }
  const given = words[0] === 'since' ? words.slice(1) : words
  const start = given.length === 1 ? dayStart(given[0]!) : undefined
  return start === undefined ? { error: 'Usage: /scope usage [since YYYY-MM-DD]. The default is the last 7 days.' } : { since: start, label: `since ${given[0]}` }
}

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
export const LEDGER_DAYS = 14

// Sidekick's slice, by purpose: tokens, output and each purpose's share of
// sidekick's own total, then where the whole split is.
export function scopeUsageReport(entries: readonly ModelEntry[], since: { since: number; label: string }, now: number): string {
  const kept = entries.filter(entry => entry.at >= since.since)
  const sums = new Map<string, { tokens: Tokens; cost: number; calls: number }>()
  for (const entry of kept) {
    const sum = sums.get(entry.purpose) ?? { tokens: ZERO, cost: 0, calls: 0 }
    sums.set(entry.purpose, { tokens: addTokens(sum.tokens, entry), cost: sum.cost + costOf(entry, entry.model), calls: sum.calls + 1 })
  }
  const pointer = 'For the whole split (main sessions, council dispatches, members and sidekick), run /council usage.'
  const clipped = since.since < now - LEDGER_DAYS * DAY_MS ? ` Ledgers keep ${LEDGER_DAYS} days, so older calls are gone.` : ''
  if (kept.length === 0) return [`Sidekick's model calls, ${since.label}: not recorded.${clipped}`, COVERAGE_NOTE, pointer].join('\n')
  const whole = [...sums.values()].reduce((total, sum) => total + sum.cost, 0)
  const all = [...sums.values()].reduce((total, sum) => ({ tokens: addTokens(total.tokens, sum.tokens), cost: total.cost + sum.cost, calls: total.calls + sum.calls }), { tokens: ZERO, cost: 0, calls: 0 })
  const cells = [
    ['', 'calls', 'tokens', 'output', SHARE_HEADING],
    ['Sidekick', String(all.calls), compactCount(totalTokens(all.tokens)), compactCount(all.tokens.output), '100%'],
    ...[...sums.entries()].sort((left, right) => right[1].cost - left[1].cost).map(([purpose, sum]) => [`  ${purpose}`, String(sum.calls), compactCount(totalTokens(sum.tokens)), compactCount(sum.tokens.output), percent(sum.cost, whole)]),
  ]
  const widths = [0, 1, 2, 3].map(index => Math.max(...cells.map(cell => cell[index]!.length)))
  const table = cells.map(cell => `${cell[0]!.padEnd(widths[0]!)}  ${cell[1]!.padStart(widths[1]!)}  ${cell[2]!.padStart(widths[2]!)}  ${cell[3]!.padStart(widths[3]!)}  ${cell[4]}`.trimEnd())
  return [`Sidekick's model calls, ${since.label}:${clipped}`, ...table, COVERAGE_NOTE, pointer].join('\n')
}

export const COVERAGE_NOTE =
  "Counted: only sessions on this machine where sidekick was loaded with the TL;DR record on (its ledger), from sidekick 0.19.0 on. Tokens are input + cache read + cache write + output; the share prices each model family per million tokens (opus $5/$25, sonnet $3/$15, haiku $1/$5 in/out; cache reads 0.1×, cache writes 1.25× input), so it is approximate."
