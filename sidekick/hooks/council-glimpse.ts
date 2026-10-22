// The council mod, as sidekick's bar sees it. Pure.
//
// Contract: sidekick reads the council mod's own state ({ plugin: 'council',
// key: 'council' }) and relies on its `topic`, `phase`, and each advisor's
// `status` and `concern`. Checked by shape, never trusted; a rename there
// shows up here as no council.

import { policySentence } from './policy'
import { readPathRule, type PathRule } from './scope-rules'

// What sidekick reads of the council mod's state (any plugin may read any
// value, so this is checked by shape rather than trusted).
export type CouncilGlimpse = { topic: string; phase: 'briefing' | 'deliberating' | 'done' | 'failed'; finished: number; total: number; gravest: number | null }

const PHASES = ['briefing', 'deliberating', 'done', 'failed'] as const

export function councilGlimpse(value: unknown): CouncilGlimpse | null {
  if (typeof value !== 'object' || value === null) return null
  const council = value as { topic?: unknown; phase?: unknown; advisors?: unknown }
  const phase = PHASES.find(name => name === council.phase)
  if (typeof council.topic !== 'string' || phase === undefined || typeof council.advisors !== 'object' || council.advisors === null) return null
  const reports = Object.values(council.advisors as Record<string, { status?: unknown; concern?: unknown }>)
  // An advisor that abstained has finished too (council 0.2's member files allow it).
  const finished = reports.filter(report => report.status === 'done' || report.status === 'abstained' || report.status === 'failed')
  const concerns = reports.filter(report => report.status === 'done' && typeof report.concern === 'number').map(report => report.concern as number)
  return { topic: council.topic, phase, finished: finished.length, total: reports.length, gravest: concerns.length === 0 ? null : Math.max(...concerns) }
}

export function councilStatus(glimpse: CouncilGlimpse): string {
  if (glimpse.phase === 'briefing') return 'the herald is briefing'
  if (glimpse.phase === 'deliberating') return `${glimpse.finished}/${glimpse.total} advisors in`
  if (glimpse.phase === 'failed') return 'dissolved'
  return glimpse.gravest === null ? 'adjourned' : `adjourned · gravest concern ${glimpse.gravest}/5`
}

// What a subagent's council order holds it to: its id, its folder, the
// path rules in its `forbid` (each checked by shape; a malformed one is
// dropped). From the council mod's `court` value: its orders' `agentId`,
// `status` (only 'dispatched' holds: an agent at work under the order, a woken
// one included; held, unsettled, waiting or recalled-and-ended ones don't),
// `id`, `folder`, `forbid`, `policy`, `leave` and `leaveStatus`. Its plain-language rules
// (for the policy judge) are its `policy` sentences, and any `forbid` entry
// that is a sentence rather than a glob (a string, or `{ rule }`). Its
// `leave` (exceptions to the judge's default rules, from council 0.3) is read
// only while its `leaveStatus` is 'granted', and only when it keeps its shape:
// present when there is some.
export type CarriedOrder = { id: string; folder: string; forbid: PathRule[]; policy: string[]; leave?: string[] }

export const MAX_LEAVE = 4
export const MIN_LEAVE_SENTENCE = 10
export const MAX_LEAVE_SENTENCE = 200

// An order's granted leave, checked by shape: at most MAX_LEAVE strings, each
// one line of MIN_LEAVE_SENTENCE to MAX_LEAVE_SENTENCE characters with no
// control characters or angle brackets. A sentence out of shape is dropped,
// never cut short or mended; anything else is no leave.
export function grantedLeave(order: { leave?: unknown; leaveStatus?: unknown }): string[] {
  if (order.leaveStatus !== 'granted' || !Array.isArray(order.leave)) return []
  const leave = (order.leave as unknown[]).flatMap(entry => {
    if (typeof entry !== 'string' || /[\x00-\x1f\x7f\p{Zl}\p{Zp}<>]/u.test(entry)) return []
    const sentence = entry.trim()
    return sentence.length >= MIN_LEAVE_SENTENCE && sentence.length <= MAX_LEAVE_SENTENCE ? [sentence] : []
  })
  return [...new Set(leave)].slice(0, MAX_LEAVE)
}

export function orderFor(court: unknown, agentId: string): CarriedOrder | undefined {
  if (typeof court !== 'object' || court === null) return undefined
  const orders = (court as { orders?: unknown }).orders
  if (!Array.isArray(orders)) return undefined
  const order = orders.find(
    (entry): entry is { id?: unknown; folder: string; forbid?: unknown; policy?: unknown; leave?: unknown; leaveStatus?: unknown } =>
      typeof entry === 'object' && entry !== null && (entry as { agentId?: unknown }).agentId === agentId && (entry as { status?: unknown }).status === 'dispatched' && typeof (entry as { folder?: unknown }).folder === 'string',
  )
  if (order === undefined) return undefined
  const forbid = Array.isArray(order.forbid) ? order.forbid.flatMap(entry => readPathRule(entry) ?? []) : []
  const sentences = [
    ...(Array.isArray(order.policy) ? (order.policy as unknown[]) : []),
    ...(Array.isArray(order.forbid) ? (order.forbid as unknown[]).map(entry => (typeof entry === 'object' && entry !== null && !('glob' in entry) ? (entry as { rule?: unknown }).rule : entry)) : []),
  ]
  const policy = [...new Set(sentences.flatMap(entry => policySentence(entry) ?? []))].slice(0, 12)
  const leave = grantedLeave(order)
  return { id: typeof order.id === 'string' && /^O\d+$/.test(order.id) ? order.id : 'O?', folder: order.folder, forbid, policy, ...(leave.length > 0 ? { leave } : {}) }
}

// The folder a subagent's council order scopes it to.
export const orderFolderFor = (court: unknown, agentId: string): string | undefined => orderFor(court, agentId)?.folder
