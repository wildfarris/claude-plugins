import { describe, expect, test } from 'claude-code/testing'

import { orderFor } from '../hooks/council-glimpse'
import { commandPathOps } from '../hooks/scope-guard'
import {
  RULE_MARKER,
  builtInEntries,
  globRegExp,
  isLongLivedRule,
  matchPathRules,
  normalizeGlob,
  parseRule,
  pathRuleDenial,
  readPathRule,
  ruleKey,
  ruleSpec,
  standingPathRules,
  type ActivePathRule,
  type PathOp,
} from '../hooks/scope-rules'

const ROOT = '/dev/work'
const WEB_DIR = `${ROOT}/web`
const ALL: PathOp[] = ['create', 'edit', 'delete']
const TESTS: ActivePathRule = { glob: '**/*.spec.ts', ops: ALL, reason: 'the tests are the spec', base: `${ROOT}/web`, source: { kind: 'order', id: 'O7' } }
const NO_NEW_CSS: ActivePathRule = { glob: '*/frontend/src/**/*.css', ops: ['create'], reason: 'use the theme tokens', base: ROOT, source: { kind: 'standing' } }

const hits = (path: string, ops: PathOp[], rules: ActivePathRule[] = [TESTS, NO_NEW_CSS]) => matchPathRules(path, ops, rules).map(hit => `${hit.op} ${hit.path}`)

describe('globs', () => {
  test('* stays in one name, ** spans folders, a bare name matches at any depth', () => {
    const spec = globRegExp('**/*.spec.ts', false)
    expect(spec.test('a.spec.ts')).toBe(true)
    expect(spec.test('src/app/a.spec.ts')).toBe(true)
    expect(spec.test('src/a.ts')).toBe(false)
    expect(spec.test('src/a.spec.tsx')).toBe(false)
    expect(globRegExp('*.css', false).test('deep/in/a.css')).toBe(true)
    expect(globRegExp('src/*.css', false).test('src/deep/a.css')).toBe(false)
    expect(globRegExp('*_test.go', false).test('pkg/x/y_test.go')).toBe(true)
    expect(globRegExp('docs/**', false).test('docs/a/b.md')).toBe(true)
    expect(globRegExp('a?.md', false).test('ab.md')).toBe(true)
    // Dots, brackets and the like are literal.
    expect(globRegExp('a.(b).md', false).test('a.(b).md')).toBe(true)
    expect(globRegExp('a.md', false).test('axmd')).toBe(false)
  })

  test('globs are stored relative and plain; climbing or absolute ones are refused', () => {
    expect(normalizeGlob('./src\\**\\*.css')).toBe('src/**/*.css')
    expect(normalizeGlob('generated/')).toBe('generated/**')
    expect(normalizeGlob('../other/*.ts')).toBeUndefined()
    expect(normalizeGlob('/etc/*.conf')).toBeUndefined()
    expect(normalizeGlob('C:\\x\\*.ts')).toBeUndefined()
    expect(normalizeGlob('  ')).toBeUndefined()
  })
})

