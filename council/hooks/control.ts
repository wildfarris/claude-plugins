// Steering orders under way: no direct messages to their agents (the court's
// session.send block), the person's own /council message, Claude's amendments
// (ruled on by the council, capped) and recalls (no ruling: changes refused,
// then the agent's turn ended for it at a step boundary). Pure.

import type { Order, OrderAmendment, OrderRecall, OrderTodo, Ruling } from '../types'
import { PROGRESS_TOOL, moved } from './court'
import { relativeToRoot } from './paths'

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

const oneLine = (text: string, limit = 300) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

// An order under way: its agent is on it, ended with todos open, or waits to wake.
export const isUnderWay = (order: Pick<Order, 'status'>) => order.status === 'dispatched' || order.status === 'unsettled' || order.status === 'waiting'

// ── Direct messages to order agents ───────────────────────────────────────

// The order whose agent a SendMessage recipient names: its agent id, the name
// the dispatch gave it, or the order id itself (O3). Undefined for anyone
// else. Only orders an agent was sent on count, whatever their status now.
export function orderForRecipient(orders: readonly Order[], to: string): Order | undefined {
  const wanted = to.trim()
  if (wanted === '') return undefined
  const lower = wanted.toLowerCase()
  return orders.find(
    order =>
      order.agentId !== null &&
      (order.agentId === wanted || (order.agentName !== undefined && order.agentName.toLowerCase() === lower) || order.id.toLowerCase() === lower),
  )
}

// Why a model's message to an order's agent is refused, naming what to use
// instead: the main session amends or recalls; a subagent reports to Claude.
export function blockedSendReason(order: Pick<Order, 'id'>, isFromSubagent: boolean): string {
  return isFromSubagent
    ? `Direct messages to ${order.id} are blocked: council agents don't message each other; put it in your final report to Claude instead.`
    : `Direct messages to ${order.id} are blocked: use mcp__council__amend_order to change its task, or mcp__council__recall_order to stop it.`
}

// ── /council message: the person's own word to an agent ───────────────────

export const MAX_MESSAGE = 4000

// Why the person's message can't go, or undefined when it can.
export function messageRefusal(order: Order | undefined, id: string, text: string): string | undefined {
  if (!/^O\d+$/i.test(id) || text.trim() === '') return 'Usage: /council message <order id> <text>, e.g. /council message O3 use the existing helper'
  if (order === undefined) return `No order ${id.toUpperCase()}.`
  if (order.agentId === null) return `${order.id} has no agent (${order.status}): there is no one to message.`
  if (order.status === 'recalled' || order.recall !== undefined) return `${order.id} was recalled: its agent takes no more messages.`
  return undefined
}

// The text the agent reads: framed as the person's, so it is not taken for Claude's.
export const personMessageText = (order: Pick<Order, 'id'>, text: string) => `[Message from the person about order ${order.id}, sent with /council message]\n${text.trim().slice(0, MAX_MESSAGE)}`

export const withMessage = (order: Order, text: string, at: number, result: { isDelivered: boolean; reason?: string }): Order => ({
  ...order,
  messages: [...(order.messages ?? []).slice(-9), { text: oneLine(text, 500), at, isDelivered: result.isDelivered, ...(result.reason ? { reason: oneLine(result.reason, 200) } : {}) }],
})

// ── Amendments ────────────────────────────────────────────────────────────

export const MAX_AMEND_TODOS = 6
export const DEFAULT_AMENDMENTS_PER_ORDER = 1

export type Amendment = { id: string; change: string; reason: string; todos: string[] }

// The amend_order tool's input, checked.
// Fields an amendment may never carry: an order's leave is set only when it
// is proposed, ruled on with the plan and granted before its dispatch.
const LEAVE_FIELDS = ['leave', 'leaveStatus']

export function readAmendment(input: Record<string, unknown>): Amendment | { error: string } {
  if (LEAVE_FIELDS.some(field => field in input)) {
    return { error: "An amendment can't add or change an order's leave: leave is asked only in propose_orders. Recall the order and propose a new one with the leave it needs." }
  }
  if (!isText(input.id)) return { error: 'Name the order to amend (e.g. "O3").' }
  if (!isText(input.change)) return { error: 'Say what changes in the order: the change, in a sentence or two.' }
  if (!isText(input.reason)) return { error: 'Give the reason for the change.' }
  const todos = Array.isArray(input.todos) ? (input.todos as unknown[]).filter(isText).map(todo => todo.trim()) : []
  if (todos.length > MAX_AMEND_TODOS) return { error: `An amendment adds at most ${MAX_AMEND_TODOS} todos.` }
  return { id: input.id.trim().toUpperCase(), change: input.change.trim().slice(0, 2000), reason: oneLine(input.reason), todos }
}

