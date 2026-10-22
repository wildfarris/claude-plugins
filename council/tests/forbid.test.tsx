import { describe, expect, test } from 'claude-code/testing'

import type { Order } from '../types'
import { dispatchPrompt, emptyCourt, forbidGlob, newOrders, proposalBrief, readProposal, rulingText, type Proposal } from '../hooks/court'
import { courtView, type CourtViewProps } from '../hooks/views/court'

const ROOT = '/dev/work'
const TESTS = { glob: '**/*.spec.ts', reason: 'the tests are the spec' }
const CSS = { glob: '*.css', ops: ['create'], reason: 'no new CSS; use the theme tokens' }
const dispatch = (forbid?: unknown) => ({ folder: 'web', role: 'knight', task: 'Fix the form.', todos: ['fix it'], ...(forbid === undefined ? {} : { forbid }) })
const read = (forbid?: unknown) => readProposal({ plan: 'p', dispatches: [dispatch(forbid)] }, ROOT)

describe("a dispatch's forbid", () => {
  test('is optional; when given, ops default to all three and the reason is kept', () => {
    expect(read()).toEqual({ plan: 'p', dispatches: [{ folder: 'web', role: 'knight', task: 'Fix the form.', todos: ['fix it'] }] })
    expect(read([]) as Proposal).toEqual(read() as Proposal)
    const proposal = read([TESTS, CSS]) as Proposal
    expect(proposal.dispatches[0]!.forbid).toEqual([
      { glob: '**/*.spec.ts', ops: ['create', 'edit', 'delete'], reason: 'the tests are the spec' },
      { glob: '*.css', ops: ['create'], reason: 'no new CSS; use the theme tokens' },
    ])
  })

  test('takes plain-language rules beside the globs, as { rule } or a bare sentence', () => {
    const proposal = read([TESTS, { rule: '  Push   nothing. ' }, "Don't run Python."]) as Proposal
    expect(proposal.dispatches[0]!.forbid).toEqual([{ glob: '**/*.spec.ts', ops: ['create', 'edit', 'delete'], reason: 'the tests are the spec' }])
    expect(proposal.dispatches[0]!.policy).toEqual(['Push nothing.', "Don't run Python."])
    expect(read([{ rule: 'Push nothing.' }]) as Proposal).toEqual({ plan: 'p', dispatches: [{ folder: 'web', role: 'knight', task: 'Fix the form.', todos: ['fix it'], policy: ['Push nothing.'] }] })
    expect((read([{ rule: '  ' }]) as { error: string }).error).toContain('forbid 1: a plain-language rule is a sentence')
    expect((read([{}]) as { error: string }).error).toContain('forbid 1: give a glob')
    expect(proposalBrief(proposal)).toContain("Rules (plain language): Push nothing. Don't run Python.")
    const [order] = newOrders(emptyCourt(), proposal, ROOT, [])
    expect(order!.policy).toEqual(['Push nothing.', "Don't run Python."])
    expect(newOrders(emptyCourt(), read([TESTS]) as Proposal, ROOT, [])[0]).not.toHaveProperty('policy')
    expect(rulingText({ plan: 'p', isApproved: true, gravest: 1, reason: '', conditions: [] }, [order!])).toContain("rules: Push nothing. Don't run Python.")
    const prompt = dispatchPrompt(order!, null, 'Go.')
    expect(prompt).toContain("Rules for this order (plain language; the sidekick mod's policy judge holds your shell commands to them)")
    expect(prompt).toContain('- Push nothing.')
  })

  test('refuses globs that leave the folder, unknown ops, a missing reason, or too many rules', () => {
    expect((read('**/*.ts') as { error: string }).error).toContain('forbid must be a list')
    expect((read([{ glob: '../api/*.ts', reason: 'r' }]) as { error: string }).error).toContain('Dispatch 1, forbid 1: give a glob relative')
    expect((read([{ glob: 'C:\\x\\*.ts', reason: 'r' }]) as { error: string }).error).toContain('forbid 1')
    expect((read([TESTS, { glob: '*.css', ops: ['paint'], reason: 'r' }]) as { error: string }).error).toContain('forbid 2: ops is a list')
    expect((read([{ glob: '*.css' }]) as { error: string }).error).toContain('give the reason')
    expect((read(Array.from({ length: 9 }, () => TESTS)) as { error: string }).error).toContain('at most 8 forbid rules')
    expect(forbidGlob('./src\\gen/')).toBe('src/gen/**')
  })

  test('is shown to the advisors, stored on the order, named to Claude and handed to the agent', () => {
    const proposal = read([TESTS, CSS]) as Proposal
    expect(proposalBrief(proposal)).toContain('Forbidden paths (under web/): **/*.spec.ts (create, edit, delete): the tests are the spec; *.css (create): no new CSS; use the theme tokens')
    const [order] = newOrders(emptyCourt(), proposal, ROOT, [])
    expect(order!.forbid).toEqual(proposal.dispatches[0]!.forbid)
    expect(newOrders(emptyCourt(), read() as Proposal, ROOT, [])[0]).not.toHaveProperty('forbid')
    expect(rulingText({ plan: 'p', isApproved: true, gravest: 1, reason: '', conditions: [] }, [order!])).toContain('task: Fix the form., forbids: **/*.spec.ts, *.css')
    const prompt = dispatchPrompt(order!, null, 'Go.')
    expect(prompt).toContain('Forbidden paths (globs under /dev/work/web/')
    expect(prompt).toContain('If one must change, stop and report why instead of working around it')
    expect(prompt).toContain('- *.css (create): no new CSS; use the theme tokens')
    expect(dispatchPrompt(newOrders(emptyCourt(), read() as Proposal, ROOT, [])[0]!, null, 'Go.')).not.toContain('Forbidden paths')
  })
})

// The court view, drawn into plain nodes so its text can be read back.
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
const viewProps = (orders: Order[]): CourtViewProps => ({
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

describe('the court', () => {
  test("an order on the road shows what it forbids", () => {
    const [order] = newOrders(emptyCourt(), read([TESTS, CSS]) as Proposal, ROOT, [])
    expect(textOf(courtView(table, viewProps([{ ...order!, status: 'dispatched', agentId: 'a1' }])))).toContain('forbids **/*.spec.ts · *.css (create)')
    const [plain] = newOrders(emptyCourt(), read() as Proposal, ROOT, [])
    expect(textOf(courtView(table, viewProps([plain!])))).not.toContain('forbids')
  })
})
