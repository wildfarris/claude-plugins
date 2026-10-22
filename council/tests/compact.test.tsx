import { describe, expect, test } from 'claude-code/testing'

import type { AdvisorReport, Council, Seat } from '../types'
import { BUILT_IN_SEATS, MAX_SEATS } from '../hooks/members'
import { newCouncil } from '../hooks/council'
import { compactDetailLines, councilView, wrapLines, type CouncilViewProps } from '../hooks/views/council'

// A stand-in element table that keeps each element's type and props, and a
// measure of the rows a tree takes at a width, as the terminal lays it out:
// a column stacks its children (with margins and gaps), a row takes its
// tallest child (a wrapping row of buttons, as many rows as their labels
// need), a wrapping Text takes a row per `width` columns of each line, a
// truncating one a row per line.
type Node = { type: string; props: Record<string, unknown> }
const element = (type: string) => (props: Record<string, unknown>) => ({ type, props }) as Node
const table = { Box: element('Box'), Text: element('Text'), Button: element('Button'), Raster: element('Raster'), Svg: element('Svg') } as never

const flat = (children: unknown): unknown[] => (Array.isArray(children) ? children.flatMap(flat) : children === null || children === undefined || children === false || children === true ? [] : [children])
const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  const { props } = node as Node
  return `${typeof props.label === 'string' ? props.label : ''}${textOf(props.children)}`
}

function rows(node: unknown, width: number): number {
  if (node === null || node === undefined || typeof node === 'boolean') return 0
  if (typeof node === 'string' || typeof node === 'number') return String(node).split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0)
  if (Array.isArray(node)) return node.reduce((sum: number, child) => sum + rows(child, width), 0)
  const { type, props } = node as Node
  if (type === 'Raster') return Number(props.rows)
  if (type === 'Svg') return 4
  if (type === 'Text' || type === 'Button') {
    const text = textOf(node)
    const isTruncated = typeof props.wrap === 'string' && props.wrap.startsWith('truncate')
    return text.split('\n').reduce((sum, line) => sum + (isTruncated ? 1 : Math.max(1, Math.ceil(line.length / width))), 0)
  }
  const inner = width - Number(props.paddingLeft ?? 0) - 2 * Number(props.paddingX ?? 0) - (props.borderStyle === 'quote' ? 1 : 0) - (props.borderStyle === 'round' ? 2 : 0)
  const children = flat(props.children)
  const border = props.borderStyle === 'round' ? 2 : 0
  const margin = Number(props.marginTop ?? 0)
  if (props.flexDirection === 'row') {
    if (props.flexWrap === 'wrap') {
      const across = children.reduce((sum: number, child) => sum + textOf(child).length + 6, 0)
      return margin + border + Math.max(1, Math.ceil(across / inner))
    }
    return margin + border + Math.max(0, ...children.map(child => rows(child, inner)))
  }
  const gap = Number(props.rowGap ?? 0)
  return margin + border + children.reduce((sum: number, child) => sum + rows(child, inner), 0) + gap * Math.max(0, children.length - 1)
}

const findAll = (node: unknown, matches: (node: Node) => boolean): Node[] => {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, matches))
  const value = node as Node
  return [...(matches(value) ? [value] : []), ...findAll(value.props.children, matches)]
}

const EXTRA: Seat[] = ['auditor', 'archivist', 'herald-two'].map((id, index) => ({
  id,
  title: `The ${id[0]!.toUpperCase()}${id.slice(1)}`,
  concern: 'Extra',
  remit: 'extra things',
  color: ['#2a9d8f', '#d4a017', '#5c7cfa'][index]!,
  accessory: 'none',
  references: [],
}))
const EIGHT = [...BUILT_IN_SEATS, ...EXTRA]

const done = (concern: number): AdvisorReport => ({
  status: 'done',
  concern,
  verdict: 'Sound plan, but watch the token budget.',
  detail: 'The plan is proportionate to the goal and reuses the tools already in the repo; the one thing to watch is that the summary step calls the model on every save, which adds up over a week of use.',
  isExpanded: false,
  followUp: null,
  previousConcern: null,
})

