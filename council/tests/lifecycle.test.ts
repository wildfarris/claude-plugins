// The order lifecycle: every allowed transition, every refused one, and the
// pure steps around it (turn ends, settling, releasing, wakes).

import { describe, expect, test } from 'claude-code/testing'

import type { AdvisorRun, CourtSummons, Order } from '../types'
import { summonsDue, withUnstartedAdvisors } from '../hooks/advisors'
import {
  ORDER_EXPIRY_MS,
  ORDER_LIFECYCLE,
  RELEASED_NOTE,
  heldRefusal,
  heldText,
  holdsClaim,
  isFinished,
  matchOrder,
  moved,
  summonsRuledLine,
  withExpired,
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

const STATUSES: Order['status'][] = ['held', 'approved', 'dispatched', 'unsettled', 'waiting', 'done', 'stopped-early', 'failed', 'lost', 'withdrawn', 'recalled']
const EVENTS: OrderEvent[] = ['spawn', 'withdraw', 'expire', 'turn-done', 'turn-open', 'turn-failed', 'gone', 'settle-done', 'settle-stopped-early', 'settle-failed', 'settle-waiting', 'wake', 'release', 'recall', 'approve', 'refuse']

// The whole table, written out: every transition the lifecycle allows. Any
// (status, event) pair not here must be refused.
const ALLOWED: ReadonlyArray<[Order['status'], OrderEvent, Order['status']]> = [
  ['held', 'approve', 'approved'],
  ['held', 'refuse', 'withdrawn'],
  ['held', 'withdraw', 'withdrawn'],
  ['held', 'expire', 'withdrawn'],
  ['approved', 'spawn', 'dispatched'],
  ['approved', 'withdraw', 'withdrawn'],
  ['approved', 'expire', 'withdrawn'],
  ['dispatched', 'turn-done', 'done'],
  ['dispatched', 'turn-open', 'unsettled'],
  ['dispatched', 'turn-failed', 'failed'],
  ['dispatched', 'gone', 'lost'],
  ['dispatched', 'recall', 'recalled'],
  ['unsettled', 'settle-done', 'done'],
  ['unsettled', 'settle-stopped-early', 'stopped-early'],
  ['unsettled', 'settle-failed', 'failed'],
  ['unsettled', 'settle-waiting', 'waiting'],
  ['unsettled', 'wake', 'dispatched'],
  ['unsettled', 'gone', 'lost'],
  ['unsettled', 'release', 'lost'],
  ['unsettled', 'recall', 'recalled'],
  ['waiting', 'wake', 'dispatched'],
  ['waiting', 'settle-done', 'done'],
  ['waiting', 'settle-stopped-early', 'stopped-early'],
  ['waiting', 'settle-failed', 'failed'],
  ['waiting', 'gone', 'lost'],
  ['waiting', 'release', 'lost'],
  ['waiting', 'recall', 'recalled'],
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

  test('a recall ends the order: a stamp, no way out, and its place freed', () => {
    const recall = { reason: 'wrong repo', at: 3, by: 'claude' as const, steps: 0 }
    const recalled = moved(order('O1', { status: 'dispatched', agentId: 'a', recall }), 'recall', 9, { report: 'Stopped.' })!
    expect(recalled).toMatchObject({ status: 'recalled', endedAt: 9, report: 'Stopped.', recall })
    expect(holdsClaim(recalled)).toBe(false)
    expect(EVENTS.map(event => nextStatus('recalled', event))).toEqual(EVENTS.map(() => undefined))
    expect(wakeVerdict(recalled, undefined)).toEqual({ deny: 'O1 was recalled: the wake is refused.' })
    expect(wakeVerdict({ ...recalled, role: 'scout' }, undefined)).toHaveProperty('deny')
  })

  test('the place is held while dispatched, unsettled or waiting, by knights only; settled and lost orders are finished', () => {
    expect(STATUSES.filter(status => holdsClaim({ role: 'knight', status }))).toEqual(['dispatched', 'unsettled', 'waiting'])
    expect(STATUSES.filter(status => holdsClaim({ role: 'scout', status }))).toEqual([])
    expect(STATUSES.filter(status => isFinished({ status }))).toEqual(['done', 'stopped-early', 'failed', 'lost', 'withdrawn', 'recalled'])
  })
})

