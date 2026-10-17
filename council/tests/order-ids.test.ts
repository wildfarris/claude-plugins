import { describe, expect, test } from 'claude-code/testing'

import type { Court, Order } from '../types'
import { emptyCourt, matchOrder, newOrders, nextOrderNumber, withOrdersAdded, withdrawOrders } from '../hooks/court'

const order = (id: string, patch: Partial<Order> = {}): Order => ({
  id,
  role: 'knight',
  folder: '/dev/work/api',
  relFolder: 'api',
  task: 'task',
  todos: [{ content: 'a', status: 'pending', activeForm: 'Doing a' }],
  conditions: [],
  status: 'approved',
  agentId: null,
  steps: 0,
  edits: 0,
  report: '',
  startedAt: null,
  endedAt: null,
  approvedAt: 1_000,
  ...patch,
})

const proposal = (count: number) => ({
  plan: 'p',
  dispatches: Array.from({ length: count }, () => ({ folder: 'api', role: 'knight' as const, task: 't', todos: ['a'] })),
})

// What propose_orders does to the court: number the orders, then add them.
const propose = (court: Court, count: number): Court => withOrdersAdded(court, newOrders(court, proposal(count), '/dev/work', []))

const ids = (court: Court) => court.orders.map(entry => entry.id)

describe('order ids', () => {
  test('a fresh court numbers from O1', () => {
    const court = propose(emptyCourt(), 2)
    expect(ids(court)).toEqual(['O1', 'O2'])
    expect(court.nextOrderId).toBe(3)
  })

  test('clearing finished orders does not free their ids', () => {
    let court = propose(emptyCourt(), 3)
    // O1 and O2 finish; O3 is still dispatched.
    court = { ...court, orders: court.orders.map(entry => (entry.id === 'O3' ? { ...entry, status: 'dispatched' as const } : { ...entry, status: 'done' as const })) }
    // Clear finished, as the pane's button and /council court clear do.
    court = { ...court, orders: court.orders.filter(entry => entry.status === 'approved' || entry.status === 'dispatched') }
    expect(ids(court)).toEqual(['O3'])

    court = propose(court, 1)
    expect(ids(court)).toEqual(['O3', 'O4'])
    // The old count-based numbering would have handed out O2 here; a dispatch naming O3 or O4 stays unambiguous.
    expect(new Set(ids(court)).size).toBe(2)
  })

  test('clearing every order still does not restart at O1', () => {
    let court = propose(emptyCourt(), 2)
    court = { ...court, orders: [] }
    expect(ids(propose(court, 1))).toEqual(['O3'])
  })

  test('withdrawing an order does not free its id', () => {
    let court = propose(emptyCourt(), 2)
    court = { ...court, orders: withdrawOrders(court.orders, ['O2'], 'not needed', 5_000).orders }
    // Cleared away afterwards, too.
    court = { ...court, orders: court.orders.filter(entry => entry.status !== 'withdrawn') }
    court = propose(court, 2)
    expect(ids(court)).toEqual(['O1', 'O3', 'O4'])
  })

  test('a court saved without the counter continues after its highest id', () => {
    const saved: Court = { ...emptyCourt(), orders: [order('O2', { status: 'done' }), order('O7'), order('O4', { status: 'withdrawn' })] }
    expect(saved.nextOrderId).toBeUndefined()
    expect(nextOrderNumber(saved)).toBe(8)
    const court = propose(saved, 2)
    expect(ids(court)).toEqual(['O2', 'O7', 'O4', 'O8', 'O9'])
    expect(court.nextOrderId).toBe(10)
  })

  test('ids past O9 compare as numbers, not strings', () => {
    const saved: Court = { ...emptyCourt(), orders: [order('O9'), order('O10'), order('O2')] }
    // As strings "O9" sorts after "O10", which would restart at O10.
    expect(nextOrderNumber(saved)).toBe(11)
    expect(ids(propose(saved, 1))).toEqual(['O9', 'O10', 'O2', 'O11'])
  })

  test('the counter is never lower than a live order, and ignores ids it cannot read', () => {
    expect(nextOrderNumber({ orders: [order('O5')], nextOrderId: 2 })).toBe(6)
    expect(nextOrderNumber({ orders: [order('O5')], nextOrderId: 20 })).toBe(20)
    expect(nextOrderNumber({ orders: [order('weird')], nextOrderId: Number.NaN })).toBe(1)
    expect(nextOrderNumber({ orders: [], nextOrderId: 0 })).toBe(1)
  })

  test('a refused proposal adds nothing and spends no ids', () => {
    const court = propose(emptyCourt(), 2)
    expect(withOrdersAdded(court, []).nextOrderId).toBe(3)
    expect(ids(propose(withOrdersAdded(court, []), 1))).toEqual(['O1', 'O2', 'O3'])
  })

  test('a dispatch naming an id reaches only the order that holds it', () => {
    let court = propose(emptyCourt(), 2)
    court = { ...court, orders: court.orders.map(entry => (entry.id === 'O1' ? { ...entry, status: 'done' as const } : entry)) }
    court = { ...court, orders: court.orders.filter(entry => entry.status !== 'done') }
    court = propose(court, 1)
    expect(matchOrder(court.orders, 'council:knight', 'O3 do it', '')?.id).toBe('O3')
    expect(matchOrder(court.orders, 'council:knight', 'O2 do it', '')?.id).toBe('O2')
    expect(matchOrder(court.orders, 'council:knight', 'O1 do it', '')).toBeUndefined()
  })
})
