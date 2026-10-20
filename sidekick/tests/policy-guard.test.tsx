// The policy guard through the hooks: the inline-code ban for agents and the
// owner, the PowerShell tool held like Bash, and policy sentences in /rules.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { baseStandIn, composer, settle } from './stand-in'

const ROOT = '/dev/work'
const WEB = `${ROOT}/web`

type Denial = { deny?: string }

function councilWith(on: On, order: Record<string, unknown>) {
  on('command.list', () => ({ value: [{ name: 'council', description: '', source: 'plugin' }] }))
  on('state.get', ($, e, next) => (String(e.plugin) === 'council' && String(e.key) === 'court' ? { value: { value: { orders: [{ agentId: 'agent-1', status: 'dispatched', ...order }] }, version: 1 } } : next(e)))
}

const call = ($: Engine, tool: string, command: string, agentId?: string) => $.tool.call({ tool, command, ...(agentId ? { agentId } : {}) } as never) as Promise<Denial>

const start = async ($: Engine) => {
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await settle()
}

test("an order's agent is refused inline code, told what to use instead, and to stop and report", async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT, cwd: WEB, decide: () => 'allow' })
  councilWith(on, { id: 'O5', folder: WEB })
  await start($)
  const refused = await call($, 'Bash', 'node -e "console.log(1)"', 'agent-1')
  expect(refused.deny).toContain('inline interpreter code (node -e)')
  expect(refused.deny).toContain('write a script file in the repo and run it')
  expect(refused.deny).toContain('stop and report')
  expect((await call($, 'Bash', "python3 - <<'EOF'\nprint(1)\nEOF", 'agent-1')).deny).toContain('python3 -')
  expect((await call($, 'PowerShell', "'x' | node", 'agent-1')).deny).toContain('node reading code from a pipe')
  expect(harness.completions).toEqual([])
  expect(harness.tools).toEqual([])
  // A script file, and a heredoc that only writes a file, run.
  expect((await call($, 'Bash', "cat <<'EOF' > notes.md\nimport os\nEOF", 'agent-1')).deny).toBeUndefined()
  expect(harness.tools).toEqual(['Bash'])
})

test("the owner is asked about inline code; once asked, the call goes through; unasked, it's refused", async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT, decide: () => 'allow' })
  await start($)
  const check = await $.tool.check({ tool: 'Bash', input: { command: 'node -p 1' } })
  expect(check.decision).toBe('ask')
  expect(String(check.reason)).toContain('inline interpreter code (node -p)')
  expect((await call($, 'Bash', 'node -p 1')).deny).toBeUndefined()
  expect(harness.tools).toEqual(['Bash'])
  // Not asked first (the check never ran): refused, with the way out.
  const refused = await call($, 'Bash', 'node -p 2')
  expect(refused.deny).toContain('The owner can approve this one call when asked')
  // Plain commands are not asked about.
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'PowerShell', input: { command: 'iex $x' } })).decision).toBe('ask')
})


test('the PowerShell tool is held to the folder and the path rules like Bash', async ($, on) => {
  baseStandIn(on, { root: ROOT, cwd: WEB, decide: () => 'allow', files: new Map([[`${WEB}/src/app.ts`, 'a']]) })
  councilWith(on, { id: 'O6', folder: WEB, forbid: [{ glob: '**/*.spec.ts', reason: 'the tests are the spec' }] })
  await start($)
  const outside = await call($, 'PowerShell', 'Remove-Item ../api/a.txt', 'agent-1')
  expect(outside.deny).toContain('changes files outside the target folder')
  const spec = await call($, 'PowerShell', "Set-Content -Path src/app.spec.ts -Value 'x'", 'agent-1')
  expect(spec.deny).toContain('PowerShell layer')
  expect(spec.deny).toContain("order O6's rule `**/*.spec.ts`")
  expect((await call($, 'PowerShell', "Set-Content -Path src/app.ts -Value 'x'", 'agent-1')).deny).toBeUndefined()
})

test('/rules adds a policy sentence, lists it with the defaults, and removes it', async ($, on) => {
  baseStandIn(on, { root: ROOT, files: new Map() })
  await start($)
  const added = await $.command.run(composer('rules', "add policy Don't open pull requests."))
  expect(String(added.text)).toContain(`"Don't open pull requests." (policy, for the judge)`)
  const listed = String((await $.command.run(composer('rules', 'list'))).text)
  expect(listed).toContain("1. \"Don't open pull requests.\"")
  expect(listed).toContain("Default policy (ships with sidekick): Change files only inside the target folders. Stop only processes this session started, by their ID. Don't change installed tools, PATH, services or system settings. Don't run Python.")
  expect(String((await $.command.run(composer('rules', 'add policy'))).text)).toContain('Usage')
  expect(String((await $.command.run(composer('rules', 'remove 1'))).text)).toContain('Removed')
})
