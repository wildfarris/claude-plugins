import { describe, expect, test } from 'claude-code/testing'

import { analyzeCommand, checkFileEdit, denialMessage, describeScope, parseClassifierAnswer, resolvePath, scopeFolderCandidate, topLevelFolder } from '../hooks/scope-guard'
import { RULE_MARKER, builtInEntries, exclusiveConflict, parseRule, ruleKey, ruleSpec, syncRules } from '../hooks/scope-rules'

const ROOT = '/dev/work'
const AT_ROOT = { root: ROOT, cwd: ROOT, folders: [`${ROOT}/project`] }
const IN_PROJECT = { ...AT_ROOT, cwd: `${ROOT}/project` }

const kindOf = (command: string, context = AT_ROOT) => analyzeCommand(command, context).kind

describe('paths', () => {
  test('resolves relative paths and ..', () => {
    expect(resolvePath('/dev/work/project', '../other/a.ts')).toBe('/dev/work/other/a.ts')
    expect(resolvePath('/dev/work', './project/./a.ts')).toBe('/dev/work/project/a.ts')
    expect(resolvePath('/dev/work', '~/a')).toBeUndefined()
  })

  test('names the scope folder that would hold a path', () => {
    expect(topLevelFolder(ROOT, `${ROOT}/project/src/a.ts`)).toBe(`${ROOT}/project`)
    expect(topLevelFolder(ROOT, `${ROOT}/README.md`)).toBe(ROOT)
    expect(topLevelFolder(ROOT, ROOT)).toBeUndefined()
    expect(topLevelFolder(ROOT, '/tmp/x/a.ts')).toBeUndefined()
  })

  test('/scope takes the root (its own files) or a folder under it', () => {
    expect(scopeFolderCandidate(ROOT, '.')).toBe(ROOT)
    expect(scopeFolderCandidate(ROOT, ROOT)).toBe(ROOT)
    expect(scopeFolderCandidate(ROOT, 'project/')).toBe(`${ROOT}/project`)
    expect(scopeFolderCandidate(ROOT, '../elsewhere')).toBeUndefined()
    expect(describeScope({ root: ROOT, folders: [`${ROOT}/project`, ROOT] })).toBe('project/, ./ (root files)')
  })

  test('the root as a scope covers only the root\'s own files', () => {
    const rootFiles = { root: ROOT, cwd: ROOT, folders: [ROOT] }
    expect(checkFileEdit(`${ROOT}/CLAUDE.md`, rootFiles).kind).toBe('allow')
    expect(checkFileEdit(`${ROOT}/project/a.ts`, rootFiles).kind).toBe('block')
    expect(kindOf('git commit -m "docs"', rootFiles)).toBe('allow')
    expect(kindOf('echo x > notes.md', rootFiles)).toBe('allow')
    expect(kindOf('rm project/a.ts', rootFiles)).toBe('block')
  })

  test('file edits: blocks siblings, allows the scope and anything outside the root', () => {
    expect(checkFileEdit(`${ROOT}/other/a.ts`, AT_ROOT).kind).toBe('block')
    expect(checkFileEdit(`${ROOT}/project/a.ts`, AT_ROOT).kind).toBe('allow')
    expect(checkFileEdit('/tmp/scratch.txt', AT_ROOT).kind).toBe('allow')
    expect(checkFileEdit('a.ts', IN_PROJECT).kind).toBe('allow')
  })
})

describe('the sed-at-the-root accident', () => {
  test('blocks sed -i on files found from the root', () => {
    expect(kindOf(`sed -i '' 's/foo/bar/g' $(grep -rl foo .)`)).toBe('block')
    expect(kindOf(`grep -rl foo . | xargs sed -i 's/foo/bar/g'`)).toBe('block')
    expect(kindOf(`find . -name '*.ts' -exec sed -i 's/a/b/' {} +`)).toBe('block')
    expect(kindOf(`sed -i 's/a/b/' *.ts`)).toBe('block')
  })

  test('allows the same commands scoped to the target', () => {
    expect(kindOf(`sed -i '' 's/foo/bar/g' $(grep -rl foo ./project)`)).toBe('allow')
    expect(kindOf(`cd project && grep -rl foo . | xargs sed -i 's/foo/bar/g'`)).toBe('allow')
    expect(kindOf(`sed -i 's/foo/bar/g' $(grep -rl foo .)`, IN_PROJECT)).toBe('allow')
    expect(kindOf(`find ./project -name '*.ts' -exec sed -i 's/a/b/' {} +`)).toBe('allow')
  })
})

