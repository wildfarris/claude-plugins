// The person's own words: their last prompts, as typed in the main session,
// and the end of Claude's last answer there. A sitting Claude starts (a
// consult, a ruling on orders or on an amendment) carries a window of them,
// so the members can tell what the person asked from what Claude adds. Pure:
// recording, choosing the window, and the text the members read.
//
// Why: the members otherwise see only Claude's account of the request, and
// an addition written as if the person asked for it sways the vote.

import type { PersonWords, WordsWindow } from '../types'
import { redactSecrets } from './redact'

export const WORDS_LIMITS = {
  // Prompts kept per session.
  kept: 10,
  // The window: the latest prompts, newest first, until this many prompts or
  // this many characters, whichever comes first.
  prompts: 3,
  chars: 600,
  // Everything the window holds (Claude's answer included), at most.
  cap: 2000,
  // A latest prompt shorter than this ("do it") also takes the end of
  // Claude's answer it followed, this long at most.
  short: 40,
  answer: 800,
} as const

export const emptyWords = (): PersonWords => ({ prompts: [], answer: null })

// The last `limit` characters of a text, an ellipsis first when it was cut.
export function tailOf(text: string, limit: number): string {
  if (text.length <= limit) return text
  return limit <= 1 ? '…'.slice(0, limit) : `…${text.slice(text.length - (limit - 1))}`
}

// A prompt the person typed, recorded: redacted, its last WORDS_LIMITS.cap
// characters (no window can hold more), and, when it is short, the end of
// the answer of Claude's it followed. The oldest go past WORDS_LIMITS.kept.
export function withPromptRecorded(words: PersonWords, typed: string): PersonWords {
  const text = redactSecrets(typed.trim())
  if (text === '') return words
  const answered = text.length < WORDS_LIMITS.short && words.answer ? { answered: words.answer } : {}
  return { ...words, prompts: [...words.prompts, { text: tailOf(text, WORDS_LIMITS.cap), ...answered }].slice(-WORDS_LIMITS.kept) }
}

// Claude's answer in the main session, recorded: redacted, its last
// WORDS_LIMITS.answer characters. An empty answer leaves the last one.
export function withAnswerRecorded(words: PersonWords, answer: string): PersonWords {
  const text = redactSecrets(answer.trim())
  return text === '' ? words : { ...words, answer: tailOf(text, WORDS_LIMITS.answer) }
}

// The window a sitting carries, or undefined when nothing was recorded: the
// latest prompts, newest first, until WORDS_LIMITS.prompts of them or
// WORDS_LIMITS.chars characters (the latest is always in); with a latest one
// under WORDS_LIMITS.short characters, the end of Claude's answer before it.
// All of it at most WORDS_LIMITS.cap characters: the oldest prompt in it is
// cut from its front (or left out) until it fits.
export function wordsWindow(words: PersonWords | null | undefined): WordsWindow | undefined {
  const recorded = words?.prompts ?? []
  if (recorded.length === 0) return undefined
  const chosen: string[] = []
  let total = 0
  for (const prompt of [...recorded].reverse()) {
    if (chosen.length >= WORDS_LIMITS.prompts || total >= WORDS_LIMITS.chars) break
    chosen.unshift(prompt.text)
    total += prompt.text.length
  }
  const answered = recorded[recorded.length - 1]!.answered
  const budget = WORDS_LIMITS.cap - (answered?.length ?? 0)
  while (chosen.length > 1 && total - chosen[0]!.length >= budget) total -= chosen.shift()!.length
  if (total > budget) {
    const rest = total - chosen[0]!.length
    chosen[0] = tailOf(chosen[0]!, budget - rest)
  }
  return { prompts: chosen, ...(answered ? { answered } : {}) }
}

// Untrusted text can't close the block it sits in.
const unmarked = (text: string) => text.replace(/<<</g, '‹‹‹').replace(/>>>/g, '›››')

// The window as the members read it.
export function wordsBlock(window: WordsWindow): string {
  const prompts = window.prompts.length === 1 ? [unmarked(window.prompts[0]!)] : window.prompts.map((text, index) => `[${index + 1}] ${unmarked(text)}`)
  return [
    "THE PERSON'S OWN WORDS (verbatim, recorded by the plugin, newest last):",
    '<<<WORDS',
    ...prompts,
    'WORDS>>>',
    ...(window.answered ? ["CLAUDE'S MESSAGE THE PERSON ANSWERED (Claude's words, its end):", '<<<CLAUDE', unmarked(window.answered), 'CLAUDE>>>'] : []),
  ].join('\n')
}

export const CLAUDE_REQUEST = "CLAUDE'S REQUEST (Claude's words, not the person's):"

// What a member is told when a sitting carries the person's words.
export const WORDS_INSTRUCTION =
  "Only the section marked THE PERSON'S OWN WORDS is the person's; the topic, Claude's request and Claude's message are Claude's. Claude's statements about what the person wants count only where the person's own words support them: an addition you can't trace to their words is Claude's, and weigh it as such."

// The optional line a member adds when the request goes past those words.
export const BEYOND_ASK = "Only if the request or plan adds something the person's words don't ask for, add one line: BEYOND: <what it adds, at most 20 words>. Otherwise leave BEYOND out."

// Room for the BEYOND line in a member's answer.
export const BEYOND_TOKENS = 40

const MAX_BEYOND_WORDS = 30
const MAX_BEYOND = 240

// A member's BEYOND line, read leniently (`BEYOND: …`, `**Beyond**: …`,
// `Beyond your request: …`); undefined when it gave none or said there is
// nothing (none, nothing, n/a, -).
export function parseBeyond(text: string): string | undefined {
  const match = /^\W*BEYOND\b[^:\n]{0,20}:[ \t]*(.*)$/im.exec(text)
  const value = match?.[1]?.replace(/^[*_\s]+|[*_\s]+$/g, '').replace(/\s+/g, ' ').trim()
  if (!value || /^(?:none|nothing|no|n\/a|na|nil)[.!]?$|^[-–—.]+$|^nothing (?:beyond|more|added)\b/i.test(value)) return undefined
  const words = value.split(' ')
  const short = words.length > MAX_BEYOND_WORDS ? `${words.slice(0, MAX_BEYOND_WORDS).join(' ')}…` : value
  return short.length > MAX_BEYOND ? `${short.slice(0, MAX_BEYOND - 1)}…` : short
}
