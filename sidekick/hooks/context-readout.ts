// The context readout: how full the context is, what the last turn added, and
// which turns grew it most. Pure: folds each measurement the engine reports
// into the readout, and formats it for the bar.

import type { ContextReadout, ContextBreakdownRow, ContextGrowth } from '../types'
import { estimateTokens, formatTokens } from './values'

export const MAX_GROWTH_HISTORY = 30

export const emptyReadout = (): ContextReadout => ({ tokens: null, creditedTokens: null, window: 0, lastDelta: null, history: [], breakdown: null })


// A measurement after a turn: the change since the last one, credited to the
// turn's prompt. The engine's figure is the last request's input, so it holds
// the previous turn's final answer but not this one's: `answerCharacters`
// (this turn's final answer) is estimated in, and the previous estimate is
// replaced by the real count. A drop is a compaction (or /clear).
export function withMeasurement(readout: ContextReadout, tokens: number | undefined, window: number, prompt: string, answerCharacters = 0): ContextReadout {
  if (tokens === undefined || window <= 0) return readout
  if (readout.tokens === tokens && readout.window === window) return readout
  const credited = tokens + estimateTokens(answerCharacters)
  const previous = readout.creditedTokens ?? readout.tokens
  const delta = previous === null ? null : credited - previous
  const growth: ContextGrowth[] =
    delta !== null && delta > 0 ? [...readout.history, { prompt: prompt.replace(/\s+/g, ' ').trim().slice(0, 80) || '(no prompt)', delta }].slice(-MAX_GROWTH_HISTORY) : readout.history
  // A breakdown taken before this turn no longer matches the totals.
  return { ...readout, tokens, creditedTokens: credited, window, lastDelta: delta, history: growth, breakdown: null }
}

export const percentOf = (readout: ContextReadout) => (readout.tokens === null || readout.window <= 0 ? null : Math.round((readout.tokens / readout.window) * 100))

// `ctx 46% · +12k`; after a compaction, `ctx 14% · −355k`.
export function readoutLabel(readout: ContextReadout): string | null {
  const percent = percentOf(readout)
  if (percent === null) return null
  const delta = readout.lastDelta
  return `ctx ${percent}%${delta === null || delta === 0 ? '' : ` · ${delta > 0 ? '+' : ''}${formatTokens(delta)}`}`
}

export function biggestGrowth(readout: ContextReadout, count: number): ContextGrowth[] {
  return [...readout.history].sort((left, right) => right.delta - left.delta).slice(0, count)
}

// The /context categories worth showing: the counted rows, largest first.
export function breakdownRows(categories: ReadonlyArray<{ name: string; tokens: number; isDeferred: boolean }>): ContextBreakdownRow[] {
  return categories
    .filter(category => !category.isDeferred && category.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens)
    .map(category => ({ name: category.name, tokens: category.tokens }))
}