describe('shell commands', () => {
  test('reading anywhere is fine', () => {
    expect(kindOf('grep -rn TODO .')).toBe('allow')
    expect(kindOf('cat ../other/README.md', IN_PROJECT)).toBe('allow')
    expect(kindOf('git -C other status')).toBe('allow')
    expect(kindOf(`sed -n '1,20p' other/a.ts`)).toBe('allow')
  })

  test('blocks writes that leave the target', () => {
    expect(kindOf('rm -rf ../other/build', IN_PROJECT)).toBe('block')
    expect(kindOf('echo hi > ../other/notes.txt', IN_PROJECT)).toBe('block')
    expect(kindOf('npm install')).toBe('block')
    expect(kindOf('git checkout .')).toBe('block')
    expect(kindOf('git -C other commit -m "wip"')).toBe('block')
    expect(kindOf(`perl -pi -e 's/a/b/' other/a.ts`)).toBe('block')
  })

  test('allows writes inside the target', () => {
    expect(kindOf('npm install', IN_PROJECT)).toBe('allow')
    expect(kindOf('git -C project commit -m "wip"')).toBe('allow')
    expect(kindOf('mkdir -p project/src/new && touch project/src/new/a.ts')).toBe('allow')
    expect(kindOf('ls 2>&1 >/dev/null')).toBe('allow')
  })

  test('heredoc bodies are data, not commands', () => {
    expect(kindOf(`cat <<'EOF' > project/notes.md\nrm -rf other\nEOF`)).toBe('allow')
  })

  test('scripts run from outside the target are unclear', () => {
    expect(kindOf('./scripts/migrate.sh')).toBe('unclear')
    expect(kindOf('python tools/fix.py')).toBe('unclear')
    expect(kindOf('./scripts/migrate.sh', IN_PROJECT)).toBe('allow')
    // Through xargs too: these used to throw (the inner segment had no heredocs).
    expect(kindOf('ls | xargs python tools/fix.py')).toBe('unclear')
    expect(kindOf('ls | xargs bash scripts/migrate.sh')).toBe('unclear')
  })

  test('without a scope nothing is policed', () => {
    expect(kindOf('rm -rf other', { root: ROOT, cwd: ROOT, folders: [] })).toBe('allow')
  })

  test('the denial tells Claude how to correct itself', () => {
    const verdict = { target: `${ROOT}/other/a.ts`, reason: 'changes files outside the target folder' }
    const command = denialMessage(verdict, AT_ROOT, 'command')
    expect(command).toContain('other/a.ts')
    expect(command).toContain('cd project')
    expect(command).toContain('/scope add other')
    // A file edit can't be re-run elsewhere: it names the scope to add, not a cd.
    const edit = denialMessage(verdict, AT_ROOT, 'edit')
    expect(edit).not.toContain('cd project')
    expect(edit).toContain('/scope add other')
    expect(edit).toContain('/scope clear')
    const rootFile = denialMessage({ target: `${ROOT}/CLAUDE.md`, reason: 'edits a file outside the target folder' }, AT_ROOT, 'edit')
    expect(rootFile).toContain("/scope add .` (the root's own files)")
  })

  test('read-only git commands are never blocked', () => {
    for (const command of [
      'git check-ignore -q agmen',
      'git ls-remote --heads origin main',
      'git rev-list --count origin/main..HEAD',
      'git merge-base --is-ancestor a b',
      "git for-each-ref --format='%(refname)' refs/heads",
      'git show-ref --verify refs/heads/main',
      'git cherry origin/main HEAD',
      'git worktree list',
      'git stash list',
      'git symbolic-ref --short HEAD',
    ]) {
      expect(kindOf(command)).toBe('allow')
    }
    expect(kindOf('git worktree remove other')).toBe('block')
    expect(kindOf('git stash push')).toBe('block')
    expect(kindOf('git symbolic-ref HEAD refs/heads/x')).toBe('block')
  })

  test('reads classifier answers', () => {
    expect(parseClassifierAnswer('ALLOW')).toEqual({ kind: 'allow' })
    expect(parseClassifierAnswer('BLOCK: writes into ../other')).toEqual({ kind: 'block', reason: 'writes into ../other' })
    expect(parseClassifierAnswer('maybe')).toBeUndefined()
  })
})

