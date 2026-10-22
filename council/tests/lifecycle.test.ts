// The order lifecycle: every allowed transition, every refused one, and the
// pure steps around it (turn ends, settling, releasing, wakes).

import { describe, expect, test } from 'claude-code/testing'

import type { Order } from '../types'
import {
  ORDER_LIFECYCLE,
  RELEASED_NOTE,
  holdsClaim,
  isFinished,
  moved,
  nextStatus,
  readSettlement,
  releaseOrder,
  settleOrder,
  turnEvent,
  unsettledLine,
  wakeVerdict,
  type OrderEvent,
} from '../hooks/court'

const order = (id: string, patch: Partial<Order> = {}): Order => ({
  id,
  role: 'knight',
  folder: '/dev/work/api',
  relFolder: 'api',
  task: 'task',
  todos: [
    { content: 'Read', status: 'completed', activeForm: 'Reading' },
    { content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
    { content: 'Commit', status: 'pending', activeForm: 'Committing' },
  ],
  conditions: [],
  status: 'approved',
  agentId: null,
  steps: 0,
  edits: 0,
  report: '',
  startedAt: null,
  endedAt: null,
  ...patch,
})

const STATUSES: Order['status'][] = ['approved', 'dispatched', 'unsettled', 'waiting', 'done', 'stopped-early', 'failed', 'lost', 'withdrawn']
const EVENTS: OrderEvent[] = ['spawn', 'withdraw', 'expire', 'turn-done', 'turn-open', 'turn-failed', 'gone', 'settle-done', 'settle-stopped-early', 'settle-failed', 'settle-waiting', 'wake', 'release']

// The whole table, written out: every transition the lifecycle allows. Any
// (status, event) pair not here must be refused.
const ALLOWED: ReadonlyArray<[Order['status'], OrderEvent, Order['status']]> = [
  ['approved', 'spawn', 'dispatched'],
  ['approved', 'withdraw', 'withdrawn'],
  ['approved', 'expire', 'withdrawn'],
  ['dispatched', 'turn-done', 'done'],
  ['dispatched', 'turn-open', 'unsettled'],
  ['dispatched', 'turn-failed', 'failed'],
  ['dispatched', 'gone', 'lost'],
  ['unsettled', 'settle-done', 'done'],
  ['unsettled', 'settle-stopped-early', 'stopped-early'],
  ['unsettled', 'settle-failed', 'failed'],
  ['unsettled', 'settle-waiting', 'waiting'],
  ['unsettled', 'wake', 'dispatched'],
  ['unsettled', 'gone', 'lost'],
  ['unsettled', 'release', 'lost'],
  ['waiting', 'wake', 'dispatched'],
  ['waiting', 'settle-done', 'done'],
  ['waiting', 'settle-stopped-early', 'stopped-early'],
  ['waiting', 'settle-failed', 'failed'],
  ['waiting', 'gone', 'lost'],
  ['waiting', 'release', 'lost'],
  ['done', 'wake', 'dispatched'],
  ['stopped-early', 'wake', 'dispatched'],
  ['failed', 'wake', 'dispatched'],
  ['lost', 'wake', 'dispatched'],
]

describe('the order lifecycle table', () => {
  test('every allowed transition goes where the table says, and every other pair is refused', () => {
    for (const status of STATUSES) {
      for (const event of EVENTS) {
        const allowed = ALLOWED.find(([from, on]) => from === status && on === event)
        expect([status, event, nextStatus(status, event)]).toEqual([status, event, allowed?.[2]])
        const next = moved(order('O1', { status }), event, 7)
        expect([status, event, next?.status]).toEqual([status, event, allowed?.[2]])
      }
    }
    // The table holds exactly these, and covers every status.
    expect(Object.keys(ORDER_LIFECYCLE).sort()).toEqual([...STATUSES].sort())
    expect(Object.values(ORDER_LIFECYCLE).reduce((count, row) => count + Object.keys(row).length, 0)).toBe(ALLOWED.length)
  })

  test('a move stamps the times, counts wakes and drops an old note', () => {
    expect(moved(order('O1'), 'spawn', 5, { agentId: 'a', model: 'opus', effort: 'high' })).toMatchObject({ status: 'dispatched', agentId: 'a', startedAt: 5, endedAt: null, model: 'opus', effort: 'high' })
    const unsettled = moved(order('O1', { status: 'dispatched', agentId: 'a' }), 'turn-open', 6, { report: 'Paused.' })!
    expect(unsettled).toMatchObject({ status: 'unsettled', endedAt: 6, report: 'Paused.' })
    const waiting = moved(unsettled, 'settle-waiting', 7, { note: 'CI' })!
    expect(waiting).toMatchObject({ status: 'waiting', endedAt: 6, note: 'CI' })
    const woken = moved({ ...waiting, isFolded: true }, 'wake', 8)!
    expect(woken).toMatchObject({ status: 'dispatched', wakes: 1, endedAt: null, isFolded: false })
    expect(woken).not.toHaveProperty('note')
    expect(moved(moved(woken, 'turn-done', 9)!, 'wake', 10)).toMatchObject({ wakes: 2 })
  })

  test('the place is held while dispatched, unsettled or waiting, by knights only; settled and lost orders are finished', () => {
    expect(STATUSES.filter(status => holdsClaim({ role: 'knight', status }))).toEqual(['dispatched', 'unsettled', 'waiting'])
    expect(STATUSES.filter(status => holdsClaim({ role: 'scout', status }))).toEqual([])
    expect(STATUSES.filter(status => isFinished({ status }))).toEqual(['done', 'stopped-early', 'failed', 'lost', 'withdrawn'])
  })
})

describe('turn ends', () => {
  test('answered with every todo done (or none listed) is done; with todos open, unsettled; any other end, failed', () => {
    const done = order('O1', { todos: [{ content: 'a', status: 'completed', activeForm: 'a' }] })
    expect(turnEvent(done, 'answer')).toBe('turn-done')
    expect(turnEvent(order('O1', { todos: [] }), 'answer')).toBe('turn-done')
    expect(turnEvent(order('O1'), 'answer')).toBe('turn-open')
    for (const reason of ['aborted', 'refusal', 'error']) expect(turnEvent(done, reason)).toBe('turn-failed')
  })

  test('the line for the main session names the open todos, three at most, and the tool', () => {
    expect(unsettledLine(order('O3'))).toBe('Council: O3 ended with 2 of 3 todos open (Run tests; Commit). Settle it with mcp__council__settle_order.')
    const many = order('O4', { todos: ['a', 'b', 'c', 'd', 'e'].map(content => ({ content, status: 'pending' as const, activeForm: content })) })
    expect(unsettledLine(many)).toContain('(a; b; c; +2 more)')
    const long = order('O5', { todos: [{ content: 'x'.repeat(80), status: 'pending', activeForm: 'x' }] })
    expect(unsettledLine(long)).toContain(`(${'x'.repeat(39)}…)`)
  })
})

describe('settling and releasing', () => {
  test('settle_order takes an id, one of four outcomes and an optional note', () => {
    expect(readSettlement({ id: ' o3 ', outcome: 'stopped-early', note: 'Tests\nflaky' })).toEqual({ id: 'O3', outcome: 'stopped-early', note: 'Tests' })
    expect(readSettlement({ id: 'O3', outcome: 'done' })).toEqual({ id: 'O3', outcome: 'done' })
    expect(readSettlement({ outcome: 'done' })).toHaveProperty('error')
    expect(readSettlement({ id: 'O3', outcome: 'lost' })).toHaveProperty('error')
  })

  test('only an unsettled or waiting order is settled; others are refused by status', () => {
    const orders = [order('O1', { status: 'unsettled', agentId: 'a' }), order('O2', { status: 'dispatched', agentId: 'b' }), order('O3', { status: 'waiting', agentId: 'c' })]
    const settled = settleOrder(orders, { id: 'O1', outcome: 'stopped-early', note: 'out of time' }, 9)
    expect(settled).toMatchObject({ message: 'O1 settled as stopped early. api/ is free.' })
    expect('orders' in settled && settled.orders[0]).toMatchObject({ status: 'stopped-early', note: 'out of time', endedAt: 9 })
    expect(settleOrder(orders, { id: 'O1', outcome: 'waiting' }, 9)).toMatchObject({ message: expect.stringContaining('O1 settled as waiting') })
    expect(settleOrder(orders, { id: 'O3', outcome: 'done' }, 9)).toMatchObject({ message: 'O3 settled as done. api/ is free.' })
    expect(settleOrder(orders, { id: 'O2', outcome: 'done' }, 9)).toEqual({ error: 'O2 is dispatched; only an unsettled or waiting order can be settled.' })
    expect(settleOrder(orders, { id: 'O9', outcome: 'done' }, 9)).toEqual({ error: 'No order O9.' })
  })

  test('/council release marks an unsettled or waiting order lost; others are refused', () => {
    const orders = [order('O1', { status: 'waiting', agentId: 'a' }), order('O2', { status: 'done', agentId: 'b' })]
    const released = releaseOrder(orders, 'o1', 4)
    expect(released).toMatchObject({ message: 'O1 is released as lost; api/ is free.' })
    expect('orders' in released && released.orders[0]).toMatchObject({ status: 'lost', note: RELEASED_NOTE, endedAt: 4 })
    expect(releaseOrder(orders, 'O2', 4)).toEqual({ error: 'O2 is done; only an unsettled or waiting order can be released.' })
    expect(releaseOrder(orders, '', 4)).toHaveProperty('error')
  })
})

describe('wakes', () => {
  const other = { order: order('O9', { status: 'dispatched' }), place: { folder: '/dev/work/api', repo: null } }
  test('an order on the road, unsettled or waiting, and any scout wake; a settled knight wakes only while its place is free', () => {
    for (const status of ['dispatched', 'unsettled', 'waiting'] as const) expect(wakeVerdict(order('O1', { status }), other)).toEqual({ allow: true })
    for (const status of ['done', 'stopped-early', 'failed', 'lost'] as const) {
      expect(wakeVerdict(order('O1', { status, role: 'scout' }), other)).toEqual({ allow: true })
      expect(wakeVerdict(order('O1', { status }), undefined)).toEqual({ allow: true })
      expect(wakeVerdict(order('O1', { status }), other, 'the same folder')).toEqual({ deny: `O1 is ${status} and O9 now holds the same folder: the wake is refused.` })
    }
  })
})