describe('held orders', () => {
  test('a held order holds no place, is not finished, and is not open to a dispatch', () => {
    expect(holdsClaim({ role: 'knight', status: 'held' })).toBe(false)
    expect(isFinished({ status: 'held' })).toBe(false)
    expect(matchOrder([order('O4', { status: 'held' })], 'council:knight', 'O4 api', '')).toBeUndefined()
  })

  test('released by the second round it carries its conditions, level and a fresh approval time; refused, it is withdrawn', () => {
    const held = order('O4', { status: 'held', approvedAt: 1, level: 1 })
    expect(moved(held, 'approve', 50, { conditions: ['The Castellan: keep keys out.'], level: 3, approvedAt: 50 })).toMatchObject({ status: 'approved', conditions: ['The Castellan: keep keys out.'], level: 3, approvedAt: 50, endedAt: null })
    expect(moved(held, 'refuse', 50, { withdrawnReason: 'refused' })).toMatchObject({ status: 'withdrawn', withdrawnReason: 'refused', endedAt: 50 })
  })

  test('a dispatch naming a held order is refused with why; one naming an open order is not', () => {
    const orders = [order('O4', { status: 'held' }), order('O5', { status: 'held', role: 'scout' }), order('O6', { status: 'approved', role: 'scout' })]
    expect(heldRefusal(orders, 'council:knight', 'O4 api', '')).toBe("O4 is held while the council's advisor checks a fact. You will be told when the council rules; dispatch then.")
    // No id named: the role's held orders, unless one of that role is open.
    expect(heldRefusal(orders, 'council:knight', 'api work', '')).toContain('O4 is held')
    expect(heldRefusal(orders, 'council:scout', 'look around', '')).toBeUndefined()
    expect(heldRefusal(orders, 'council:scout', 'O6 look', '')).toBeUndefined()
    expect(heldRefusal(orders, 'general-purpose', 'O4', '')).toBeUndefined()
  })

  test('a held order expires like an approved one', () => {
    const [expired] = withExpired([order('O4', { status: 'held', approvedAt: 0 })], ORDER_EXPIRY_MS + 1)
    expect(expired).toMatchObject({ status: 'withdrawn', withdrawnReason: 'expired' })
  })

  test('propose_orders names the held orders and the questions; the line for the main session says how the council ruled', () => {
    const held = [order('O4', { status: 'held' }), order('O5', { status: 'held', role: 'scout', relFolder: 'web' })]
    const questions = [{ question: 'Is a key committed?', askedBy: ['The Castellan'] }]
    expect(heldText(held, 'A1', questions, 8 * 60 * 1000)).toBe(
      [
        'The council holds O4, O5 while its advisor (A1, read-only) checks:',
        '1. Is a key committed? (asked by The Castellan)',
        "It rules again when the advisor reports (within 8 minutes), and you will be told. Held orders can't be dispatched yet: carry on with other work, or end your turn.",
      ].join('\n'),
    )
    const released = held.map(entry => ({ ...entry, status: 'approved' as const }))
    const summons = { advisorId: 'A1', questions, status: 'done' as const, findings: 'No key in api/.' }
    expect(summonsRuledLine({ plan: 'p', isApproved: true, gravest: 3, reason: '', conditions: ['The Seneschal: split it.'], summons }, released, ['O4 must wait: O2 holds the same folder.'])).toBe(
      [
        'Council: the advisor (A1) reported; O4, O5 approved (gravest concern 3/5).',
        'Conditions: The Seneschal: split it.',
        'Findings: No key in api/.',
        'Dispatch them as before, the order id in each description: O4 (council:knight, api/), O5 (council:scout, web/).',
        'O4 must wait: O2 holds the same folder.',
      ].join('\n'),
    )
    expect(summonsRuledLine({ plan: 'p', isApproved: false, gravest: 5, reason: 'The Castellan: a key is committed.', conditions: [], summons }, held)).toBe(
      'Council: the advisor (A1) reported; it refused O4, O5 (gravest concern 5/5). The Castellan: a key is committed. Revise the plan and propose again, or ask the person.',
    )
    expect(summonsRuledLine({ plan: 'p', isApproved: true, gravest: 4, reason: '', conditions: [], summons: { ...summons, status: 'timed-out', findings: '' } }, released)).toContain(
      'Council: the advisor (A1) did not report in time, so the council ruled on its first round; O4, O5 approved',
    )
  })
})

