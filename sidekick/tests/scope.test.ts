import { describe, expect, test } from 'claude-code/testing'

import { analyzeCommand, checkFileEdit, denialMessage, describeScope, parseClassifierAnswer, resolvePath, scopeFolderCandidate, topLevelFolder, type ScopeContext } from '../hooks/scope-guard'
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

describe('Windows paths', () => {
  const WIN = 'C:\\claude\\workspace'
  // The order's folder as the council writes it: the root, then a forward slash.
  const KNIGHT = { root: WIN, cwd: WIN, folders: [`${WIN}/agent-host`] }
  const IN_HOST = { ...KNIGHT, cwd: `${WIN}\\agent-host` }
  const editKind = (path: string, context: ScopeContext = KNIGHT) => checkFileEdit(path, context).kind
  const winKind = (command: string, context: ScopeContext = KNIGHT) => analyzeCommand(command, context).kind

  test('a knight edits inside its order folder, however the path is spelled', () => {
    for (const path of [
      'C:\\claude\\workspace\\agent-host\\docs\\build-prompt.md',
      'C:/claude/workspace/agent-host/docs/build-prompt.md',
      'c:\\claude\\workspace\\agent-host\\docs\\build-prompt.md',
      'C:\\claude/workspace\\agent-host/docs\\build-prompt.md',
      'C:\\claude\\\\workspace\\.\\agent-host\\docs\\build-prompt.md',
      '/c/claude/workspace/agent-host/docs/build-prompt.md',
      '/C/claude/workspace/agent-host/docs/build-prompt.md',
      '\\\\?\\C:\\claude\\workspace\\agent-host\\docs\\build-prompt.md',
      '\\\\.\\C:\\claude\\workspace\\agent-host\\docs\\build-prompt.md',
      'C:\\claude\\workspace\\agent-host\\docs\\..\\README.md',
    ]) {
      expect(editKind(path)).toBe('allow')
    }
    expect(editKind('docs\\build-prompt.md', IN_HOST)).toBe('allow')
    expect(editKind('docs/build-prompt.md', IN_HOST)).toBe('allow')
  })

  test('and nowhere else under the root', () => {
    for (const path of [
      'C:\\claude\\workspace\\castra\\README.md',
      'c:/claude/workspace/castra/README.md',
      '/c/claude/workspace/castra/README.md',
      'C:\\claude\\workspace\\CLAUDE.md',
      // A sibling whose name starts with the order folder's.
      'C:\\claude\\workspace\\agent-host2\\a.md',
      'C:\\claude\\workspace\\agent-host-old\\a.md',
      // .. climbing out of the order folder, or past the drive's root and back in.
      'C:\\claude\\workspace\\agent-host\\..\\castra\\a.md',
      'C:\\claude\\workspace\\agent-host\\docs\\..\\..\\castra\\a.md',
      'C:\\..\\..\\claude\\workspace\\castra\\a.md',
      '\\\\?\\C:\\claude\\workspace\\castra\\a.md',
      '\\\\.\\C:\\claude\\workspace\\castra\\a.md',
      // The root's folders in another case: the same folders on Windows.
      'C:\\CLAUDE\\Workspace\\castra\\a.md',
      // Another case of the order folder itself is held to the exact name.
      'C:\\claude\\workspace\\Agent-Host\\a.md',
    ]) {
      expect(editKind(path)).toBe('block')
    }
    expect(editKind('..\\castra\\a.md', IN_HOST)).toBe('block')
    expect(editKind('../castra/a.md', IN_HOST)).toBe('block')
  })

  test('outside the root is never policed: other drives, other folders, climbing out', () => {
    expect(editKind('D:\\claude\\workspace\\castra\\a.md')).toBe('allow')
    expect(editKind('/d/claude/workspace/castra/a.md')).toBe('allow')
    expect(editKind('C:\\Users\\JEREMY~1\\AppData\\Local\\Temp\\a.md')).toBe('allow')
    expect(editKind('C:\\claude\\workspace\\agent-host\\..\\..\\other\\a.md')).toBe('allow')
    expect(editKind('C:\\claude\\workspace2\\a.md')).toBe('allow')
  })

  test('paths the guard cannot place are blocked, not let through', () => {
    for (const path of [
      // UNC paths and admin shares can reach the root's drive.
      '\\\\localhost\\c$\\claude\\workspace\\castra\\a.md',
      '\\\\server\\share\\a.md',
      '//localhost/c$/claude/workspace/castra/a.md',
      '\\\\?\\UNC\\localhost\\c$\\claude\\workspace\\castra\\a.md',
      // Device and volume paths.
      '\\\\.\\pipe\\x',
      '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\claude\\workspace\\castra\\a.md',
      // Drive-relative on the root's drive, from another drive.
      'C:castra\\a.md',
      // Short (8.3) names and trailing dots or spaces where the root's folders are.
      'C:\\CLAUDE~1\\workspace\\castra\\a.md',
      'C:\\claude\\WORKSP~1\\castra\\a.md',
      'C:\\claude\\workspace.\\castra\\a.md',
      'C:\\claude\\workspace\\castra.\\a.md',
      'C:\\claude\\workspace\\agent-host \\a.md',
      // A stream on a file or folder.
      'C:\\claude\\workspace\\agent-host:stream',
    ]) {
      expect(checkFileEdit(path, { ...KNIGHT, cwd: 'D:\\elsewhere' }).kind).toBe('block')
    }
    const denial = denialMessage(checkFileEdit('\\\\server\\share\\a.md', KNIGHT) as { target: string; reason: string }, KNIGHT, 'edit')
    expect(denial).toContain('cannot place')
  })

  test('drive-relative and drive-rooted paths resolve against the folder they run in', () => {
    expect(editKind('C:docs\\a.md', IN_HOST)).toBe('allow')
    expect(editKind('C:..\\castra\\a.md', IN_HOST)).toBe('block')
    expect(editKind('\\claude\\workspace\\castra\\a.md', IN_HOST)).toBe('block')
    expect(editKind('\\claude\\workspace\\agent-host\\a.md', IN_HOST)).toBe('allow')
  })

  test('a file edit path is literal: $ and an unknown home are not let through', () => {
    expect(editKind('C:\\claude\\workspace\\castra\\$x.md')).toBe('block')
    expect(editKind('C:\\claude\\workspace\\agent-host\\$x.md')).toBe('allow')
    expect(checkFileEdit('/dev/work/other/$x.ts', AT_ROOT).kind).toBe('block')
    expect(checkFileEdit('/dev/work/project/$x.ts', AT_ROOT).kind).toBe('allow')
    expect(checkFileEdit('~/a.md', KNIGHT).kind).toBe('block')
    expect(checkFileEdit('~/a.md', { ...KNIGHT, home: 'C:\\Users\\me' }).kind).toBe('allow')
    expect(checkFileEdit('~/workspace/castra/a.md', { ...KNIGHT, home: '/c/claude' }).kind).toBe('block')
    // On POSIX too: ~ resolves against home when it is known, and is blocked when it isn't.
    expect(checkFileEdit('~/work/other/a.ts', { ...AT_ROOT, home: '/dev' }).kind).toBe('block')
    expect(checkFileEdit('~/.claude/notes.md', { ...AT_ROOT, home: '/home/me' }).kind).toBe('allow')
    expect(checkFileEdit('~/.claude/notes.md', AT_ROOT).kind).toBe('block')
  })

  test('root, cwd, home and order folders are read in any spelling', () => {
    for (const context of [
      { root: 'C:\\claude\\workspace', cwd: 'C:\\claude\\workspace', folders: ['C:\\claude\\workspace\\agent-host'] },
      { root: 'c:/claude/workspace/', cwd: 'C:/claude/workspace', folders: ['c:\\claude\\workspace\\agent-host\\'] },
      { root: 'C:\\claude\\workspace', cwd: '/c/claude/workspace', folders: ['/c/claude/workspace/agent-host'] },
      { root: 'C:\\claude\\workspace', cwd: 'C:\\claude\\workspace', folders: ['agent-host'] },
    ]) {
      expect(editKind('C:\\claude\\workspace\\agent-host\\a.md', context)).toBe('allow')
      expect(editKind('C:\\claude\\workspace\\castra\\a.md', context)).toBe('block')
      expect(winKind('rm -rf castra', context)).toBe('block')
      expect(winKind('rm -rf agent-host/build', context)).toBe('allow')
    }
    // An order folder the guard cannot place covers nothing, but still keeps the guard on.
    const unplaced = { root: WIN, cwd: WIN, folders: ['\\\\server\\share\\agent-host'] }
    expect(editKind('C:\\claude\\workspace\\agent-host\\a.md', unplaced)).toBe('block')
  })

  test('the scope folder for a Windows path', () => {
    expect(scopeFolderCandidate(WIN, 'agent-host')).toBe('c:/claude/workspace/agent-host')
    expect(scopeFolderCandidate(WIN, 'agent-host\\')).toBe('c:/claude/workspace/agent-host')
    expect(scopeFolderCandidate(WIN, '.')).toBe('c:/claude/workspace')
    expect(scopeFolderCandidate(WIN, '..\\elsewhere')).toBeUndefined()
    expect(topLevelFolder(WIN, 'C:\\claude\\workspace\\castra\\src\\a.ts')).toBe('c:/claude/workspace/castra')
    expect(describeScope({ root: WIN, folders: [`${WIN}/agent-host`, WIN] })).toBe('agent-host/, ./ (root files)')
    const denial = denialMessage({ target: 'c:/claude/workspace/castra/a.md', reason: 'edits a file outside the target folder' }, KNIGHT, 'edit')
    expect(denial).toContain('(castra/a.md)')
    expect(denial).toContain('/scope add castra')
  })

  test('shell commands with Windows and Git Bash paths', () => {
    expect(winKind("rm -rf 'C:\\claude\\workspace\\agent-host\\build'")).toBe('allow')
    expect(winKind('rm -rf C:/claude/workspace/agent-host/build')).toBe('allow')
    expect(winKind('rm -rf /c/claude/workspace/agent-host/build')).toBe('allow')
    expect(winKind('cd /c/claude/workspace/agent-host && rm -rf build')).toBe('allow')
    expect(winKind("cd 'C:\\claude\\workspace\\agent-host' && rm -rf build")).toBe('allow')
    expect(winKind('git -C /c/claude/workspace/agent-host commit -m wip')).toBe('allow')
    expect(winKind('npm install', IN_HOST)).toBe('allow')

    expect(winKind("rm -rf 'C:\\claude\\workspace\\castra\\build'")).toBe('block')
    expect(winKind('rm -rf c:/claude/workspace/castra/build')).toBe('block')
    expect(winKind('rm -rf /c/claude/workspace/castra/build')).toBe('block')
    expect(winKind('rm -rf /cygdrive/c/claude/workspace/castra/build')).toBe('block')
    expect(winKind('rm -rf /mnt/c/claude/workspace/castra/build')).toBe('block')
    expect(winKind("echo x > 'C:\\claude\\workspace\\castra\\a.txt'", IN_HOST)).toBe('block')
    expect(winKind('rm -rf "C:\\claude\\workspace\\castra"', IN_HOST)).toBe('block')
    expect(winKind('cd .. && rm -rf workspace/castra', KNIGHT)).toBe('block')
    expect(winKind("sed -i 's/a/b/' 'C:\\claude\\workspace\\castra\\a.txt'", IN_HOST)).toBe('block')
    expect(winKind("sed -i 's/a/b/' 'C:\\claude\\workspace\\agent-host\\a.txt'", IN_HOST)).toBe('allow')
    expect(winKind("rm -rf '..\\castra'", IN_HOST)).toBe('block')
    expect(winKind("cd 'C:\\claude\\workspace\\agent-host' && rm -rf ../castra")).toBe('block')
    expect(winKind("git -C 'C:\\claude\\workspace\\castra' commit -m wip")).toBe('block')
    expect(winKind('mkdir -p C:/claude/workspace/agent-host2/x')).toBe('block')
    expect(winKind("rm -rf '\\\\localhost\\c$\\claude\\workspace\\castra'", IN_HOST)).toBe('block')
    expect(winKind('cp a.txt //server/share/', IN_HOST)).toBe('block')
    expect(winKind("rm -rf 'C:\\CLAUDE~1\\workspace\\castra'", IN_HOST)).toBe('block')
    expect(winKind('rm -rf C:/claude/work*/castra', IN_HOST)).toBe('block')

    // Outside the root, or only reading: fine.
    expect(winKind('rm -rf D:/tmp/build', IN_HOST)).toBe('allow')
    expect(winKind('rm -rf /tmp/build', IN_HOST)).toBe('allow')
    expect(winKind("cat 'C:\\claude\\workspace\\castra\\README.md'", IN_HOST)).toBe('allow')
    expect(winKind('ls 2>&1 >/dev/null', IN_HOST)).toBe('allow')
    // A cd the guard cannot place leaves the folder unknown.
    expect(winKind("cd '\\\\server\\share' && rm -rf x", IN_HOST)).toBe('unclear')
  })

  test('home paths on Windows', () => {
    const withHome = { ...IN_HOST, home: '/c/claude' }
    expect(analyzeCommand('rm -rf ~/workspace/castra', withHome).kind).toBe('block')
    expect(analyzeCommand('rm -rf ~/workspace/agent-host/build', withHome).kind).toBe('allow')
    expect(analyzeCommand('rm -rf ~/x', { ...IN_HOST, home: 'C:\\Users\\me' }).kind).toBe('allow')
  })

  test('sibling-prefix folders in Git Bash form', () => {
    const orders = { root: 'C:\\work', cwd: 'C:\\work', folders: ['/c/work/orders'] }
    expect(editKind('/c/work/orders/a.md', orders)).toBe('allow')
    expect(editKind('/c/work/orders2/a.md', orders)).toBe('block')
    expect(winKind('touch /c/work/orders2/a.md', orders)).toBe('block')
    // And on POSIX, the same folders as they always were.
    const posix = { root: '/c', cwd: '/c', folders: ['/c/orders'] }
    expect(checkFileEdit('/c/orders/a.md', posix).kind).toBe('allow')
    expect(checkFileEdit('/c/orders2/a.md', posix).kind).toBe('block')
  })

  test('a UNC root compares its own UNC paths', () => {
    const share = { root: '\\\\nas\\work', cwd: '\\\\nas\\work', folders: ['\\\\nas\\work\\orders'] }
    expect(editKind('\\\\NAS\\Work\\orders\\a.md', share)).toBe('allow')
    expect(editKind('//nas/work/orders/a.md', share)).toBe('allow')
    expect(editKind('\\\\nas\\work\\orders2\\a.md', share)).toBe('block')
    expect(editKind('\\\\nas\\work\\orders\\..\\castra\\a.md', share)).toBe('block')
    expect(editKind('C:\\tmp\\a.md', share)).toBe('allow')
  })

  test('a Git Bash drive path that could also be a folder on the root drive is not let through', () => {
    // Root C:\c\work: /c/work/x is C:\work\x to Git Bash but C:\c\work\x to a file tool.
    const ambiguous = { root: 'C:\\c\\work', cwd: 'C:\\c\\work', folders: ['C:\\c\\work\\orders'] }
    expect(editKind('/c/work/other/a.md', ambiguous)).toBe('block')
    expect(editKind('C:\\c\\work\\orders\\a.md', ambiguous)).toBe('allow')
  })

  test('POSIX paths are unchanged: backslashes and drive-like names are ordinary characters', () => {
    expect(resolvePath('/dev/work/project', 'C:\\x')).toBe('/dev/work/project/C:\\x')
    expect(checkFileEdit('/dev/work/project/a\\..\\..\\other', AT_ROOT).kind).toBe('allow')
    expect(checkFileEdit('/dev/work/project/C:\\x', AT_ROOT).kind).toBe('allow')
  })
})