// A change as compared for repeats: case, punctuation and spacing aside.
export const normalizedChange = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

// Why an amendment is refused before the council sits (no model call), or
// undefined when it goes to the council. A pending ruling counts as one.
export function amendRefusal(order: Order | undefined, amendment: Amendment, cap: number): string | undefined {
  if (order === undefined) return `No order ${amendment.id}.`
  if (order.status === 'approved') return `${order.id} has not been dispatched: withdraw it with mcp__council__withdraw_orders and propose the changed order instead.`
  if (!isUnderWay(order)) return `${order.id} is ${order.status}: only an order under way (dispatched, unsettled or waiting) can be amended. Propose a new order with mcp__council__propose_orders.`
  if (order.recall !== undefined) return `${order.id} is being recalled: it can't be amended. Propose a new order with mcp__council__propose_orders if the work is still needed.`
  const earlier = (order.amendments ?? []).find(entry => normalizedChange(entry.change) === normalizedChange(amendment.change))
  if (earlier !== undefined) {
    return `The council already ruled on that change to ${order.id} (${earlier.status === 'ruling' ? 'it is still sitting' : earlier.status}); it is not put again. ${earlier.status === 'refused' ? 'Propose it as a new order, or recall the order with mcp__council__recall_order.' : 'Its agent has it.'}`
  }
  const count = (order.amendments ?? []).length
  if (cap <= 0) return `Amendments are off (amendmentsPerOrder 0). Recall ${order.id} with mcp__council__recall_order and propose a new order, or ask the person to send its agent a word with /council message.`
  if (count >= cap) {
    return `${order.id} already has ${count} amendment${count === 1 ? '' : 's'}, the most an order takes (amendmentsPerOrder ${cap}; refused ones count). Recall it with mcp__council__recall_order and propose a new order, or ask the person to send its agent a word with /council message.`
  }
  return undefined
}

export const pendingAmendment = (amendment: Amendment, at: number): OrderAmendment => ({ change: amendment.change, reason: amendment.reason, todos: amendment.todos, status: 'ruling', at })

const todoMark = (todo: OrderTodo) => (todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[>]' : '[ ]')

// What the advisors read: the order as it stands (task, todos and progress,
// conditions, earlier amendments), then the amendment. The person's request
// comes first when the plugin has it.
export function amendmentBrief(order: Order, amendment: Amendment, petition: string | null): string {
  const done = order.todos.filter(todo => todo.status === 'completed').length
  return [
    ...(petition ? [`The person asked: ${petition}`] : []),
    `Claude asks to amend order ${order.id}, already under way (${order.status}): a ${order.role} (${order.role === 'scout' ? 'reads only' : 'may change files and run commands'}) in ${order.relFolder}/.`,
    `The order's task: ${order.task}`,
    `Its todos (${done} of ${order.todos.length} done): ${order.todos.map(todo => `${todoMark(todo)} ${todo.content}`).join('; ')}`,
    ...(order.conditions.length > 0 ? [`Its conditions: ${order.conditions.join(' ')}`] : []),
    ...(order.leaveStatus === 'granted' && order.leave && order.leave.length > 0 ? [`Its leave (granted; an amendment can't change it): ${order.leave.join(' ')}`] : []),
    ...((order.amendments ?? []).filter(entry => entry.status !== 'ruling').map(entry => `An earlier amendment (${entry.status}): ${entry.change}`)),
    `The amendment: ${amendment.change}`,
    `Why: ${amendment.reason}`,
    ...(amendment.todos.length > 0 ? [`Todos it adds: ${amendment.todos.join('; ')}`] : []),
    'Rule on the amendment as a change to this order. If it is new work rather than a change to this task, say "new work" in your verdict.',
  ].join('\n')
}

// The amendment as its agent reads it: clearly framed, with the council's
// conditions and the todos to add.
export function amendmentText(order: Pick<Order, 'id'>, amendment: Pick<OrderAmendment, 'change' | 'reason' | 'todos'>, conditions: readonly string[]): string {
  return [
    `[Amendment to order ${order.id}, approved by the council]`,
    `Change: ${amendment.change}`,
    `Why: ${amendment.reason}`,
    ...(amendment.todos.length > 0 ? [`Add these todos to your list and report them with ${PROGRESS_TOOL}:\n${amendment.todos.map(todo => `- ${todo}`).join('\n')}`] : []),
    ...(conditions.length > 0 ? [`The council's conditions on this amendment:\n${conditions.map(condition => `- ${condition}`).join('\n')}`] : []),
    'The rest of your order stands. Carry on with it as amended.',
  ].join('\n\n')
}

// The order with an amendment's ruling in place of its pending entry (at
// `index`), and an approved amendment's todos added to its list.
export function withAmendmentRuled(order: Order, index: number, ruled: Partial<OrderAmendment>): Order {
  const amendments = (order.amendments ?? []).map((entry, position) => (position === index ? { ...entry, ...ruled } : entry))
  const added = ruled.status === 'approved' ? (amendments[index]?.todos ?? []).filter(todo => !order.todos.some(existing => existing.content === todo)) : []
  return { ...order, amendments, todos: [...order.todos, ...added.map(content => ({ content, status: 'pending' as const, activeForm: content }))] }
}

// The order without the pending entry at `index` (the council could not sit: no ruling, no count).
export const withoutAmendment = (order: Order, index: number): Order => ({ ...order, amendments: (order.amendments ?? []).filter((_, position) => position !== index) })

const leftText = (order: Order, cap: number) => {
  const left = Math.max(0, cap - (order.amendments ?? []).length)
  return `${order.id} has ${left === 0 ? 'no' : left} amendment${left === 1 ? '' : 's'} left.`
}

// What amend_order tells Claude after the ruling.
export function amendmentResultText(order: Order, result: Ruling & { conditions: string[] }, delivery: { isDelivered: boolean; reason?: string } | undefined, cap: number): string {
  if (!result.isApproved) {
    const isNewWork = /\bnew work\b/i.test(result.reason)
    return [
      `The council refused the amendment to ${order.id} (gravest concern ${result.gravest}/5). ${result.reason}`.trim(),
      isNewWork
        ? 'The council called it new work: propose it as a new order with mcp__council__propose_orders.'
        : 'Leave the order as it is, recall it with mcp__council__recall_order, or propose a new order.',
      leftText(order, cap),
    ].join('\n')
  }
  return [
    `The council approved the amendment to ${order.id} (gravest concern ${result.gravest}/5).`,
    ...(result.conditions.length > 0 ? ['Conditions (sent with it):', ...result.conditions.map(condition => `- ${condition}`)] : []),
    delivery === undefined
      ? `It was not sent: ${order.id} is no longer under way.`
      : delivery.isDelivered
        ? `It was sent to ${order.id}'s agent${order.status === 'dispatched' ? '' : ', which wakes to it'}.`
        : `It could not reach ${order.id}'s agent: ${delivery.reason ?? 'not delivered'}.`,
    leftText(order, cap),
  ].join('\n')
}

// ── Recalls ───────────────────────────────────────────────────────────────

// Model requests a recalled agent may still make; the next is answered for it.
export const RECALL_STEPS = 3

// What a recalled agent may still call: reads and its progress.
export const RECALL_ALLOWED_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'TodoWrite', PROGRESS_TOOL])

