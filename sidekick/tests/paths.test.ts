// Tests for hooks/paths.ts, kept identical in sidekick, council and commons like the module itself.

import { describe, expect, test } from 'claude-code/testing'

import { canonicalPath, fromBashDrivePath, homeFromEnvironment, isPathInside, joinUnder, relativeToRoot } from '../hooks/paths'

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

  test('Git Bash drive paths become drive paths; others are left alone', () => {
    expect(fromBashDrivePath('/c/Users/me')).toBe('C:/Users/me')
    expect(fromBashDrivePath('/cygdrive/d/x')).toBe('D:/x')
    expect(fromBashDrivePath('/mnt/c/Users/me')).toBe('C:/Users/me')
    expect(fromBashDrivePath('/c')).toBe('C:/')
    expect(fromBashDrivePath('/home/me')).toBe('/home/me')
    expect(fromBashDrivePath('C:\\Users\\me')).toBe('C:\\Users\\me')
  })
})
