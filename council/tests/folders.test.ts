import { describe, expect, test } from 'claude-code/testing'

import { emptyCourt, isInside, newOrders, readProposal, relativeFolder } from '../hooks/court'
import { resolveReference } from '../hooks/members'
import { reviewFolderCandidate } from '../hooks/review'

const WIN = 'C:\\claude\\workspace'
const POSIX = '/dev/work'

describe('dispatch folders', () => {
  test('a Windows folder, relative or absolute in any spelling, becomes one relative to the root', () => {
    expect(relativeFolder(WIN, 'agent-host')).toBe('agent-host')
    expect(relativeFolder(WIN, '.\\agent-host\\')).toBe('agent-host')
    expect(relativeFolder(WIN, 'agent-host\\docs')).toBe('agent-host/docs')
    expect(relativeFolder(WIN, 'agent-host/docs/')).toBe('agent-host/docs')
    expect(relativeFolder(WIN, 'C:\\claude\\workspace\\agent-host')).toBe('agent-host')
    expect(relativeFolder(WIN, 'c:/claude/workspace/agent-host/')).toBe('agent-host')
    expect(relativeFolder(WIN, 'C:\\claude/workspace\\castra\\src')).toBe('castra/src')
  })

  test('a Windows folder that leaves the root, or is it, or can\'t be placed, is refused', () => {
    for (const folder of [
      '',
      '.',
      '..\\castra',
      'agent-host\\..\\..\\x',
      'agent-host\\..',
      '..',
      'C:\\claude\\workspace',
      'C:\\claude\\workspace\\',
      'C:\\claude\\workspace\\..\\other',
      'C:\\claude\\workspace2\\x',
      'D:\\claude\\workspace\\agent-host',
      'C:agent-host',
      '\\agent-host',
      '\\\\server\\share\\agent-host',
      '~\\agent-host',
      'agent-host.',
      'agent-host\\x:stream',
    ]) {
      expect([folder, relativeFolder(WIN, folder)]).toEqual([folder, undefined])
    }
  })

  test('POSIX folders keep their rules: backslashes are ordinary characters', () => {
    expect(relativeFolder(POSIX, 'api')).toBe('api')
    expect(relativeFolder(POSIX, './api/')).toBe('api')
    expect(relativeFolder(POSIX, '/dev/work/api')).toBe('api')
    expect(relativeFolder(POSIX, 'a\\b')).toBe('a\\b')
    for (const folder of ['', '..', '../x', 'api/../..', '/dev/work', '/dev/other/api', '/dev/work2/api', 'a//b']) {
      expect([folder, relativeFolder(POSIX, folder)]).toEqual([folder, undefined])
    }
  })

  test("orders get their folder in the root's own separators, and the knight check holds on it", () => {
    const proposal = readProposal({ plan: 'p', dispatches: [{ folder: 'agent-host\\docs', role: 'knight', task: 't', todos: ['x'] }] }, WIN)
    if ('error' in proposal) throw new Error(proposal.error)
    const [order] = newOrders(emptyCourt(), proposal, WIN, [])
    expect(order!.folder).toBe('C:\\claude\\workspace\\agent-host\\docs')
    expect(order!.relFolder).toBe('agent-host/docs')
    expect(isInside(order!, 'C:\\claude\\workspace\\agent-host\\docs\\a.md')).toBe(true)
    expect(isInside(order!, 'C:\\claude\\workspace\\agent-host\\a.md')).toBe(false)
    const posix = readProposal({ plan: 'p', dispatches: [{ folder: 'api', role: 'scout', task: 't', todos: ['x'] }] }, POSIX)
    if ('error' in posix) throw new Error(posix.error)
    expect(newOrders(emptyCourt(), posix, POSIX, [])[0]!.folder).toBe('/dev/work/api')
  })
})

describe('review folders', () => {
  test('relative names land under the root in its separators; absolute ones in any spelling are kept', () => {
    expect(reviewFolderCandidate(WIN, 'web')).toBe('C:\\claude\\workspace\\web')
    expect(reviewFolderCandidate(WIN, '.\\web\\')).toBe('C:\\claude\\workspace\\web')
    expect(reviewFolderCandidate(WIN, 'C:\\other\\repo\\')).toBe('C:\\other\\repo')
    expect(reviewFolderCandidate(WIN, 'D:/repo/')).toBe('D:/repo')
    expect(reviewFolderCandidate(POSIX, 'web/')).toBe('/dev/work/web')
    expect(reviewFolderCandidate(POSIX, './web')).toBe('/dev/work/web')
    expect(reviewFolderCandidate(POSIX, '/srv/repo/')).toBe('/srv/repo')
  })
})

describe('member references on Windows', () => {
  const MEMBERS = 'C:\\Users\\me/.claude/council/members'
  const HOME = 'C:\\Users\\me'

  test('drive paths, ~/ and ~\\, backslashes and .. resolve to native paths', () => {
    expect(resolveReference('./retention.md', MEMBERS, HOME)).toBe('C:\\Users\\me\\.claude\\council\\members\\retention.md')
    expect(resolveReference('..\\policies\\b.md', MEMBERS, HOME)).toBe('C:\\Users\\me\\.claude\\council\\policies\\b.md')
    expect(resolveReference('C:\\docs\\a.md', MEMBERS, HOME)).toBe('C:\\docs\\a.md')
    expect(resolveReference('d:/docs/a.md', MEMBERS, HOME)).toBe('D:\\docs\\a.md')
    expect(resolveReference('~/c.md', MEMBERS, HOME)).toBe('C:\\Users\\me\\c.md')
    expect(resolveReference('~\\c.md', MEMBERS, HOME)).toBe('C:\\Users\\me\\c.md')
    expect(resolveReference('\\\\nas\\share\\a.md', MEMBERS, HOME)).toBe('\\\\nas\\share\\a.md')
  })

  test("what can't be placed is refused", () => {
    for (const path of ['$HOME\\c.md', '~other\\c.md', '~', 'C:docs\\a.md', '\\docs\\a.md', '/docs/a.md']) {
      expect([path, resolveReference(path, MEMBERS, HOME)]).toEqual([path, undefined])
    }
  })

  test('POSIX references are unchanged', () => {
    expect(resolveReference('/etc/policy.md', '/home/me/.claude/council/members', '/home/me')).toBe('/etc/policy.md')
    expect(resolveReference('~/c.md', '/x', '/home/me')).toBe('/home/me/c.md')
    expect(resolveReference('~\\c.md', '/x', '/home/me')).toBeUndefined()
  })
})
