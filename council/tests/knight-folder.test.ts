import { describe, expect, test } from 'claude-code/testing'

import { isInside } from '../hooks/court'

describe("a knight's folder check", () => {
  // The order's folder as newOrders wrote it before: the root, then a forward slash.
  const WIN = { folder: 'C:\\claude\\workspace/agent-host', relFolder: 'agent-host' }
  const POSIX = { folder: '/home/me/work/agent-host', relFolder: 'agent-host' }

  test('a path inside the folder passes, however it is spelled', () => {
    for (const path of [
      'C:\\claude\\workspace\\agent-host\\docs\\build-prompt.md',
      'C:/claude/workspace/agent-host/docs/build-prompt.md',
      'c:\\claude\\workspace\\agent-host\\docs\\build-prompt.md',
      'C:\\Claude\\WORKSPACE\\agent-host\\a.md',
      'C:\\claude/workspace\\agent-host/docs\\build-prompt.md',
      'C:\\claude\\\\workspace\\.\\agent-host\\docs\\build-prompt.md',
      '\\\\?\\C:\\claude\\workspace\\agent-host\\docs\\a.md',
      '\\\\.\\C:\\claude\\workspace\\agent-host\\docs\\a.md',
      'C:\\claude\\workspace\\agent-host\\docs\\..\\README.md',
      'C:\\claude\\workspace\\agent-host',
    ]) {
      expect([path, isInside(WIN, path)]).toEqual([path, true])
    }
  })

  test('anything else is refused: siblings, .. escapes, other drives, UNC, relative and unplaceable paths', () => {
    for (const path of [
      'C:\\claude\\workspace\\castra\\README.md',
      'C:\\claude\\workspace\\CLAUDE.md',
      // A sibling whose name starts with the order folder's.
      'C:\\claude\\workspace\\agent-host2\\a.md',
      'C:\\claude\\workspace\\agent-host-old\\a.md',
      // The order's own folder in another case could be another folder.
      'C:\\claude\\workspace\\Agent-Host\\a.md',
      // .. climbing out, or past the drive's root and back in elsewhere.
      'C:\\claude\\workspace\\agent-host\\..\\castra\\a.md',
      'C:\\claude\\workspace\\agent-host\\docs\\..\\..\\castra\\a.md',
      'C:\\..\\..\\claude\\workspace\\castra\\a.md',
      '\\\\?\\C:\\claude\\workspace\\castra\\a.md',
      // Before the fix these were prefixed with the order folder and passed.
      'D:\\claude\\workspace\\agent-host\\a.md',
      'D:\\evil.md',
      '../../castra/a.md',
      '..\\..\\castra\\a.md',
      'docs/a.md',
      // UNC and device paths, even to the same drive.
      '\\\\server\\share\\claude\\workspace\\agent-host\\a.md',
      '\\\\localhost\\c$\\claude\\workspace\\agent-host\\a.md',
      '\\\\?\\UNC\\server\\share\\agent-host\\a.md',
      '\\\\.\\pipe\\agent-host',
      '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\a.md',
      // Drive-relative, drive-less and Git Bash spellings can't be placed with certainty.
      'C:claude\\workspace\\agent-host\\a.md',
      '\\claude\\workspace\\agent-host\\a.md',
      '/c/claude/workspace/agent-host/a.md',
      // Names Windows reads differently from how they are spelled.
      'C:\\claude\\workspace\\agent-host.\\a.md',
      'C:\\claude\\workspace\\agent-host\\a.md:stream',
      '~/a.md',
      '',
    ]) {
      expect([path, isInside(WIN, path)]).toEqual([path, false])
    }
  })

  test('POSIX paths are unchanged: .. is resolved, backslashes are ordinary characters, case matters', () => {
    expect(isInside(POSIX, '/home/me/work/agent-host/src/a.ts')).toBe(true)
    expect(isInside(POSIX, '/home/me/work/agent-host/src/../a.ts')).toBe(true)
    expect(isInside(POSIX, '/home/me/work/agent-host//a.ts')).toBe(true)
    expect(isInside(POSIX, '/home/me/work/agent-host/a\\..\\..\\b.ts')).toBe(true)
    expect(isInside(POSIX, '/home/me/work/agent-host/../castra/a.ts')).toBe(false)
    expect(isInside(POSIX, '/home/me/work/agent-host2/a.ts')).toBe(false)
    expect(isInside(POSIX, '/home/me/work/Agent-Host/a.ts')).toBe(false)
    expect(isInside(POSIX, '/HOME/me/work/agent-host/a.ts')).toBe(false)
    expect(isInside(POSIX, '../../etc/passwd')).toBe(false)
    expect(isInside(POSIX, 'src/a.ts')).toBe(false)
    expect(isInside(POSIX, 'C:\\home\\me\\work\\agent-host\\a.ts')).toBe(false)
  })

  test('a UNC root compares its own UNC paths', () => {
    const share = { folder: '\\\\nas\\code\\workspace\\agent-host', relFolder: 'agent-host' }
    expect(isInside(share, '\\\\NAS\\Code\\workspace\\agent-host\\a.md')).toBe(true)
    expect(isInside(share, '//nas/code/workspace/agent-host/a.md')).toBe(true)
    expect(isInside(share, '\\\\nas\\code\\workspace\\castra\\a.md')).toBe(false)
    expect(isInside(share, 'C:\\workspace\\agent-host\\a.md')).toBe(false)
  })
})
