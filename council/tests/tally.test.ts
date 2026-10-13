import { describe, expect, test } from 'claude-code/testing'

import type { OrderTodo } from '../types'
import { callsLabel, carryCalls, creditCall, siteLevel, sitesOf } from '../hooks/tally'

const todo = (content: string, status: OrderTodo['status'], calls?: number): OrderTodo => ({ content, status, activeForm: content, ...(calls === undefined ? {} : { calls }) })

describe('work levels', () => {
  test('level 0 to 5, one per ten calls rounded down, capped at 5', () => {
    expect([0, 9, 10, 17, 19, 20, 29, 30, 40, 49, 50, 51, 500].map(siteLevel)).toEqual([0, 0, 1, 1, 1, 2, 2, 3, 4, 4, 5, 5, 5])
  })

  test('missing or odd call counts are level 0', () => {
    expect(siteLevel(undefined)).toBe(0)
    expect(siteLevel(-4)).toBe(0)
    expect(siteLevel(Number.NaN)).toBe(0)
  })
})

describe('sites of an order', () => {
  const order = (todos: OrderTodo[], status: 'dispatched' | 'done' | 'failed' | 'approved' = 'dispatched') => ({ todos, status })

  test('3 done, working on the 4th, 2 to go: 3 work sites, the agent at the 4th, 2 tents ahead', () => {
    const { sites, stands } = sitesOf(order([todo('a', 'completed', 4), todo('b', 'completed', 12), todo('c', 'completed', 61), todo('d', 'in_progress', 30), todo('e', 'pending'), todo('f', 'pending')]))
    expect(sites).toEqual([{ kind: 'work', level: 0 }, { kind: 'work', level: 1 }, { kind: 'work', level: 5 }, { kind: 'ahead' }, { kind: 'ahead' }, { kind: 'ahead' }])
    expect(stands).toBe(3)
  })

  test('nothing done: the agent stands at the first, every other stop is a tent', () => {
    const { sites, stands } = sitesOf(order([todo('a', 'in_progress', 8), todo('b', 'pending'), todo('c', 'pending')]))
    expect(stands).toBe(0)
    expect(sites.map(site => site.kind)).toEqual(['ahead', 'ahead', 'ahead'])
  })

  test('one done: one work site behind the agent, the rest tents', () => {
    const { sites, stands } = sitesOf(order([todo('a', 'completed', 23), todo('b', 'in_progress'), todo('c', 'pending')]))
    expect(stands).toBe(1)
    expect(sites).toEqual([{ kind: 'work', level: 2 }, { kind: 'ahead' }, { kind: 'ahead' }])
  })

  test('a finished order has every stop worked, the agent past the last', () => {
    const { sites, stands } = sitesOf(order([todo('a', 'completed', 10), todo('b', 'pending', 55)], 'done'))
    expect(sites).toEqual([{ kind: 'work', level: 1 }, { kind: 'work', level: 5 }])
    expect(stands).toBe(2)
  })

  test('a failed order stays where it fell, its unreached stops still tents', () => {
    const { sites, stands } = sitesOf(order([todo('a', 'completed', 10), todo('b', 'in_progress', 99), todo('c', 'pending')], 'failed'))
    expect(stands).toBe(1)
    expect(sites.map(site => site.kind)).toEqual(['work', 'ahead', 'ahead'])
  })

  test('an order with no todos has no stops', () => {
    expect(sitesOf(order([]))).toEqual({ sites: [], stands: 0 })
  })
})

describe('crediting calls to tasks', () => {
  test('a call goes to the task in progress, and to none when none is', () => {
    const list = [todo('a', 'completed', 3), todo('b', 'in_progress'), todo('c', 'pending')]
    expect(creditCall(list).map(item => item.calls)).toEqual([3, 1, undefined])
    expect(creditCall(creditCall(list))[1]!.calls).toBe(2)
    const idle = [todo('a', 'completed', 3), todo('b', 'pending')]
    expect(creditCall(idle)).toBe(idle)
  })

  test('the agent rewriting its list keeps the calls already credited', () => {
    const before = [todo('a', 'completed', 14), todo('b', 'in_progress', 6), todo('c', 'pending')]
    const after = carryCalls(before, [todo('a', 'completed'), todo('b', 'completed'), todo('c', 'in_progress')])
    expect(after.map(item => item.calls)).toEqual([14, 6, undefined])
  })

  test('calls follow the task text when the list is reordered, and the position when reworded', () => {
    const before = [todo('a', 'completed', 14), todo('b', 'in_progress', 6)]
    expect(carryCalls(before, [todo('b', 'in_progress'), todo('a', 'completed')]).map(item => item.calls)).toEqual([6, 14])
    expect(carryCalls(before, [todo('A, reworded', 'completed'), todo('b', 'in_progress')]).map(item => item.calls)).toEqual([14, 6])
  })

  test('a new todo starts with none', () => {
    expect(carryCalls([todo('a', 'in_progress', 5)], [todo('a', 'in_progress'), todo('z', 'pending')]).map(item => item.calls)).toEqual([5, undefined])
  })
})

describe('calls label', () => {
  test('the number of calls, singular for one, nothing before the first', () => {
    expect(callsLabel(0)).toBe('')
    expect(callsLabel(1)).toBe('1 call')
    expect(callsLabel(57)).toBe('57 calls')
  })
})
