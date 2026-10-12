// Tests for hooks/paths.ts, kept identical in sidekick, council and commons like the module itself.

import { describe, expect, test } from 'claude-code/testing'

import { canonicalPath, deleteTarget, fromBashDrivePath, homeFromEnvironment, isPathInside, joinUnder, nativePath, relativeToRoot } from '../hooks/paths'

describe('path helpers', () => {
  test('canonical forms', () => {
    expect(canonicalPath('C:\\a\\b\\..\\c')).toBe('c:/a/c')
    expect(canonicalPath('c:/')).toBe('c:/')
    expect(canonicalPath('\\\\?\\D:\\x')).toBe('d:/x')
    expect(canonicalPath('\\\\?\\UNC\\srv\\Share\\x')).toBe('//srv/share/x')
    expect(canonicalPath('/a/./b/../c')).toBe('/a/c')
    expect(canonicalPath('/..')).toBe('/')
    expect(canonicalPath('C:')).toBeUndefined()
    expect(canonicalPath('C:x')).toBeUndefined()
    expect(canonicalPath('a/b')).toBeUndefined()
  })

  test('isPathInside is false whenever either side cannot be placed', () => {
    expect(isPathInside('C:\\a\\b', 'C:\\a')).toBe(true)
    expect(isPathInside('C:\\a\\b', 'a')).toBe(false)
    expect(isPathInside('C:\\a\\b', 'C:a')).toBe(false)
  })

  test('relative paths under a root, and joins in the root\'s own separator', () => {
    expect(relativeToRoot('C:\\ws', 'c:/WS/api/x')).toBe('api/x')
    expect(relativeToRoot('C:\\ws', 'C:\\ws')).toBe('')
    expect(relativeToRoot('C:\\ws', 'C:\\other')).toBeUndefined()
    expect(relativeToRoot('/ws', '/ws/api/../web')).toBe('web')
    expect(joinUnder('C:\\ws', 'api/v1')).toBe('C:\\ws\\api\\v1')
    expect(joinUnder('C:\\ws\\', 'api')).toBe('C:\\ws\\api')
    expect(joinUnder('C:/ws', 'api')).toBe('C:/ws/api')
    expect(joinUnder('/ws', 'api/v1')).toBe('/ws/api/v1')
  })

  test('the home folder: HOME, else USERPROFILE; a Git Bash HOME on Windows becomes a drive path', () => {
    expect(homeFromEnvironment('/home/me', undefined)).toBe('/home/me')
    expect(homeFromEnvironment('/c', undefined)).toBe('/c')
    expect(homeFromEnvironment(undefined, 'C:\\Users\\me')).toBe('C:\\Users\\me')
    expect(homeFromEnvironment('  ', 'C:\\Users\\me')).toBe('C:\\Users\\me')
    expect(homeFromEnvironment('C:\\Users\\me', 'C:\\Users\\other')).toBe('C:\\Users\\me')
    expect(homeFromEnvironment('/c/Users/me', 'C:\\Users\\me')).toBe('C:/Users/me')
    expect(homeFromEnvironment(undefined, undefined)).toBeUndefined()
    expect(homeFromEnvironment('', '')).toBeUndefined()
  })

  test('a delete target must be strictly inside its folder, never a root or the home folder', () => {
    const ledgers = 'C:\\Users\\me\\.claude\\sidekick\\ledgers'
    const home = 'C:\\Users\\me'
    expect(deleteTarget(`${ledgers}/old-session`, ledgers, home)).toEqual({ path: 'C:\\Users\\me\\.claude\\sidekick\\ledgers\\old-session' })
    expect(deleteTarget('c:/users/me/.claude/sidekick/ledgers/x/../y', 'c:/users/me/.claude/sidekick/ledgers', home)).toEqual({ path: 'C:\\users\\me\\.claude\\sidekick\\ledgers\\y' })
    expect(deleteTarget('/home/me/.claude/commons/topics/scratch', '/home/me/.claude/commons/topics', '/home/me')).toEqual({ path: '/home/me/.claude/commons/topics/scratch' })
    const refused = (target: string, folder = ledgers) => 'refusal' in deleteTarget(target, folder, home)
    for (const target of [
      '',
      '   ',
      ledgers,
      `${ledgers}\\`,
      `${ledgers}\\..`,
      `${ledgers}\\x\\..\\..\\castra`,
      `${ledgers}\\..\\..\\..`,
      'C:\\Users\\me\\.claude\\sidekick\\ledgers2\\x',
      'C:\\',
      'C:\\Users\\me',
      'C:\\Users',
      'D:\\Users\\me\\.claude\\sidekick\\ledgers\\x',
      'C:Users\\me\\.claude\\sidekick\\ledgers\\x',
      '\\\\server\\share\\x',
      '\\\\?\\GLOBALROOT\\x',
      '/c/Users/me/.claude/sidekick/ledgers/x',
      'old-session',
      `${ledgers}\\x.`,
    ]) {
      expect([target, refused(target)]).toEqual([target, true])
    }
    // The folder's own names compare exactly: another case is refused, not guessed.
    expect(refused('C:\\users\\ME\\.claude\\sidekick\\ledgers\\x')).toBe(true)
    // A root, drive root or share root is never a folder to delete from.
    expect(refused('/x', '/')).toBe(true)
    expect(refused('C:\\x', 'C:\\')).toBe(true)
    expect(refused('\\\\nas\\share\\x', '\\\\nas\\share')).toBe(true)
    expect(refused('/home/me', '/home')).toBe(false)
    expect('refusal' in deleteTarget('/home/me', '/home', '/home/me')).toBe(true)
    expect('refusal' in deleteTarget('/home/me/a', '/home/me', '/home/me/a/b')).toBe(true)
    // POSIX: backslashes are ordinary characters.
    expect(deleteTarget('/srv/data/a\\..\\..', '/srv/data')).toEqual({ path: '/srv/data/a\\..\\..' })
  })

  test('native spellings', () => {
    expect(nativePath({ prefix: 'c:', segments: ['a', 'b'] })).toBe('C:\\a\\b')
    expect(nativePath({ prefix: '//nas/share', segments: ['a'] })).toBe('\\\\nas\\share\\a')
    expect(nativePath({ prefix: '', segments: ['a', 'b'] })).toBe('/a/b')
  })

  test('Git Bash drive paths become drive paths; others are left alone', () => {
    expect(fromBashDrivePath('/c/Users/me')).toBe('C:/Users/me')
    expect(fromBashDrivePath('/cygdrive/d/x')).toBe('D:/x')
    expect(fromBashDrivePath('/mnt/c/Users/me')).toBe('C:/Users/me')
    expect(fromBashDrivePath('/c')).toBe('C:/')
    expect(fromBashDrivePath('/home/me')).toBe('/home/me')
    expect(fromBashDrivePath('C:\\Users\\me')).toBe('C:\\Users\\me')
  })
})