export const recallDenial = (recall: Pick<OrderRecall, 'reason'>) => `Recalled: ${recall.reason}. Make no more changes. Report what you changed and its state, then stop.`

export type RecallRequest = { id: string; reason: string }

// The recall_order tool's input, checked.
export function readRecall(input: Record<string, unknown>): RecallRequest | { error: string } {
  if (!isText(input.id)) return { error: 'Name the order to recall (e.g. "O3").' }
  if (!isText(input.reason)) return { error: 'Give a short reason for the recall; its agent is shown it.' }
  return { id: input.id.trim().toUpperCase(), reason: oneLine(input.reason, 200) }
}

// The order with a file its file tools changed (absolute, once each, at most 100).
export function withTouched(order: Order, path: string): Order {
  if (path === '' || (order.touched ?? []).includes(path)) return order
  return { ...order, touched: [...(order.touched ?? []), path].slice(-100) }
}

// The files it touched, relative to its folder where they are inside it.
export const touchedFiles = (order: Pick<Order, 'folder' | 'touched'>) => (order.touched ?? []).map(path => relativeToRoot(order.folder, path) || path)

const touchedText = (order: Pick<Order, 'folder' | 'touched'>) => {
  const files = touchedFiles(order)
  return files.length === 0 ? 'no files through its file tools' : files.join(', ')
}

const SHELL_NOTE = 'Shell changes are not tracked.'

// The final reply the council gives in a recalled agent's place, at its ceiling.
export const recallReply = (order: Order) =>
  [
    `Recalled: ${order.recall?.reason ?? 'by the council'}. The council ended this turn at its recall ceiling.`,
    `Files changed with file tools: ${touchedFiles(order).join(', ') || 'none'}. ${SHELL_NOTE} Check the folder's state (e.g. git status) before relying on it.`,
  ].join('\n')

// A recalled order's report: the agent's last answer, then what it touched
// (the council's own ceiling reply already says).
export function recalledReport(order: Order, answer: string): string {
  if (order.recall?.isEnded === true) return answer
  const touched = `Touched (file tools): ${touchedFiles(order).join(', ') || 'none'}. ${SHELL_NOTE}`
  return answer.trim() === '' ? touched : `${answer.trim()}\n\n${touched}`
}