describe('long-lived rules', () => {
  const fence = parseRule('fence other', ROOT)!
  const exclusive = parseRule('exclusive api web', ROOT)!

  test('parse fences and exclusive pairs, refusing junk', () => {
    expect(fence).toEqual({ kind: 'fence', folder: `${ROOT}/other` })
    expect(exclusive).toEqual({ kind: 'exclusive', folders: [`${ROOT}/api`, `${ROOT}/web`] })
    expect(parseRule('fence ../escape', ROOT)).toBeUndefined()
    expect(parseRule('exclusive api api', ROOT)).toBeUndefined()
    expect(parseRule('wall other', ROOT)).toBeUndefined()
    expect(ruleSpec(exclusive, ROOT)).toBe('exclusive api web')
    expect(ruleKey(parseRule('exclusive web api', ROOT)!)).toBe(ruleKey(exclusive))
  })

  test('fences become deny rules; exclusive pairs become auto-mode sentences', () => {
    const entries = builtInEntries([fence, exclusive], ROOT, 'absolute')
    expect(entries.deny).toEqual(['Edit(//dev/work/other/**)'])
    expect(entries.softDeny[0]?.startsWith(RULE_MARKER)).toBe(true)
    expect(builtInEntries([fence], ROOT, 'project-relative').deny).toEqual(['Edit(/other/**)'])
  })

  test('sync keeps the user\'s own settings and replaces only what sidekick wrote', () => {
    const original = { permissions: { allow: ['Bash(npm test)'], deny: ['Read(.env)'] }, autoMode: { allow: ['$defaults', 'mine'] }, model: 'opus' }
    const entries = builtInEntries([fence, exclusive], ROOT, 'absolute')
    const synced = syncRules(original, [], entries)
    expect((synced.permissions as { deny: string[] }).deny).toEqual(['Read(.env)', 'Edit(//dev/work/other/**)'])
    expect((synced.autoMode as { soft_deny: string[] }).soft_deny[0]).toBe('$defaults')
    expect(syncRules(synced, entries.deny, builtInEntries([], ROOT, 'absolute'))).toEqual(original)
  })

  test('sync cleans entries left by the retired per-session push', () => {
    const retired = { autoMode: { environment: ['$defaults', '[sidekick scope] old'] } }
    expect(syncRules(retired, [], { deny: [], softDeny: [] })).toEqual({})
  })

  test('an exclusive rule refuses adding its partner to the scope', () => {
    expect(exclusiveConflict([exclusive], [`${ROOT}/api`], `${ROOT}/web`)).toEqual(exclusive)
    expect(exclusiveConflict([exclusive], [`${ROOT}/api`], `${ROOT}/docs`)).toBeUndefined()
    expect(exclusiveConflict([exclusive], [`${ROOT}/api/src`], `${ROOT}/web/app`)).toEqual(exclusive)
  })
})

describe('audit fixes', () => {
  test('commands inside substitutions, quotes, bash -c, eval and shell heredocs are judged', () => {
    expect(kindOf('ls $(rm -rf ../other)', IN_PROJECT)).toBe('block')
    expect(kindOf('ls `rm -rf ../other`', IN_PROJECT)).toBe('block')
    expect(kindOf('echo "$(rm -rf ../other)"', IN_PROJECT)).toBe('block')
    expect(kindOf("bash -c 'rm -rf ../other'", IN_PROJECT)).toBe('block')
    expect(kindOf('eval rm -rf ../other', IN_PROJECT)).toBe('block')
    expect(kindOf('sh <<EOF\nrm -rf ../other\nEOF', IN_PROJECT)).toBe('block')
    expect(kindOf("bash -c 'npm test'", IN_PROJECT)).toBe('allow')
  })

  test('inline interpreter code is unclear; in-place perl edits are still judged by their files', () => {
    expect(kindOf(`python3 -c "import shutil; shutil.rmtree('../other')"`, IN_PROJECT)).toBe('unclear')
    expect(kindOf('python3 - <<EOF\nprint(1)\nEOF', IN_PROJECT)).toBe('unclear')
    expect(kindOf(`perl -pi -e 's/a/b/' src/a.ts`, IN_PROJECT)).toBe('allow')
  })

  test('home paths and unresolvable cds', () => {
    const context = { root: ROOT, cwd: `${ROOT}/project`, folders: [`${ROOT}/project`], home: '/dev' }
    expect(analyzeCommand('rm -rf ~/work/other', context).kind).toBe('block')
    expect(analyzeCommand('cd && rm -rf work/other', context).kind).toBe('block')
    expect(analyzeCommand('cd $SOMEWHERE && rm -rf ../other', context).kind).toBe('unclear')
  })

  test('writes that hid among read-only commands', () => {
    expect(kindOf('curl -o ../other/x https://example.com', IN_PROJECT)).toBe('block')
    expect(kindOf('curl https://example.com', IN_PROJECT)).toBe('allow')
    expect(kindOf('dd if=/dev/zero of=../other/x', IN_PROJECT)).toBe('block')
    expect(kindOf('git -C other branch -D main')).toBe('block')
    expect(kindOf('git -C other branch -a')).toBe('allow')
    expect(kindOf('git -C other config --get user.name')).toBe('allow')
  })

  test('git -C paths resolve in that folder; copies only change their destination', () => {
    expect(kindOf('git -C project add src/a.ts')).toBe('allow')
    expect(kindOf('cp ../other/template.txt .', IN_PROJECT)).toBe('allow')
    expect(kindOf('cp src/a.ts ../other/', IN_PROJECT)).toBe('block')
  })
})