describe('matching changes against path rules', () => {
  test('tests protected: create, edit and delete of a spec are refused; source files are not', () => {
    for (const op of ALL) expect(hits(`${ROOT}/web/src/app.spec.ts`, [op])).toEqual([`${op} src/app.spec.ts`])
    expect(hits(`${ROOT}/web/src/app.ts`, ALL)).toEqual([])
    // The order's rule covers only its own folder.
    expect(hits(`${ROOT}/api/src/app.spec.ts`, ALL)).toEqual([])
  })

  test('no new CSS: creating one is refused, editing an existing one is not', () => {
    expect(hits(`${ROOT}/shop/frontend/src/a/b.css`, ['create'])).toEqual(['create shop/frontend/src/a/b.css'])
    expect(hits(`${ROOT}/shop/frontend/src/a/b.css`, ['edit'])).toEqual([])
    expect(hits(`${ROOT}/shop/frontend/src/a/b.css`, ['delete'])).toEqual([])
    expect(hits(`${ROOT}/shop/backend/src/b.css`, ['create'])).toEqual([])
    // Not knowing whether it exists, the guard asks about both.
    expect(hits(`${ROOT}/shop/frontend/src/b.css`, ['create', 'edit'])).toEqual(['create shop/frontend/src/b.css'])
  })

  test('Windows paths match in any spelling, case-insensitively; POSIX names are exact', () => {
    const WIN = 'C:\\claude\\workspace'
    const rule: ActivePathRule = { ...TESTS, base: `${WIN}/web` }
    for (const path of ['c:/claude/workspace/web/src/App.SPEC.ts', 'C:\\claude\\workspace\\web\\src\\app.spec.ts', 'C:\\Claude\\Workspace\\WEB\\src\\app.spec.ts']) {
      expect(matchPathRules(path, ['edit'], [rule]).length).toBe(1)
    }
    expect(matchPathRules('c:/claude/workspace/api/src/app.spec.ts', ['edit'], [rule])).toEqual([])
    expect(hits(`${ROOT}/web/src/App.SPEC.ts`, ['edit'])).toEqual([])
  })

  test('the refusal names the change, the rule, its source and layer, and says to stop and report', () => {
    const denial = pathRuleDenial(matchPathRules(`${ROOT}/web/a.spec.ts`, ['edit'], [TESTS]), 'file tool')
    expect(denial).toContain('file-tool layer')
    expect(denial).toContain("editing a.spec.ts is forbidden by order O7's rule `**/*.spec.ts` (create, edit, delete), reason: the tests are the spec")
    expect(denial).toContain('This path is protected in this order (reason: the tests are the spec); if it must change, stop and report why instead of working around it.')
    const standing = pathRuleDenial(matchPathRules(`${ROOT}/shop/frontend/src/b.css`, ['create'], [NO_NEW_CSS]), 'Bash')
    expect(standing).toContain('Bash layer')
    expect(standing).toContain('the standing rule `*/frontend/src/**/*.css` (create)')
    expect(standing).toContain('protected by a standing rule in this workspace (reason: use the theme tokens)')
  })
})

describe('standing forbid rules', () => {
  const css = parseRule('forbid */frontend/src/**/*.css create no new CSS; use the theme tokens', ROOT)!

  test('/rules add forbid <glob> [ops] <reason>', () => {
    expect(css).toEqual({ kind: 'forbid', glob: '*/frontend/src/**/*.css', ops: ['create'], reason: 'no new CSS; use the theme tokens' })
    expect(parseRule('forbid **/*.spec.ts the tests are the spec', ROOT)).toEqual({ kind: 'forbid', glob: '**/*.spec.ts', ops: ALL, reason: 'the tests are the spec' })
    expect(parseRule('forbid *.ts delete,edit keep them', ROOT)).toEqual({ kind: 'forbid', glob: '*.ts', ops: ['edit', 'delete'], reason: 'keep them' })
    expect(parseRule('forbid *.css', ROOT)).toBeUndefined()
    expect(parseRule('forbid ../x/*.css reason', ROOT)).toBeUndefined()
    expect(parseRule(ruleSpec(css, ROOT), ROOT)).toEqual(css)
    expect(ruleKey(css)).toBe('forbid */frontend/src/**/*.css create')
    expect(isLongLivedRule(css)).toBe(true)
    expect(isLongLivedRule({ kind: 'forbid', glob: '../x', ops: ['create'], reason: 'r' })).toBe(false)
  })

  test('they are matched from the root and told to the auto-mode classifier', () => {
    expect(standingPathRules([css, parseRule('fence other', ROOT)!], ROOT)).toEqual([{ glob: css.glob, ops: ['create'], reason: css.reason, base: ROOT, source: { kind: 'standing' } }])
    const sentence = builtInEntries([css], ROOT, 'absolute').softDeny[0]!
    expect(sentence.startsWith(RULE_MARKER)).toBe(true)
    expect(sentence).toContain('Creating files matching */frontend/src/**/*.css under /dev/work')
    expect(builtInEntries([css], ROOT, 'absolute').deny).toEqual([])
  })
})

