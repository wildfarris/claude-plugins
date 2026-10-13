// An order's tool calls and tasks, as sites along its road. Every todo is a
// stop on the road: a finished one shows how much work it took (a level from
// 0 to 5 by the tool calls made while it was in progress), the agent stands
// at the first unfinished one, and the stops still ahead show an enemy tent.
// This file only counts and decides; sprites.ts draws. Pure.

import type { Order, OrderTodo } from '../types'

export const CALLS_PER_LEVEL = 10
export const MAX_LEVEL = 5

// A finished stop's work level: one per ten calls, rounded down, at most 5
// (0 draws nothing).
export const siteLevel = (calls: number | undefined): number =>
  Math.min(MAX_LEVEL, Math.floor(Math.max(0, calls !== undefined && Number.isFinite(calls) ? calls : 0) / CALLS_PER_LEVEL))

export type Site = { kind: 'work'; level: number } | { kind: 'ahead' }
export type RoadSites = { sites: Site[]; stands: number }

// The stops of an order's road, in todo order. A finished order has done them
// all. The agent stands at the first todo not completed (past the last one
// when all are), which is where its road ends up when todos finish in order.
export function sitesOf(order: Pick<Order, 'todos' | 'status'>): RoadSites {
  const isOver = order.status === 'done'
  const sites: Site[] = order.todos.map(todo => (isOver || todo.status === 'completed' ? { kind: 'work', level: siteLevel(todo.calls) } : { kind: 'ahead' }))
  const first = sites.findIndex(site => site.kind === 'ahead')
  return { sites, stands: first === -1 ? sites.length : first }
}

// One tool call by the agent, credited to the task it has in progress; a call
// made with none in progress (before its first list, between two tasks) is
// credited to no task, and still counts in the order's steps.
export function creditCall(todos: OrderTodo[]): OrderTodo[] {
  const index = todos.findIndex(todo => todo.status === 'in_progress')
  return index === -1 ? todos : todos.map((todo, at) => (at === index ? { ...todo, calls: (todo.calls ?? 0) + 1 } : todo))
}

// A list the agent has just written replaces the old one, so the calls
// already credited move across: to the same task text (once each), else to the
// same position.
export function carryCalls(previous: OrderTodo[], next: OrderTodo[]): OrderTodo[] {
  const used = new Set<number>()
  return next.map((todo, at) => {
    const same = previous.findIndex((old, index) => !used.has(index) && old.content === todo.content)
    const from = same !== -1 ? same : at < previous.length && !used.has(at) ? at : -1
    if (from === -1) return todo
    used.add(from)
    const calls = previous[from]!.calls
    return calls === undefined ? todo : { ...todo, calls }
  })
}

// "N calls" for an order's row, or '' before its first call.
export const callsLabel = (calls: number) => (calls > 0 ? `${calls} call${calls === 1 ? '' : 's'}` : '')
