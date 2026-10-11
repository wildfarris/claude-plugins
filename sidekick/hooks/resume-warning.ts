// The resume warning's wording. Pure.

import type { ResumeWarning } from '../types'
import { formatTokens } from './values'

export function formatAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} minutes`
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)} hours`
  return `${Math.round(seconds / 86400)} days`
}

export function resumeWarningLines(warning: ResumeWarning): { headline: string; detail: string } {
  const cost = warning.estimatedCacheWriteUsd === null ? '' : ` (about $${warning.estimatedCacheWriteUsd.toFixed(2)} at list price)`
  return {
    headline: `This session was last active ${formatAge(warning.secondsSinceLastResponse)} ago; its prompt cache has likely expired.`,
    detail: `Your next prompt re-sends ${formatTokens(warning.contextTokens)} tokens of context uncached${cost}. Consider /compact or a fresh session.`,
  }
}

// The engine's SessionStart fields for a resume or fork; undefined when the
// warning doesn't apply.
export function resumeWarningFrom(input: {
  source?: string
  prompt_cache_likely_expired?: boolean
  seconds_since_last_response?: number
  context_tokens?: number
  estimated_cache_write_usd?: number
}): ResumeWarning | undefined {
  if (input.source !== 'resume' && input.source !== 'fork') return undefined
  if (input.prompt_cache_likely_expired !== true) return undefined
  return {
    secondsSinceLastResponse: input.seconds_since_last_response ?? 0,
    contextTokens: input.context_tokens ?? 0,
    estimatedCacheWriteUsd: input.estimated_cache_write_usd ?? null,
    isAcknowledged: false,
    heldPrompt: null,
  }
}
