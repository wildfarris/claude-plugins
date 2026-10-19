import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { baseStandIn, settle } from './stand-in'

const ROOT = '/dev/work'
const WEB = `${ROOT}/web`
const TESTS_RULE = { glob: '**/*.spec.ts', reason: 'the tests are the spec' }
const CSS_RULE = { kind: 'forbid', glob: '*/frontend/src/**/*.css', ops: ['create'], reason: 'no new CSS; use the theme tokens' }

type Denial = { deny?: string }

// The council mod's court, as its state holds it, with one dispatched order.
function councilWith(on: On, order: Record<string, unknown>) {
  on('command.list', () => ({ value: [{ name: 'council', description: '', source: 'plugin' }] }))
  on('state.get', ($, e, next) => (String(e.plugin) === 'council' && String(e.key) === 'court' ? { value: { value: { orders: [{ agentId: 'agent-1', status: 'dispatched', ...order }] }, version: 1 } } : next(e)))
}

// The files there are (path to text), for the guard's create-or-edit check
// and the settings file; returns the paths fs.exists was asked about. On a
// Windows host the engine hands fs calls native paths (/dev/work is
// C:\dev\work), so paths are compared without drive or separator style.
const pathKey = (path: unknown) => String(path).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').toLowerCase()

function filesIn(on: On, given: Map<string, string>): string[] {
  const files = new Map([...given].map(([path, text]) => [pathKey(path), text]))
  const seen: string[] = []
  on('fs.exists', ($, e) => {
    seen.push(pathKey(e.path))
    return { value: files.has(pathKey(e.path)) }
  })
  on('fs.read', ($, e) => {
    const text = files.get(pathKey(e.path))
    if (text === undefined) throw new Error(`ENOENT: ${String(e.path)}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(pathKey(e.path), String(e.text))
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  return seen
}

const start = async ($: Engine, root = ROOT) => {
  await $.session.start({ cwd: root, surface: 'desktop', isInteractive: true })
  await settle()
}
const write = ($: Engine, file_path: string, agentId?: string) => $.tool.call({ tool: 'Write', file_path, content: 'x', ...(agentId ? { agentId } : {}) } as never) as Promise<Denial>
const edit = ($: Engine, file_path: string, agentId?: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b', ...(agentId ? { agentId } : {}) } as never) as Promise<Denial>
const notebook = ($: Engine, notebook_path: string, agentId?: string) => $.tool.call({ tool: 'NotebookEdit', notebook_path, new_source: 'x', ...(agentId ? { agentId } : {}) } as never) as Promise<Denial>

test("an order's forbid: its knight may not create, edit or delete the tests, but changes the source", async ($, on) => {
  const harness = baseStandIn(on, { root: ROOT, decide: () => 'allow' })
  const seen = filesIn(
    on,
    new Map([
      [`${WEB}/src/app.ts`, 'a'],
      [`${WEB}/src/app.spec.ts`, 'a'],
    ]),
  )
  councilWith(on, { id: 'O7', folder: WEB, forbid: [TESTS_RULE] })
  await start($)

  const edited = await edit($, `${WEB}/src/app.spec.ts`, 'agent-1')
  expect(seen).toContain(pathKey(`${WEB}/src/app.spec.ts`))
  expect(edited.deny).toContain("editing src/app.spec.ts is forbidden by order O7's rule `**/*.spec.ts`")
  expect(edited.deny).toContain('file-tool layer')
  expect(edited.deny).toContain('if it must change, stop and report why instead of working around it')
  expect((await write($, `${WEB}/src/new.spec.ts`, 'agent-1')).deny).toContain('creating src/new.spec.ts is forbidden')
  expect((await notebook($, `${WEB}/src/app.spec.ts`, 'agent-1')).deny).toContain('editing src/app.spec.ts')
  expect(harness.toasts.some(toast => toast.includes('order O7, file tool layer'))).toBe(true)

  expect((await edit($, `${WEB}/src/app.ts`, 'agent-1')).deny).toBeUndefined()
  expect((await write($, `${WEB}/src/new.ts`, 'agent-1')).deny).toBeUndefined()
  // The order's rules are its agent's: the main session is not held to them.
  expect((await edit($, `${WEB}/src/app.spec.ts`)).deny).toBeUndefined()
})

test('a standing forbid rule: no new CSS under */frontend/src, though an existing file may be edited', async ($, on) => {
  baseStandIn(on, { root: ROOT, decide: () => 'allow', store: { [`rules:${ROOT}`]: [CSS_RULE] } })
  filesIn(on, new Map([[`${ROOT}/shop/frontend/src/app.css`, 'a']]))
  await start($)

  const created = await write($, `${ROOT}/shop/frontend/src/button.css`)
  expect(created.deny).toContain('creating shop/frontend/src/button.css is forbidden by the standing rule `*/frontend/src/**/*.css` (create)')
  expect(created.deny).toContain('protected by a standing rule in this workspace (reason: no new CSS; use the theme tokens)')
  expect((await write($, `${ROOT}/shop/frontend/src/app.css`)).deny).toBeUndefined()
  expect((await edit($, `${ROOT}/shop/frontend/src/app.css`)).deny).toBeUndefined()
  expect((await write($, `${ROOT}/shop/backend/src/button.css`)).deny).toBeUndefined()
})

test('a standing rule binds a council knight too, and is named apart from its order', async ($, on) => {
  baseStandIn(on, { root: ROOT, decide: () => 'allow', store: { [`rules:${ROOT}`]: [CSS_RULE] } })
  filesIn(on, new Map())
  councilWith(on, { id: 'O9', folder: `${ROOT}/shop`, forbid: [TESTS_RULE] })
  await start($)
  expect((await write($, `${ROOT}/shop/frontend/src/b.css`, 'agent-1')).deny).toContain('the standing rule')
  expect((await write($, `${ROOT}/shop/frontend/src/b.spec.ts`, 'agent-1')).deny).toContain("order O9's rule")
})

test('on Windows, an order rule matches however the path is spelled', async ($, on) => {
  const WIN = 'C:\\claude\\workspace'
  baseStandIn(on, { root: WIN, decide: () => 'allow' })
  filesIn(on, new Map())
  councilWith(on, { id: 'O3', folder: `${WIN}/web`, forbid: [TESTS_RULE] })
  await start($, WIN)
  for (const path of ['C:\\claude\\workspace\\web\\src\\a.spec.ts', 'c:/claude/workspace/web/src/A.Spec.ts', '/c/claude/workspace/web/src/a.spec.ts']) {
    expect((await write($, path, 'agent-1')).deny).toContain("order O3's rule")
  }
  expect((await write($, 'C:\\claude\\workspace\\web\\src\\a.ts', 'agent-1')).deny).toBeUndefined()
})
