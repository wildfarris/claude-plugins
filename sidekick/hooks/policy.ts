// The guard's policy: plain-language rules a session's commands are held to.
// Pure.
//
// Three sources of rules, in this order:
//   default    a few rules sidekick ships with (below), for every session;
//   standing   the owner's own, added with `/rules add policy <sentence>`;
//   order      a council order's plain-sentence `forbid` entries, for its agent.
// And one of exceptions, last, in a section of its own:
//   leave      a council order's granted leave, for its agent alone: specific
//              exceptions to the default rules, ruled on with the plan and
//              granted by the person (or the council, as they set it).
//
// Code enforces what it can decide for certain (the folder rule through the
// scope guard, the path rules, the inline-code ban), leave or not; the policy
// judge reads these sentences for everything else.

import { textKey } from './values'

export type PolicySource = { kind: 'default' } | { kind: 'standing' } | { kind: 'order'; id: string } | { kind: 'leave'; id: string }
export type PolicyRule = { text: string; source: PolicySource }

// The folder rule is the scope guard's; the judge reads it too, so a script
// that writes outside the folders is caught where the code can't see it.
export const FOLDER_RULE = 'Change files only inside the target folders.'

export const DEFAULT_POLICY: readonly string[] = [
  FOLDER_RULE,
  'Stop only processes this session started, by their ID.',
  "Don't change installed tools, PATH, services or system settings.",
  "Don't run Python.",
]

export const MAX_POLICY_SENTENCE = 300

// A sentence as stored: one line, trimmed, at most MAX_POLICY_SENTENCE
// characters; undefined for an empty one.
export function policySentence(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  const line = text.replace(/\s+/g, ' ').trim()
  return line === '' ? undefined : line.slice(0, MAX_POLICY_SENTENCE)
}

const sameSentence = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

// The policy a call answers to: the defaults, the standing sentences, then
// its order's, each once; then its order's granted leave (already checked by
// shape: council-glimpse.ts grantedLeave), each once. Only an order's own
// agent is given its order, so only its policy carries the leave.
export function assemblePolicy(standing: readonly string[], order?: { id: string; sentences: readonly string[]; leave?: readonly string[] }): PolicyRule[] {
  const rules: PolicyRule[] = []
  const add = (text: string | undefined, source: PolicySource) => {
    const isLeave = source.kind === 'leave'
    if (text !== undefined && !rules.some(rule => (rule.source.kind === 'leave') === isLeave && sameSentence(rule.text, text))) rules.push({ text, source })
  }
  for (const text of DEFAULT_POLICY) add(text, { kind: 'default' })
  for (const text of standing) add(policySentence(text), { kind: 'standing' })
  for (const text of order?.sentences ?? []) add(policySentence(text), { kind: 'order', id: order!.id })
  for (const text of order?.leave ?? []) add(policySentence(text), { kind: 'leave', id: order!.id })
  return rules
}

export const isLeave = (rule: PolicyRule) => rule.source.kind === 'leave'

// The heading of a policy's leave section.
export const leaveHeading = (id: string) => `Granted to this order by the person's council (${id}):`

const sourceText = (source: PolicySource) => (source.kind === 'order' ? `order ${source.id}` : source.kind === 'standing' ? "the owner's standing rule" : 'default')

// What the judge reads (and /scope show prints): the rules, numbered, then the
// leave in a section of its own, when the order has any.
export function policyLines(rules: readonly PolicyRule[]): string[] {
  const numbered = rules.filter(rule => !isLeave(rule)).map((rule, index) => `${index + 1}. ${rule.text} (${sourceText(rule.source)})`)
  const leave = rules.filter(isLeave)
  if (leave.length === 0) return numbered
  const id = leave[0]!.source.kind === 'leave' ? leave[0]!.source.id : 'O?'
  return [...numbered, '', leaveHeading(id), ...leave.map(rule => `- ${rule.text}`)]
}

// Changes whenever a sentence does: part of every cached verdict's key.
// (Leave is marked, so a rule and a granted exception never share a key.)
export const policyVersion = (rules: readonly PolicyRule[]) => textKey(rules.map(rule => (isLeave(rule) ? `leave: ${rule.text}` : rule.text)).join('\n'))
