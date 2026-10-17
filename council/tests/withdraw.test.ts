import { describe, expect, test } from 'claude-code/testing'

import type { Order } from '../types'
import { EXPIRED_REASON, ORDER_EXPIRY_MS, emptyCourt, isFinished, isFolded, isOpen, matchOrder, newOrders, readWithdrawal, withExpired, withFinishedFolded, withdrawOrders, withdrawalText } from '../hooks/court'

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

describe('withdrawing orders', () => {
  test('the input names the orders by id, once each in any case, and a short reason', () => {
    expect(readWithdrawal({ ids: ['o3', ' O4 ', 'O3'], reason: 'The person changed their mind.' })).toEqual({ ids: ['O3', 'O4'], reason: 'The person changed their mind.' })
    expect(readWithdrawal({ ids: ['O1'], reason: 'first line\nsecond line' })).toEqual({ ids: ['O1'], reason: 'first line' })
    expect(readWithdrawal({ ids: [], reason: 'x' })).toHaveProperty('error')
    expect(readWithdrawal({ reason: 'x' })).toHaveProperty('error')
    expect(readWithdrawal({ ids: [7, '', null], reason: 'x' })).toHaveProperty('error')
    expect(readWithdrawal({ ids: ['O1'] })).toHaveProperty('error')
    expect(readWithdrawal({ ids: ['O1'], reason: '   ' })).toHaveProperty('error')
  })

  test('an approved order that was not dispatched is withdrawn, finished as of now, with its reason', () => {
    const result = withdrawOrders([order('O1'), order('O2')], ['O2'], 'plan changed', 5_000)
    expect(result.withdrawn).toEqual(['O2'])
    expect(result.refused).toEqual([])
    expect(result.orders[0]).toEqual(order('O1'))
    expect(result.orders[1]).toMatchObject({ id: 'O2', status: 'withdrawn', withdrawnReason: 'plan changed', endedAt: 5_000 })
    expect(isOpen(result.orders[1]!)).toBe(false)
    expect(isFinished(result.orders[1]!)).toBe(true)
  })

  test('unknown, dispatched, done, failed and already withdrawn orders are refused, each by name, and left alone', () => {
    const orders = [
      order('O1', { status: 'dispatched', agentId: 'a1', startedAt: 2_000 }),
      order('O2', { status: 'done' }),
      order('O3', { status: 'failed' }),
      order('O4', { status: 'withdrawn', withdrawnReason: 'earlier' }),
      order('O5'),
    ]
    const result = withdrawOrders(orders, ['O1', 'O2', 'O3', 'O4', 'O9', 'O5'], 'no longer needed', 5_000)
    expect(result.withdrawn).toEqual(['O5'])
    expect(result.refused).toEqual([
      { id: 'O1', why: 'already dispatched (an agent is carrying it)' },
      { id: 'O2', why: 'already done' },
      { id: 'O3', why: 'already finished (failed)' },
      { id: 'O4', why: 'already withdrawn' },
      { id: 'O9', why: 'no such order' },
    ])
    expect(result.orders.slice(0, 4)).toEqual(orders.slice(0, 4))
    expect(result.orders[4]!.status).toBe('withdrawn')
  })

  test('the reply says what was withdrawn and what was refused', () => {
    const text = withdrawalText({ withdrawn: ['O5'], refused: [{ id: 'O9', why: 'no such order' }] }, 'no longer needed')
    expect(text).toContain('Withdrew O5 (no longer needed).')
    expect(text).toContain('Refused O9: no such order.')
    expect(withdrawalText({ withdrawn: [], refused: [{ id: 'O1', why: 'already withdrawn' }] }, 'x')).toContain('Withdrew nothing.')
  })

  test('a withdrawn order is not open to a dispatch', () => {
    const orders = [order('O1', { status: 'withdrawn', withdrawnReason: 'x' }), order('O2')]
    expect(matchOrder(orders, 'council:knight', 'O1 api limits', '')).toBeUndefined()
    // Not even as the only knight order on its folder.
    expect(matchOrder([orders[0]!], 'council:knight', 'limits in api', '')).toBeUndefined()
    expect(matchOrder(orders, 'council:knight', 'O2 api limits', '')?.id).toBe('O2')
  })

  test('withdrawn orders fold away like finished ones', () => {
    const withdrawn = order('O1', { status: 'withdrawn', withdrawnReason: 'x' })
    expect(isFolded(withdrawn)).toBe(false)
    const folded = withFinishedFolded([withdrawn, order('O2'), order('O3', { status: 'dispatched' })])
    expect(folded.map(isFolded)).toEqual([true, false, false])
  })
})

describe('order expiry', () => {
  test('new orders record when they were approved', () => {
    const proposal = { plan: 'p', dispatches: [{ folder: 'api', role: 'knight' as const, task: 't', todos: ['a'] }] }
    expect(newOrders(emptyCourt(), proposal, '/dev/work', [], 7_000)[0]!.approvedAt).toBe(7_000)
    expect(newOrders(emptyCourt(), proposal, '/dev/work', [])[0]).not.toHaveProperty('approvedAt')
  })

  test('the default is a day', () => {
    expect(ORDER_EXPIRY_MS).toBe(24 * 60 * 60 * 1000)
  })

  test('an undispatched order expires after the limit, withdrawn as "expired"', () => {
    const orders = [order('O1', { approvedAt: 1_000 })]
    expect(withExpired(orders, 1_000 + ORDER_EXPIRY_MS - 1)).toBe(orders)
    const [expired] = withExpired(orders, 1_000 + ORDER_EXPIRY_MS)
    expect(expired).toMatchObject({ status: 'withdrawn', withdrawnReason: EXPIRED_REASON, endedAt: 1_000 + ORDER_EXPIRY_MS })
    expect(isFinished(expired!)).toBe(true)
  })

  test('dispatched and finished orders never expire', () => {
    const orders = [
      order('O1', { status: 'dispatched', agentId: 'a1', startedAt: 2_000 }),
      order('O2', { status: 'done' }),
      order('O3', { status: 'failed' }),
      order('O4', { status: 'withdrawn', withdrawnReason: 'earlier' }),
    ]
    expect(withExpired(orders, 1_000 + 10 * ORDER_EXPIRY_MS)).toBe(orders)
  })

  test('an approved order with no approval time (saved before expiry) is stamped, which starts its clock', () => {
    const { approvedAt: _approvedAt, ...old } = order('O1')
    const [stamped] = withExpired([old], 9_000)
    expect(stamped).toMatchObject({ status: 'approved', approvedAt: 9_000 })
    expect(withExpired([stamped!], 9_000 + ORDER_EXPIRY_MS - 1)[0]!.status).toBe('approved')
    expect(withExpired([stamped!], 9_000 + ORDER_EXPIRY_MS)[0]!.status).toBe('withdrawn')
  })
})
