import { describe, expect, test } from 'claude-code/testing'

import type { Order } from '../types'
import { parseVerdict } from '../hooks/council'
import {
  LOST_NOTE,
  emptyCourt,
  joinedReport,
  knightClash,
  levelOf,
  matchOrder,
  medianLevel,
  newOrders,
  orderAsk,
  orderLevels,
  parseLevels,
  placesOverlap,
  setOrderLevel,
  withLostAgents,
} from '../hooks/court'
import { parseModelEfforts, readSettings } from '../hooks/settings'

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
  ...patch,
})

describe('levels', () => {
  test('each member rates each dispatch on its own LEVEL line, read leniently', () => {
    expect([...parseLevels('CONCERN: 2\nVERDICT: Fine.\nDETAIL: x\nLEVEL 1: 3\nLEVEL 2: 1', 2)]).toEqual([
      [1, 3],
      [2, 1],
    ])
    expect([...parseLevels('**LEVEL 2**: 3\nLevel #1 = 2 (ordinary)\n- level dispatch 3 - 1', 3)]).toEqual([
      [2, 3],
      [1, 2],
      [3, 1],
    ])
    // A bare LEVEL counts only when there is one dispatch.
    expect([...parseLevels('LEVEL: 3', 1)]).toEqual([[1, 3]])
    expect([...parseLevels('LEVEL: 3', 2)]).toEqual([])
    // Out of range, unknown dispatches and repeats are ignored.
    expect([...parseLevels('LEVEL 1: 4\nLEVEL 1: 0\nLEVEL 5: 2\nLEVEL 2: 2\nLEVEL 2: 3', 2)]).toEqual([[2, 2]])
  })

  test('the order level is the median of the ratings, a half rounded up', () => {
    expect(medianLevel([])).toBeUndefined()
    expect(medianLevel([1])).toBe(1)
    expect(medianLevel([1, 2])).toBe(2)
    expect(medianLevel([1, 1, 3])).toBe(1)
    expect(medianLevel([3, 1, 2, 3])).toBe(3)
    expect(medianLevel([2, 2, 3, 1, 1])).toBe(2)
  })

  test('with no valid rating a knight is level 2 and a scout level 1', () => {
    expect(orderLevels(['LEVEL 1: 3', 'LEVEL 1: 3\nLEVEL 2: 3', 'nothing'], ['knight', 'scout', 'knight'])).toEqual([3, 3, 2])
    expect(orderLevels([], ['knight', 'scout'])).toEqual([2, 1])
    expect(levelOf({ role: 'scout' })).toBe(1)
    expect(levelOf({ role: 'knight', level: 3 })).toBe(3)
  })

  test('the members are asked for LEVEL lines, and no CHECK; the verdict detail stops at them', () => {
    expect(orderAsk(2)).toContain('LEVEL <dispatch number>: <1 to 3>')
    expect(orderAsk(2)).not.toContain('CHECK')
    expect(orderAsk(1, true)).not.toContain('CHECK')
    expect(parseVerdict('CONCERN: 3\nVERDICT: Look first.\nDETAIL: It may break.\nLEVEL 1: 2')).toEqual({ concern: 3, verdict: 'Look first.', detail: 'It may break.' })
  })

  test('the proposal carries no level: the orders take the council\'s', () => {
    const proposal = { plan: 'p', dispatches: [{ folder: 'api', role: 'knight' as const, task: 't', todos: ['a'] }, { folder: 'web', role: 'scout' as const, task: 't', todos: ['a'] }] }
    expect(newOrders(emptyCourt(), proposal, '/dev/work', [], 1, [3, 1]).map(entry => entry.level)).toEqual([3, 1])
    expect(newOrders(emptyCourt(), proposal, '/dev/work', [])[0]).not.toHaveProperty('level')
  })

  test('the person changes an approved order\'s level, and only that', () => {
    const orders = [order('O1'), order('O2', { status: 'dispatched', agentId: 'a' })]
    const changed = setOrderLevel(orders, 'o1', '3')
    expect(changed).toMatchObject({ message: expect.stringContaining('O1 (knight, api/) is now level 3 (was 2)') })
    expect('orders' in changed && changed.orders[0]!.level).toBe(3)
    expect(setOrderLevel(orders, 'O2', '1')).toMatchObject({ error: expect.stringContaining('dispatched') })
    expect(setOrderLevel(orders, 'O9', '1')).toMatchObject({ error: 'No order O9.' })
    expect(setOrderLevel(orders, 'O1', '4')).toHaveProperty('error')
  })

  test('level settings are three model:effort entries; anything malformed falls back to the default', () => {
    expect(parseModelEfforts('haiku:low, claude-sonnet-4-5:high ,opus[1m]:max', 3)).toEqual([
      { model: 'haiku', effort: 'low' },
      { model: 'claude-sonnet-4-5', effort: 'high' },
      { model: 'opus[1m]', effort: 'max' },
    ])
    expect(parseModelEfforts('haiku:low,sonnet:medium', 3)).toBeUndefined()
    expect(parseModelEfforts('haiku:fast,sonnet:medium,opus:high', 3)).toBeUndefined()
    expect(parseModelEfforts(':low,sonnet:medium,opus:high', 3)).toBeUndefined()
    expect(readSettings({ knightLevels: 'bad' }).knightLevels[2]).toEqual({ model: 'opus', effort: 'high' })
    expect(readSettings({ scoutLevels: 'haiku:low,haiku:low,haiku:low' }).scoutLevels[2]).toEqual({ model: 'haiku', effort: 'low' })
    // The advisor agent's settings are gone: a saved value is ignored.
    const old = readSettings({ advisorAgentLevels: 'sonnet:low,opus:xhigh', councilSummons: false })
    expect(old).not.toHaveProperty('advisorAgentLevels')
    expect(old).not.toHaveProperty('isSummonsOn')
  })
})

