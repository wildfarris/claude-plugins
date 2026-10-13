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

const props = (orders: Order[], isTallyShown: boolean): CourtViewProps => ({
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
  isTallyShown,
  onToggleFinished: () => undefined,
  openOrderId: null,
  onToggleOrder: () => undefined,
})

describe('court view tally', () => {
  test('an active order shows its edits and its tally with the number beside it', () => {
    const text = textOf(courtView(table, props([order({})], true)))
    expect(text).toContain('12 edits · ⚔⚔⚔⚔⚔ 57 calls')
  })

  test('the setting turns the tally off and leaves the row as it was', () => {
    const text = textOf(courtView(table, props([order({})], false)))
    expect(text).toContain('12 edits')
    expect(text).not.toContain('⚔')
    expect(text).not.toContain('calls')
  })

  test('a short order shows no tally', () => {
    expect(textOf(courtView(table, props([order({ steps: 9 })], true)))).not.toContain('call')
  })

  test('a failed order that is back shows its tally ending in a dagger', () => {
    const text = textOf(courtView(table, props([order({ status: 'failed', role: 'scout', steps: 31 })], true)))
    expect(text).toContain('○○○† 31 calls')
  })
})
