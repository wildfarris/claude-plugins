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

test("the owner's inline code: refused until the PreToolUse hook is known to fire, then left to it as a question", async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT, decide: () => 'allow' })
  await start($)
  // No PreToolUse seen yet in this process: refused, with the way out.
  const refused = await call($, 'Bash', 'node -p 2')
  expect(refused.deny).toContain('inline interpreter code (node -p)')
  expect(refused.deny).toContain('The owner can approve this one call when asked')
  expect(harness.tools).toEqual([])
  // A plain command runs (and its PreToolUse fires inside it).
  expect((await call($, 'Bash', 'ls')).deny).toBeUndefined()
  // Now the question is left for the PreToolUse hook, which puts it before the
  // tool runs (this stand-in doesn't model the dialog, so the call runs).
  expect((await call($, 'Bash', 'node -p 1')).deny).toBeUndefined()
  expect((await call($, 'PowerShell', 'iex $x')).deny).toBeUndefined()
  expect(harness.tools).toEqual(['Bash', 'Bash', 'PowerShell'])
  // Had the hook not put it, a toast would say so.
  expect(harness.toasts.some(toast => toast.includes('could not ask you'))).toBe(false)
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

// ── The policy judge through the hooks ─────────────────────────────────────

// `ps -A -o pid=,ppid=,lstart=,comm=,args=` on a POSIX host: claude (1000)
// started a dev server (4100) that drove one Edge (4200); the owner's Edge
// (2000, 2001) is outside; the query itself (5555) is claude's child.
const PS_OUTPUT = [
  ' 1000     1 Mon Oct 20 08:00:00 2026 claude claude',
  ' 1100  1000 Mon Oct 20 09:00:00 2026 bash bash -c npm run dev',
  ' 4100  1100 Mon Oct 20 09:00:02 2026 node node server.mjs --token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  ' 4200  4100 Mon Oct 20 09:00:05 2026 msedge msedge --headless',
  ' 2000     1 Mon Oct 20 07:05:00 2026 msedge msedge',
  ' 2001  2000 Mon Oct 20 07:05:01 2026 msedge msedge --type=renderer',
  ' 5555  1000 Mon Oct 20 10:00:00 2026 ps ps -A -o pid=,ppid=,lstart=,comm=,args=',
].join('\n')
const psRun = (argv: readonly string[]) => (argv[0] === 'ps' ? { exitCode: 0, stdout: PS_OUTPUT } : undefined)

test("an order's agent: taskkill by name goes to the judge with the process tree, and its BLOCK is denied", async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT, cwd: WEB, decide: () => 'allow', run: psRun, complete: () => "BLOCK: kills the owner's Edge windows outside this session" })
  councilWith(on, { id: 'O5', folder: WEB, policy: ['Push nothing.'] })
  await start($)
  const refused = await call($, 'Bash', 'taskkill /IM msedge.exe /F', 'agent-1')
  expect(refused.deny).toContain("Blocked by the sidekick policy judge: kills the owner's Edge windows outside this session.")
  expect(refused.deny).toContain('stop and report')
  expect(harness.completions.length).toBe(1)
  const { system, prompt } = harness.completions[0]!
  expect(system).toContain('5. Push nothing. (order O5)')
  expect(prompt).toContain("msedge.exe (by name): 3 running; 1 inside this session's process tree (pid 4200); 2 outside it")
  expect(prompt).toContain('pid 4100 parent 1100 node started')
  expect(prompt).not.toContain('ghp_abcdefghijklmnop')
  expect(prompt).toContain("run by: a council order's agent (order O5)")
  expect(harness.tools).toEqual([])
})

test("read-only and in-folder commands never reach the judge; what it allowed once isn't asked again", async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT, cwd: WEB, decide: () => 'allow', complete: () => 'ALLOW' })
  councilWith(on, { id: 'O5', folder: WEB })
  await start($)
  for (const command of ['git status && git log -3', "rg -n TODO src | head -5", 'echo x > notes.md', 'git add notes.md && git commit -m "notes"']) {
    expect((await call($, 'Bash', command, 'agent-1')).deny).toBeUndefined()
  }
  expect(harness.completions.length).toBe(0)
  expect((await call($, 'Bash', 'npm run lint', 'agent-1')).deny).toBeUndefined()

  expect((await call($, 'Bash', 'npm run lint', 'agent-1')).deny).toBeUndefined()
  expect(harness.completions.length).toBe(1)
  // The judge reads the commands that ran before.
  await call($, 'Bash', 'make check', 'agent-1')
  expect(harness.completions[1]!.prompt).toContain('npm run lint')
})

test('a long chain is refused for complexity without a call; a failed judge fails closed for an agent', async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT, cwd: WEB, decide: () => 'allow', complete: () => ({ isAnswered: false, reason: 'aborted' }) })
  councilWith(on, { id: 'O5', folder: WEB })
  await start($)
  const chain = await call($, 'Bash', 'make a && make b && make c && make d && make e', 'agent-1')
  expect(chain.deny).toContain("it has 5 parts the guard can't clear on its own (the limit is 4)")
  expect(chain.deny).toContain('Split it into smaller commands')
  expect(harness.completions.length).toBe(0)
  const failed = await call($, 'PowerShell', 'Stop-Service Spooler', 'agent-1')
  expect(failed.deny).toContain('the policy judge gave no answer (aborted)')
  expect(failed.deny).toContain('fails closed')
  expect(harness.tools).toEqual([])
})

test('when the judge blocks the owner: refused until the PreToolUse hook is known to fire, then asked', async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT, decide: () => 'allow', complete: () => 'BLOCK: installs a tool on the machine' })
  await start($)
  const refused = await call($, 'Bash', 'winget install jqlang.jq')
  expect(refused.deny).toContain('Blocked by the sidekick policy judge: installs a tool on the machine.')
  expect(refused.deny).toContain('/scope judge off')
  expect((await call($, 'Bash', 'git status')).deny).toBeUndefined()
  expect((await call($, 'Bash', 'winget install jqlang.jq')).deny).toBeUndefined()
  expect(harness.tools).toEqual(['Bash', 'Bash'])
  expect(harness.completions.length).toBe(2)
  expect(harness.completions[0]!.prompt).toContain("run by: the owner's own interactive session")
  expect(harness.toasts.some(toast => toast.includes('could not ask you'))).toBe(false)
})

test('/scope judge off turns the judge off for the session; the ban still holds; /scope show says so', async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT, cwd: WEB, decide: () => 'allow', complete: () => 'BLOCK: no' })
  councilWith(on, { id: 'O5', folder: WEB })
  await start($)
  expect(String((await $.command.run(composer('scope', 'judge off'))).text)).toContain('off for this session')
  expect((await call($, 'Bash', 'nvm use 22', 'agent-1')).deny).toBeUndefined()
  expect((await call($, 'Bash', 'node -e 1', 'agent-1')).deny).toContain('inline interpreter code')
  expect(harness.completions.length).toBe(0)
  const shown = String((await $.command.run(composer('scope', 'show'))).text)
  expect(shown).toContain('Policy judge: off for this session')
  expect(shown).toContain("Policy (4): Change files only inside the target folders. Stop only processes this session started, by their ID.")
  await $.command.run(composer('scope', 'judge on'))
  expect((await call($, 'Bash', 'nvm use 22', 'agent-1')).deny).toContain('Blocked by the sidekick policy judge: no.')
})