describe('matching a dispatch to its order', () => {
  test('the description names the order first; the prompt only when the description names none', () => {
    const orders = [order('O1'), order('O2')]
    expect(matchOrder(orders, 'council:knight', 'O2 api', 'as in O1')?.id).toBe('O2')
    expect(matchOrder(orders, 'council:knight', 'api work', 'carry O1')?.id).toBe('O1')
  })
})

describe('knight overlap', () => {
  const place = (folder: string) => ({ folder })
  test('the same folder, or one inside the other overlap; sibling folders of one repository do not', () => {
    expect(placesOverlap(place('/w/api'), place('/w/api'))).toBe(true)
    expect(placesOverlap(place('/w/api'), place('/w/api/src'))).toBe(true)
    expect(placesOverlap(place('/w/api/src'), place('/w/api'))).toBe(true)
    expect(placesOverlap(place('/w/repo/a'), place('/w/repo/b'))).toBe(false)
    expect(placesOverlap(place('/w/one'), place('/w/two'))).toBe(false)
    expect(placesOverlap(place('/w/api'), place('/w/apis'))).toBe(false)
    expect(placesOverlap(place('/w/a'), place('/w/b'))).toBe(false)
    expect(placesOverlap(place('C:\\w\\Api'), place('c:/w/api/src'))).toBe(true)
    expect(placesOverlap(place('C:\\w\\Api'), place('c:/w/web'))).toBe(false)
  })

  test('only a knight holding its place clashes (dispatched, unsettled or waiting); scouts, approved and settled orders do not', () => {
    const at = (entry: Order) => ({ order: entry, place: place(entry.folder) })
    const others = [at(order('O1', { status: 'dispatched' })), at(order('O2', { role: 'scout', status: 'dispatched', folder: '/dev/work/api' })), at(order('O3'))]
    expect(knightClash(place('/dev/work/api'), others)?.order.id).toBe('O1')
    expect(knightClash(place('/dev/work/api'), others, 'O1')).toBeUndefined()
    expect(knightClash(place('/dev/work/web'), others)).toBeUndefined()
    for (const status of ['unsettled', 'waiting'] as const) expect(knightClash(place('/dev/work/api'), [at(order('O4', { status }))])?.order.id).toBe('O4')
    for (const status of ['done', 'stopped-early', 'failed', 'lost', 'withdrawn'] as const) expect(knightClash(place('/dev/work/api'), [at(order('O4', { status }))])).toBeUndefined()
  })

})

describe('orders whose agent is gone', () => {
  test('a dispatched, unsettled or waiting order whose agent is no longer listed is lost; a listed one (in any status) and a settled one stay', () => {
    const orders = [
      order('O1', { status: 'dispatched', agentId: 'gone', report: 'Half done.' }),
      order('O2', { status: 'unsettled', agentId: 'gone-2' }),
      order('O3', { status: 'waiting', agentId: 'gone-3' }),
      order('O4', { status: 'dispatched', agentId: 'waiting' }),
      order('O5'),
      order('O6', { status: 'done', agentId: 'old' }),
    ]
    const lost = withLostAgents(orders, new Set(['waiting']), 9)
    expect(lost.slice(0, 3).map(entry => entry.status)).toEqual(['lost', 'lost', 'lost'])
    expect(lost[0]).toMatchObject({ report: 'Half done.', note: LOST_NOTE, endedAt: 9 })
    expect(lost.slice(3)).toEqual(orders.slice(3))
    const kept = orders.slice(3)
    expect(withLostAgents(kept, new Set(['waiting']), 9)).toBe(kept)
  })
})

describe('waking', () => {
  test('the next report after a wake follows the earlier one', () => {
    expect(joinedReport('Started the tests.', 'All 40 pass.')).toBe('Started the tests.\n\n[woke and went on]\nAll 40 pass.')
    expect(joinedReport('', 'x')).toBe('x')
  })
})