describe('the paths a shell command changes', () => {
  const ops = (command: string, cwd = WEB_DIR) => commandPathOps(command, { root: ROOT, cwd }).map(change => `${change.op} ${change.path}${change.into.length > 0 ? ` into ${change.into.join(',')}` : ''}`)

  test('deleters delete; mv deletes its sources and writes its destination; writers write', () => {
    expect(ops('rm -f src/a.spec.ts')).toEqual([`delete ${WEB_DIR}/src/a.spec.ts`])
    expect(ops('mv src/a.spec.ts src/b.ts')).toEqual([`delete ${WEB_DIR}/src/a.spec.ts`, `write ${WEB_DIR}/src/b.ts into a.spec.ts`])
    expect(ops('mv -t dest a.ts b.ts')).toEqual([`delete ${WEB_DIR}/a.ts`, `delete ${WEB_DIR}/b.ts`, `write ${WEB_DIR}/dest into a.ts,b.ts`])
    expect(ops('cp ../shared/a.css styles/')).toEqual([`write ${WEB_DIR}/styles into a.css`])
    expect(ops('echo x > a.css && echo y >> b.css')).toEqual([`write ${WEB_DIR}/a.css`, `write ${WEB_DIR}/b.css`])
    expect(ops("sed -i 's|a|b|' src/a.spec.ts")).toEqual([`write ${WEB_DIR}/src/a.spec.ts`])
    expect(ops('touch x.css && echo hi | tee y.css && chmod +x run.sh')).toEqual([`write ${WEB_DIR}/x.css`, `write ${WEB_DIR}/y.css`, `write ${WEB_DIR}/run.sh`])
    expect(ops('curl -o page.css https://x && dd if=/dev/zero of=blob.bin')).toEqual([`write ${WEB_DIR}/page.css`, `write ${WEB_DIR}/blob.bin`])
  })

  test('git rm, mv, checkout and restore name files; git -C, cd, bash -c and $(…) are followed', () => {
    expect(ops('git rm -q src/a.spec.ts')).toEqual([`delete ${WEB_DIR}/src/a.spec.ts`])
    expect(ops('git -C web checkout -- src/a.spec.ts', ROOT)).toEqual([`write ${WEB_DIR}/src/a.spec.ts`])
    expect(ops('git mv a.spec.ts b.spec.ts')).toEqual([`delete ${WEB_DIR}/a.spec.ts`, `write ${WEB_DIR}/b.spec.ts into a.spec.ts`])
    expect(ops('git add src/a.spec.ts && git commit -m x')).toEqual([])
    expect(ops('cd src && rm a.spec.ts')).toEqual([`delete ${WEB_DIR}/src/a.spec.ts`])
    expect(ops("bash -c 'rm src/a.spec.ts'")).toEqual([`delete ${WEB_DIR}/src/a.spec.ts`])
    expect(ops('echo $(rm src/a.spec.ts)')).toEqual([`delete ${WEB_DIR}/src/a.spec.ts`])
  })

  test('indirect writes are not seen: scripts, build tools, find -delete, xargs fed by a pipe, interpreters', () => {
    for (const command of ["node scripts/gen.js src/a.spec.ts", 'npm run build', "find . -name '*.spec.ts' -delete", 'git ls-files | xargs rm', "python3 -c 'open(\"a.css\",\"w\")'", 'make clean']) {
      expect(ops(command)).toEqual([])
    }
    // Reads change nothing.
    expect(ops('cat src/a.spec.ts && grep -rn x src')).toEqual([])
  })

  test('Windows and Git Bash paths come out canonical', () => {
    const WIN = 'C:\\claude\\workspace'
    const win = (command: string) => commandPathOps(command, { root: WIN, cwd: WIN }).map(change => `${change.op} ${change.path}`)
    expect(win("rm 'C:\\claude\\workspace\\web\\src\\a.spec.ts'")).toEqual(['delete c:/claude/workspace/web/src/a.spec.ts'])
    expect(win('cd /c/claude/workspace/web && rm src/a.spec.ts')).toEqual(['delete c:/claude/workspace/web/src/a.spec.ts'])
    expect(win("echo x > 'web\\src\\b.css'")).toEqual(['write c:/claude/workspace/web/src/b.css'])
  })
})

describe("a council order's forbid", () => {
  test('is read by shape: ops default to all three, malformed entries are dropped', () => {
    expect(readPathRule({ glob: '**/*.spec.ts', reason: 'tests' })).toEqual({ glob: '**/*.spec.ts', ops: ALL, reason: 'tests' })
    expect(readPathRule({ glob: '*.css', ops: ['create', 'paint'] })).toEqual({ glob: '*.css', ops: ['create'], reason: 'no reason given' })
    expect(readPathRule({ glob: '../x' })).toBeUndefined()
    const court = {
      orders: [
        { id: 'O7', agentId: 'a1', status: 'dispatched', folder: '/w/web', forbid: [{ glob: '**/*.spec.ts', ops: ['edit'], reason: 'tests' }, { glob: '/abs' }, 'junk'] },
        { id: 'O8', agentId: 'a2', status: 'dispatched', folder: '/w/api' },
      ],
    }
    expect(orderFor(court, 'a1')).toEqual({ id: 'O7', folder: '/w/web', forbid: [{ glob: '**/*.spec.ts', ops: ['edit'], reason: 'tests' }] })
    expect(orderFor(court, 'a2')).toEqual({ id: 'O8', folder: '/w/api', forbid: [] })
  })
})
