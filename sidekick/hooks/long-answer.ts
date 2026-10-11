// The long-answer review: one model call that writes a TL;DR of Claude's
// final answer, one heads-up note when something clears the bar, and a
// long-lived rule suggestion when the turn shows one is worth keeping. Pure.

import type { HeadsUpNote, RuleSuggestion } from '../types'
import type { NoteLength, SidekickSettings } from './settings'

export const MAX_REMEMBERED_TOPICS = 50
// The answer is cut to this before it is sent, to bound the call's cost; a
// TL;DR alone needs less of it than a heads-up or a rule.
export const MAX_REVIEWED_ANSWER_CHARACTERS = 24000
export const MAX_SUMMARIZED_ANSWER_CHARACTERS = 8000
const MAX_PROMPT_CHARACTERS = 2000

export type ReviewRequest = {
  userPrompt: string
  answer: string
  changedFiles: string[]
  knownTopics: string[]
  shownTopics: string[]
  wantsSummary: boolean
  wantsHeadsUp: boolean
  // Rule suggestions: offered only when there is context to judge from.
  wantsRule: boolean
  blockedCalls: string[]
  topLevelFolders: string[]
  existingRules: string[]
  declinedRules: string[]
}

// A rule as the review proposes it; it becomes a RuleSuggestion once checked.
export type RuleProposal = Pick<RuleSuggestion, 'spec' | 'reason'>

export type Review = {
  summary: string | null
  note: HeadsUpNote | null
  rule: RuleProposal | null
}

export type ReviewOutcome = 'shown' | 'nothing' | 'duplicate' | 'failed'

export const REVIEW_OUTCOME_TEXT: Record<ReviewOutcome, string> = {
  shown: 'Heads-up: shown above the prompt.',
  nothing: 'Heads-up: nothing worth flagging in the last answer.',
  duplicate: 'Heads-up: only found something you have already seen.',
  failed: 'Heads-up: the review failed (API error, timeout, or no answer to review).',
}

const EXPLANATION_RULES: Record<NoteLength, string> = {
  brief: 'at most 40 words, plain language, no jargon',
  standard: 'at most 90 words: what it is, why it matters here, and what the user could do',
  detailed: 'at most 180 words: what it is, the concrete consequence, and the options the user has',
}

const truncate = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}\n…(cut)` : text)

function bulletList(topics: string[]): string {
  return topics.length > 0 ? topics.map(topic => `- ${topic}`).join('\n') : '(none)'
}

export const REVIEW_SYSTEM_PROMPT =
  'You review an AI coding assistant\'s final answer on behalf of its user. You are terse and precise, and you follow the requested output format exactly.'

export function buildReviewPrompt(settings: SidekickSettings, request: ReviewRequest): string {
  const sections = [
    `THE USER ASKED:\n${truncate(request.userPrompt, MAX_PROMPT_CHARACTERS) || '(not available)'}`,
    `FILES CHANGED THIS TURN:\n${bulletList(request.changedFiles)}`,
    `THE ASSISTANT'S FINAL ANSWER:\n${truncate(request.answer, request.wantsHeadsUp || request.wantsRule ? MAX_REVIEWED_ANSWER_CHARACTERS : MAX_SUMMARIZED_ANSWER_CHARACTERS)}`,
  ]
  const tasks: string[] = []
  if (request.wantsSummary) {
    tasks.push('SUMMARY: a TL;DR of the answer for someone skimming, at most 25 words, one sentence.')
  }
  if (request.wantsHeadsUp) {
    const rules = [
      'HEADLINE: the ONE thing in this answer the user should really know but would likely miss (a risky or hard-to-undo change, a buried caveat, an assumption made without asking, something that will cause trouble later), at most 12 words. Most answers have nothing that clears this bar: then write HEADLINE: NONE.',
      `DETAIL: the explanation behind the headline, ${EXPLANATION_RULES[settings.noteLength]}. Omit when the headline is NONE.`,
    ]
    if (settings.focusTopics) rules.push(`Weigh these areas first: ${settings.focusTopics}.`)
    if (settings.ignoreTopics) rules.push(`Never raise anything about: ${settings.ignoreTopics}.`)
    rules.push(`The user already knows these; never raise them:\n${bulletList(request.knownTopics)}`)
    rules.push(`Already shown recently; do not repeat:\n${bulletList(request.shownTopics)}`)
    tasks.push(rules.join('\n'))
  }
  if (request.wantsRule) {
    tasks.push(
      [
        'RULE: a long-lived rule worth adding to keep this multi-repo workspace safe, or NONE. Suggest one only when the turn clearly shows it: the user said a folder must never be touched, or work strayed between folders that should stay apart. Most turns need none.',
        'Forms (folders by the names listed below): `fence <folder> | <why, at most 12 words>` to forbid edits to a folder, or `exclusive <folder> <folder> | <why, at most 12 words>` to forbid changing both in one session.',
        `Folders under the workspace root:\n${bulletList(request.topLevelFolders)}`,
        `Calls the scope guard blocked this turn:\n${bulletList(request.blockedCalls)}`,
        `Rules already in place, or declined by the user; never suggest these:\n${bulletList([...request.existingRules, ...request.declinedRules])}`,
      ].join('\n'),
    )
  }
  sections.push(`Write only these lines, each starting with its label:\n${tasks.join('\n\n')}`)
  return sections.join('\n\n')
}

const isNone = (text: string) => /^none\b/i.test(text.trim())

const unquote = (text: string) => text.trim().replace(/^["'`]+|["'`]+$/g, '').trim()

function parseRuleLine(text: string): RuleProposal | null {
  const ruleMatch = /RULE:\s*(.+)/i.exec(text)
  if (!ruleMatch) return null
  const [spec = '', reason = ''] = unquote(ruleMatch[1]!).split('|').map(part => unquote(part))
  return spec === '' || isNone(spec) ? null : { spec, reason }
}

export function parseReview(text: string): Review {
  const summaryMatch = /SUMMARY:\s*([\s\S]*?)(?=\n\s*(?:HEADLINE|DETAIL|RULE):|$)/i.exec(text)
  const headlineMatch = /HEADLINE:\s*(.+)/i.exec(text)
  const detailMatch = /DETAIL:\s*([\s\S]+?)(?=\n\s*RULE:|$)/i.exec(text)
  const summary = summaryMatch ? unquote(summaryMatch[1]!) : ''
  const headline = headlineMatch ? unquote(headlineMatch[1]!) : ''
  const note =
    headline === '' || isNone(headline)
      ? null
      : { headline, detail: detailMatch ? detailMatch[1]!.trim() : '', isExpanded: false }
  return { summary: summary === '' || isNone(summary) ? null : summary, note, rule: parseRuleLine(text) }
}

export const sameTopic = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase()

export function withTopic(topics: string[], topic: string): string[] {
  return topics.some(existing => sameTopic(existing, topic)) ? topics : [...topics, topic].slice(-MAX_REMEMBERED_TOPICS)
}