// The line the main session gets when a recall lands.
export const recalledLine = (order: Order) =>
  `Council: ${order.id} recalled (${order.recall?.reason ?? 'no reason given'}); touched: ${touchedText(order)} (${SHELL_NOTE.toLowerCase().replace(/\.$/, '')}). Review or revert, then propose a new order if needed.`

// The note appended to a running agent's own conversation when it is recalled.
export const recallNotice = (order: Order) => `[The council recalled order ${order.id}: ${order.recall?.reason ?? ''}] ${recallDenial(order.recall ?? { reason: 'recalled' })}`

// Recalls an order under way: a running one keeps `dispatched` with `recall`
// set until its turn ends; an unsettled or waiting one is recalled at once.
export function recallOrder(orders: readonly Order[], request: RecallRequest, by: OrderRecall['by'], now: number): { orders: Order[]; order: Order } | { error: string } {
  const order = orders.find(candidate => candidate.id === request.id)
  if (order === undefined) return { error: `No order ${request.id}.` }
  if (order.status === 'approved') return { error: `${order.id} has not been dispatched: withdraw it with mcp__council__withdraw_orders instead.` }
  if (order.recall !== undefined) return { error: `${order.id} is already recalled.` }
  if (!isUnderWay(order)) return { error: `${order.id} is ${order.status}; only an order under way (dispatched, unsettled or waiting) can be recalled.` }
  const recall: OrderRecall = { reason: request.reason, at: now, by, steps: 0 }
  const next = order.status === 'dispatched' ? { ...order, recall } : moved({ ...order, recall }, 'recall', now, { report: recalledReport({ ...order, recall }, order.report) })
  if (next === undefined) return { error: `${order.id} can't be recalled from ${order.status}.` }
  return { orders: orders.map(candidate => (candidate.id === order.id ? next : candidate)), order: next }
}

// What the recall tool or command says.
export const recallText = (order: Order) =>
  order.status === 'recalled'
    ? `${order.id} is recalled; touched: ${touchedText(order)} (${SHELL_NOTE.toLowerCase().replace(/\.$/, '')}).${order.role === 'knight' ? ` ${order.relFolder}/ is free.` : ''} Review or revert, then propose a new order if needed.`
    : `${order.id} is recalled: its agent's changing tool calls are refused from now on (reads and progress still pass), and its turn is ended for it within ${RECALL_STEPS} more model requests. You will be told which files it touched.`

// A recalled agent's model request: `answer` (end its turn with the council's
// reply) once it has had its RECALL_STEPS, otherwise counted and let through.
export function recallStep(order: Order): { order: Order; isAnswered: boolean } {
  const recall = order.recall!
  if (recall.isEnded === true || recall.steps >= RECALL_STEPS) return { order: { ...order, recall: { ...recall, isEnded: true } }, isAnswered: true }
  return { order: { ...order, recall: { ...recall, steps: recall.steps + 1 } }, isAnswered: false }
}

// ── The tools ─────────────────────────────────────────────────────────────

export const AMEND_ORDER_DESCRIPTION =
  "Change the task of a council order already under way (dispatched, unsettled or waiting). Direct messages to order agents are blocked; this is how you steer one. The council rules on the change as it rules on a plan (no summons); an approved amendment is sent to the order's agent with its conditions, and its todos are added to the order. Each order takes at most amendmentsPerOrder amendments (default 1), refused ones included; a repeat of a change already ruled on, or one to a finished order, is refused without the council sitting. For new work, propose a new order; to stop one, mcp__council__recall_order. Main session only."

export const AMEND_ORDER_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'The order id, e.g. "O3".' },
    change: { type: 'string', description: 'What changes in its task, in a sentence or two.' },
    reason: { type: 'string', description: 'Why, in a short phrase.' },
    todos: { type: 'array', items: { type: 'string' }, description: `Optional: todos the change adds (at most ${MAX_AMEND_TODOS}).` },
  },
  required: ['id', 'change', 'reason'],
}

export const RECALL_ORDER_DESCRIPTION = `Stop a council order under way (dispatched, unsettled or waiting), with no council ruling. Its agent's changing tool calls (edits, shell, council tools but progress) are refused from then on with your reason, while reads still pass; after ${RECALL_STEPS} more model requests its turn is ended for it, between steps, never mid-tool. The order becomes recalled, its folder is freed, its wakes are refused, and you are told which files its file tools touched (shell changes are not tracked). Main session only.`

export const RECALL_ORDER_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'The order id, e.g. "O3".' },
    reason: { type: 'string', description: 'Why, in a short phrase; its agent is shown it.' },
  },
  required: ['id', 'reason'],
}