describe('summonses', () => {
  const summons = (runId: string, patch: Partial<CourtSummons> = {}) => ({ runId, phase: 'checking', deadline: 100, ...patch }) as CourtSummons
  const run = (id: string, status: AdvisorRun['status'], patch: Partial<AdvisorRun> = {}) =>
    ({ id, origin: 'council', relFolders: ['api'], questions: [], isDeep: false, model: 'opus', effort: 'low', status, agentId: 'agent-1', report: '', startedAt: 0, endedAt: null, ...patch }) as AdvisorRun

  test('a summons is due once its advisor is back or failed, its deadline passed, or its round was dropped by a reload', () => {
    const summonses = [summons('A1'), summons('A2'), summons('A3'), summons('A4', { phase: 'ruling' }), summons('A5')]
    const runs = [run('A1', 'running'), run('A2', 'done'), run('A3', 'failed'), run('A4', 'done'), run('A5', 'running')]
    expect(summonsDue(summonses, runs, 50, new Set())).toEqual(['A2', 'A3', 'A4'])
    expect(summonsDue(summonses, runs, 100, new Set())).toEqual(['A1', 'A2', 'A3', 'A4', 'A5'])
    // One this module is already ruling on is not started twice.
    expect(summonsDue(summonses, runs, 50, new Set(['A2', 'A4']))).toEqual(['A3'])
    // A run cleared away counts as back.
    expect(summonsDue([summons('A9')], [], 50, new Set())).toEqual(['A9'])
  })

  test('a run whose start was lost (no agent, no spawn under way, over a minute old) fails', () => {
    const runs = [run('A1', 'running', { agentId: null }), run('A2', 'running', { agentId: null }), run('A3', 'running', { agentId: null, startedAt: 90_000 }), run('A4', 'running')]
    const next = withUnstartedAdvisors(runs, new Set(['A2']), 100_000)
    expect(next.map(entry => entry.status)).toEqual(['failed', 'running', 'running', 'running'])
    expect(next[0]!.report).toContain('its start was lost')
    // Nothing to fail: the same array.
    const unchanged = runs.slice(1)
    expect(withUnstartedAdvisors(unchanged, new Set(['A2']), 100_000)).toBe(unchanged)
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
  const other = { order: order('O9', { status: 'dispatched' }), place: { folder: '/dev/work/api' } }
  test('an order on the road, unsettled or waiting, and any scout wake; a settled knight wakes only while its place is free', () => {
    for (const status of ['dispatched', 'unsettled', 'waiting'] as const) expect(wakeVerdict(order('O1', { status }), other)).toEqual({ allow: true })
    for (const status of ['done', 'stopped-early', 'failed', 'lost'] as const) {
      expect(wakeVerdict(order('O1', { status, role: 'scout' }), other)).toEqual({ allow: true })
      expect(wakeVerdict(order('O1', { status }), undefined)).toEqual({ allow: true })
      expect(wakeVerdict(order('O1', { status }), other, 'the same folder')).toEqual({ deny: `O1 is ${status} and O9 now holds the same folder: the wake is refused.` })
    }
  })
})