function adjourned(seats: Seat[]): Council {
  const council = newCouncil('Ship the billing flow with the new retry queue and the per-tenant limits this week?', seats)
  return { ...council, phase: 'done', brief: 'The flow charges cards through Stripe. More after.', advisors: Object.fromEntries(seats.map((seat, index) => [seat.id, done((index % 5) + 1)])) }
}

const props = (council: Council, bodyColumns: number, bodyRows: number, isTerminal = true): CouncilViewProps => ({
  council,
  bodyColumns,
  bodyRows,
  isTerminal,
  portrait: seat => (table as unknown as { Raster: (props: Record<string, unknown>) => Node }).Raster({ key: `sprite-${seat.id}`, rows: 9, columns: 16 }),
  onToggleBrief: () => undefined,
  onToggleAdvisor: () => undefined,
  onAsk: () => undefined,
  onReconsider: () => undefined,
  onReconsiderDeep: () => undefined,
  onAskDeep: () => undefined,
  onReport: () => undefined,
  onMembers: () => undefined,
  onLessons: () => undefined,
  hasHotkeys: isTerminal,
})

describe('the compact chamber', () => {
  test(`all ${MAX_SEATS} seats fit a 30-row pane (28 body rows) with the header, the topic and the herald`, () => {
    expect(EIGHT.length).toBe(MAX_SEATS)
    for (const columns of [40, 60, 100, 140]) {
      const tree = councilView(table, props(adjourned(EIGHT), columns, 28))
      const used = rows(tree, columns)
      expect({ columns, used, fits: used <= 28 }).toEqual({ columns, used, fits: true })
      // A row per seat, pressable by its number; no portrait until one is opened.
      const seatRows = findAll(tree, node => node.type === 'Button' && typeof node.props.key === 'string' && (node.props.key as string).startsWith('row-'))
      expect(seatRows.map(node => node.props.hotkey)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
      expect(findAll(tree, node => node.type === 'Raster')).toEqual([])
    }
  })

  test("each row carries the member's mark in its color, the title, the concern as pips and the verdict", () => {
    const tree = councilView(table, props(adjourned(EIGHT), 80, 28))
    const castellan = findAll(tree, node => node.props.key === 'row-castellan')[0]!
    const text = textOf(castellan)
    expect(text).toContain('■ Castellan ●○○○○ Sound plan, but watch the token budget.')
    expect(findAll(castellan, node => node.type === 'Text' && node.props.color === '#4f86c6').length).toBe(1)
  })

  test('detail gets the rows left over, at most two lines a seat', () => {
    expect(compactDetailLines(adjourned(EIGHT), 80, 28)).toBe(1)
    expect(compactDetailLines(adjourned(BUILT_IN_SEATS.slice(0, 3)), 80, 28)).toBe(2)
    expect(compactDetailLines(adjourned(EIGHT), 40, 28)).toBe(0)
  })

  test('an opened row is the full card with its portrait; the others stay rows', () => {
    const council = adjourned(EIGHT)
    const opened = { ...council, advisors: { ...council.advisors, treasurer: { ...council.advisors.treasurer!, isExpanded: true } } }
    const tree = councilView(table, props(opened, 80, 28))
    expect(findAll(tree, node => node.type === 'Raster').map(node => node.props.key)).toEqual(['sprite-treasurer'])
    expect(textOf(tree)).toContain('which adds up over a week of use.')
    expect(findAll(tree, node => typeof node.props.key === 'string' && (node.props.key as string).startsWith('row-') && node.type === 'Button').length).toBe(7)
  })

  test('a wide pane keeps the portrait cards side by side, and a desktop keeps its stacked cards', () => {
    const council = adjourned(BUILT_IN_SEATS)
    expect(findAll(councilView(table, props(council, 140, 28)), node => node.type === 'Raster').length).toBe(5)
    expect(findAll(councilView(table, props(council, 60, 28, false)), node => node.type === 'Raster').length).toBe(5)
  })

  test('wrapLines keeps to its width and its lines, ending a cut in an ellipsis', () => {
    expect(wrapLines('one two three four five six', 9, 2)).toEqual(['one two', 'three…'])
    expect(wrapLines('short', 20, 2)).toEqual(['short'])
    expect(wrapLines('anything', 20, 0)).toEqual([])
    for (const line of wrapLines('a'.repeat(50), 12, 3)) expect(line.length).toBeLessThanOrEqual(12)
  })
})
