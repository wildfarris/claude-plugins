// The guard's contract: every fixture in guard-fixtures.ts, through the
// guard's decision as the hooks make it.

import { describe, expect, test } from 'claude-code/testing'

import { decideShell, outcomeFor } from '../hooks/policy-guard'
import { checkFileEdit, type ScopeContext } from '../hooks/scope-guard'
import { FIXTURES, FOLDER, HOME, ROOT, type Expect, type GuardFixture } from './guard-fixtures'

const contextOf = (fixture: GuardFixture): ScopeContext => ({
  root: ROOT,
  cwd: fixture.cwd === '..' ? ROOT : fixture.cwd ? `${FOLDER}\\${fixture.cwd}` : FOLDER,
  folders: fixture.agent === 'order' ? [FOLDER] : [],
  home: HOME,
})

// Stage 1: the inline-code ban and the scope guard, before any model.
function stage1(fixture: GuardFixture): { expect: Expect; message: string; outcome: string } {
  const context = contextOf(fixture)
  if (fixture.tool === 'Write') {
    const verdict = checkFileEdit(fixture.text, context)
    return { expect: verdict.kind === 'block' ? 'block' : 'allow', message: verdict.kind === 'block' ? verdict.reason : '', outcome: verdict.kind === 'block' ? 'deny' : 'allow' }
  }
  const decision = decideShell(fixture.tool, fixture.text, context, { isInlineBanEnabled: true })
  const outcome = outcomeFor(decision, fixture.agent === 'order')
  if (decision.kind === 'refuse') return { expect: 'block', message: decision.via === 'inline' ? decision.finding.shape : decision.verdict.reason, outcome }
  return { expect: decision.kind === 'judge' ? 'judge' : 'allow', message: '', outcome }
}

describe('stage 1: the inline-code ban and the scope guard', () => {
  for (const fixture of FIXTURES) {
    const expected = fixture.expectStage1 ?? fixture.expect
    test(`${fixture.name}: ${expected}`, () => {
      const result = stage1(fixture)
      expect(result.expect).toBe(expected)
      if (expected === 'block' && fixture.says && fixture.expectStage1 === undefined) expect(result.message).toContain(fixture.says)
      if (expected === 'block' && fixture.outcome) expect(result.outcome).toBe(fixture.outcome)
    })
  }
})
