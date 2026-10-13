// A small tally of an order's tool calls, drawn beside its counts in the
// court: one glyph per ten calls, at most ten glyphs, a role's own mark, and a
// dagger when the order fell. Pure.
//
// The glyphs are all in fonts Windows Terminal and the desktop app have (or
// fall back to without a colour emoji): ⚔ (Segoe UI Symbol), ○ (Geometric
// Shapes, the court already draws ● and ○) and † (Latin punctuation).

import type { OrderRole, OrderStatus } from '../types'

export const CALLS_PER_GLYPH = 10
export const MAX_GLYPHS = 10

// Knights fight; scouts only look, so theirs is a quiet hollow mark.
export const TALLY_GLYPH = { knight: '⚔', scout: '○' } as const
export const FALLEN_MARK = '†'

// The glyphs for `calls` tool calls: one per ten, rounded down, ten at most;
// any beyond ten glyphs show as +N (N more tens). A failed order ends with †.
// Empty when there is nothing to show (under ten calls, and not failed).
export function tallyGlyphs(calls: number, role: OrderRole, status: OrderStatus): string {
  const tens = Math.floor(Math.max(0, Number.isFinite(calls) ? calls : 0) / CALLS_PER_GLYPH)
  const shown = Math.min(tens, MAX_GLYPHS)
  const more = tens - shown
  return `${TALLY_GLYPH[role].repeat(shown)}${more > 0 ? `+${more}` : ''}${status === 'failed' ? FALLEN_MARK : ''}`
}

// The tally with its number beside it (e.g. "⚔⚔⚔ 34 calls"), or '' when the
// tally is empty, so a short order's row stays as it was.
export function tallyLabel(calls: number, role: OrderRole, status: OrderStatus): string {
  const glyphs = tallyGlyphs(calls, role, status)
  return glyphs === '' ? '' : `${glyphs} ${calls} call${calls === 1 ? '' : 's'}`
}
