import { describe, expect, test } from 'claude-code/testing'

import type { Order } from '../types'
import { courtView, type CourtViewProps } from '../hooks/views/court'

// A stand-in element table: each element becomes a plain node, so the drawn
// text can be read back.
type Node = { type: string; children: unknown[] }
const element = (type: string) => (props: { children?: unknown; label?: string }) => ({ type, children: [props.label ?? '', props.children] }) as Node
const table = { Box: element('Box'), Text: element('Text'), Button: element('Button') } as never

const textOf = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  const value = node as { type?: unknown; props?: { children?: unknown; label?: string }; children?: unknown }
  if (typeof value.type === 'function') return textOf((value.type as (props: unknown) => unknown)(value.props ?? {}))
  return textOf(value.props ? [value.props.label, value.props.children] : value.children)
}

const order = (patch: Partial<Order>): Order => ({
  id: 'O7',
  role: 'knight',
  folder: 'C:/x/repo',
  relFolder: 'repo',
  task: 'task',
  todos: [{ content: 'a', status: 'completed', activeForm: 'Doing a' }, { content: 'b', status: 'pending', activeForm: 'Doing b' }],
  conditions: [],
  status: 'dispatched',
  agentId: 'a1',
  steps: 57,
  edits: 12,
  report: 'ok',
  startedAt: 1,
  endedAt: null,
  ...patch,
})

const props = (orders: Order[]): CourtViewProps => ({
  court: { orders, isInSession: false, heldPrompt: null, rulings: [] } as never,
  council: null,
  bodyColumns: 80,
  road: () => null,
  onChamber: () => undefined,
  onToggleSession: () => undefined,
  onClearFinished: () => undefined,
  openVerdictId: null,
  onToggleVerdict: () => undefined,
  portrait: () => null,
  isFinishedShown: false,
  onToggleFinished: () => undefined,
  openOrderId: null,
  onToggleOrder: () => undefined,
})

describe('court rows', () => {
  test('an active order shows its edits and calls as numbers, with no glyphs', () => {
    const text = textOf(courtView(table, props([order({})])))
    expect(text).toContain('12 edits · 57 calls')
    for (const glyph of ['⚔', '†']) expect(text).not.toContain(glyph)
  })

  test('an order with no calls yet shows none', () => {
    expect(textOf(courtView(table, props([order({ steps: 0 })])))).not.toContain('call')
  })

  test('a finished order shows its calls, still without glyphs', () => {
    const text = textOf(courtView(table, props([order({ status: 'failed', role: 'scout', steps: 31 })])))
    expect(text).toContain('31 calls')
    for (const glyph of ['⚔', '†']) expect(text).not.toContain(glyph)
  })
})

describe('withdrawn orders', () => {
  const withdrawn = (patch: Partial<Order> = {}) => order({ status: 'withdrawn', agentId: null, steps: 0, edits: 0, report: '', startedAt: null, withdrawnReason: 'plan changed', ...patch })

  test('a withdrawn order shows its reason and no road, in the finished section', () => {
    const text = textOf(courtView(table, { ...props([withdrawn()]), road: () => 'THE-ROAD' }))
    expect(text).toContain('withdrawn · plan changed')
    expect(text).toContain('Back home · 1')
    expect(text).not.toContain('On the road')
    expect(text).not.toContain('THE-ROAD')
    expect(text).not.toContain('waiting to be dispatched')
  })

  test('a folded withdrawn order is archived with the finished ones', () => {
    const text = textOf(courtView(table, props([withdrawn({ isFolded: true }), order({ id: 'O8', status: 'done', isFolded: true })])))
    expect(text).toContain('Archived · 2')
    expect(text).not.toContain('Back home')
  })

  test('an expired order says so', () => {
    expect(textOf(courtView(table, props([withdrawn({ withdrawnReason: 'expired' })])))).toContain('withdrawn · expired')
  })

  test('clear finished is offered when only withdrawn orders are left', () => {
    expect(textOf(courtView(table, props([withdrawn()])))).toContain('clear finished')
  })
})
