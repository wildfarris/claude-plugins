// The guard's numbers for one session: how each shell command was settled,
// the judge's calls and tokens, and the stop reviews. Kept in sidekick's
// local store (never sent anywhere), for 7 days; /scope show prints them.
// Pure.

import type { JudgeEvent, ShellDecision } from './policy-guard'

export type GuardMetrics = {
  // Settled by code.
  fastPath: number
  cacheHits: number
  inline: number
  scope: number
  complexity: number
  // The judge.
  judgeCalls: number
  judgeAllows: number
  judgeBlocks: number
  failClosed: number
  budget: number
  judgeOff: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  // Calls spent per budget (an agent's id, or 'owner'): restored at start,
  // so a reload doesn't reset a budget.
  callsByBudget: Record<string, number>
  // The stop reviews of order agents.
  reviews: number
  reviewWarnings: number
  savedAt: number
}

export const METRICS_RETENTION_MS = 7 * 24 * 3600 * 1000

export const emptyMetrics = (): GuardMetrics => ({
  fastPath: 0,
  cacheHits: 0,
  inline: 0,
  scope: 0,
  complexity: 0,
  judgeCalls: 0,
  judgeAllows: 0,
  judgeBlocks: 0,
  failClosed: 0,
  budget: 0,
  judgeOff: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  callsByBudget: {},
  reviews: 0,
  reviewWarnings: 0,
  savedAt: 0,
})

const NUMBER_KEYS = ['fastPath', 'cacheHits', 'inline', 'scope', 'complexity', 'judgeCalls', 'judgeAllows', 'judgeBlocks', 'failClosed', 'budget', 'judgeOff', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'reviews', 'reviewWarnings', 'savedAt'] as const

// Stored metrics, read by shape (anything missing or wrong is zero).
export function readMetrics(value: unknown): GuardMetrics {
  const metrics = emptyMetrics()
  if (value === null || typeof value !== 'object') return metrics
  const stored = value as Record<string, unknown>
  for (const key of NUMBER_KEYS) {
    const number = stored[key]
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0) metrics[key] = number
  }
  if (stored.callsByBudget !== null && typeof stored.callsByBudget === 'object') {
    for (const [budget, calls] of Object.entries(stored.callsByBudget as Record<string, unknown>)) if (typeof calls === 'number' && calls >= 0) metrics.callsByBudget[budget] = calls
  }
  return metrics
}

const MAX_BUDGET_KEYS = 200

export function countDecision(metrics: GuardMetrics, decision: ShellDecision, event: JudgeEvent, budgetKey: string): void {
  if (event.judged) {
    metrics.judgeCalls++
    metrics.callsByBudget[budgetKey] = (metrics.callsByBudget[budgetKey] ?? 0) + 1
    const keys = Object.keys(metrics.callsByBudget)
    if (keys.length > MAX_BUDGET_KEYS) delete metrics.callsByBudget[keys[0]!]
  }
  if (event.usage) {
    metrics.inputTokens += event.usage.input
    metrics.outputTokens += event.usage.output
    metrics.cacheReadTokens += event.usage.cacheRead
  }
  if (decision.kind === 'allow') {
    if (decision.via === 'fast-path' || decision.via === 'code') metrics.fastPath++
    else if (decision.via === 'cache') metrics.cacheHits++
    else if (decision.via === 'judge') metrics.judgeAllows++
    else metrics.judgeOff++
  } else if (decision.kind === 'refuse') {
    if (decision.via === 'inline') metrics.inline++
    else if (decision.via === 'scope') metrics.scope++
    else if (decision.via === 'complexity') metrics.complexity++
    else if (decision.via === 'judge') metrics.judgeBlocks++
    else if (decision.via === 'fail-closed') metrics.failClosed++
    else metrics.budget++
  }
}

export function metricsText(metrics: GuardMetrics): string {
  const tokens = metrics.inputTokens + metrics.outputTokens > 0 ? `, ${metrics.inputTokens} tokens in (${metrics.cacheReadTokens} from the cache) and ${metrics.outputTokens} out` : ''
  return [
    `Guard this session: ${metrics.fastPath} cleared by code, ${metrics.cacheHits} from the cache, ${metrics.inline} inline-code refusals, ${metrics.scope} scope refusals, ${metrics.complexity} too complex.`,
    `Judge: ${metrics.judgeCalls} calls${tokens}; ${metrics.judgeAllows} allowed, ${metrics.judgeBlocks} blocked, ${metrics.failClosed} failed closed, ${metrics.budget} refused past the budget or usage cap.`,
    `Stop reviews: ${metrics.reviews}, ${metrics.reviewWarnings} with a warning.`,
  ].join('\n')
}
