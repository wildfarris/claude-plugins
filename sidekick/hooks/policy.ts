// The guard's policy: plain-language rules a session's commands are held to.
// Pure.
//
// Three sources, in this order:
//   default    a few rules sidekick ships with (below), for every session;
//   standing   the owner's own, added with `/rules add policy <sentence>`;
//   order      a council order's plain-sentence `forbid` entries, for its agent.
//
// Code enforces what it can decide for certain (the folder rule through the
// scope guard, the path rules, the inline-code ban); the policy judge reads
// these sentences for everything else.

import { textKey } from './values'

export type PolicySource = { kind: 'default' } | { kind: 'standing' } | { kind: 'order'; id: string }
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
// its order's, each once.
export function assemblePolicy(standing: readonly string[], order?: { id: string; sentences: readonly string[] }): PolicyRule[] {
  const rules: PolicyRule[] = []
  const add = (text: string | undefined, source: PolicySource) => {
    if (text !== undefined && !rules.some(rule => sameSentence(rule.text, text))) rules.push({ text, source })
  }
  for (const text of DEFAULT_POLICY) add(text, { kind: 'default' })
  for (const text of standing) add(policySentence(text), { kind: 'standing' })
  for (const text of order?.sentences ?? []) add(policySentence(text), { kind: 'order', id: order!.id })
  return rules
}

const sourceText = (source: PolicySource) => (source.kind === 'order' ? `order ${source.id}` : source.kind === 'standing' ? "the owner's standing rule" : 'default')

// The numbered list the judge reads (and /scope show prints).
export const policyLines = (rules: readonly PolicyRule[]) => rules.map((rule, index) => `${index + 1}. ${rule.text} (${sourceText(rule.source)})`)

// Changes whenever a sentence does: part of every cached verdict's key.
export const policyVersion = (rules: readonly PolicyRule[]) => textKey(rules.map(rule => rule.text).join('\n'))
