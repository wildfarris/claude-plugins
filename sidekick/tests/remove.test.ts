// Tests for hooks/remove.ts, kept identical in sidekick and commons like the module itself.

import { describe, expect, test } from 'claude-code/testing'

import { canonicalPath } from '../hooks/paths'
import { MAX_REMOVE_ENTRIES, REMOVE_TARGET_VARIABLE, RemoveRefused, removeCommand, removeInside, type RemoveHost } from '../hooks/remove'

type Node = { kind: 'file' | 'dir' | 'other'; isLink?: boolean; realPath?: string }

// A disk in memory, keyed by canonical path, and the commands run on it.
function fakeHost(nodes: Record<string, Node>, options: { exitCode?: number; isDeleting?: boolean } = {}) {
  const disk = new Map(Object.entries(nodes).map(([path, node]) => [canonicalPath(path)!, node]))
  const ran: Array<{ argv: readonly string[]; env?: Record<string, string> }> = []
  const key = (path: string) => {
    const canonical = canonicalPath(path)
    if (canonical === undefined) throw new Error(`the fake disk can't place ${path}`)
    return canonical
  }
  const below = (folder: string) => [...disk.keys()].filter(path => path.startsWith(`${folder.replace(/\/$/, '')}/`))
  const host: RemoveHost = {
    exists: async path => disk.has(key(path)),
    stat: async (path, options) => {
      const node = disk.get(key(path))
      if (node === undefined) throw new Error(`ENOENT: ${path}`)
      return { kind: node.kind, size: 0, mtimeMs: 0, isLink: node.isLink ?? false, ...(options?.resolve ? { realPath: node.realPath ?? path } : {}) }
    },
    list: async path => {
      const folder = key(path)
      return below(folder)
        .filter(child => !child.slice(folder.length + 1).includes('/'))
        .map(child => {
          const node = disk.get(child)!
          return { name: child.split('/').pop()!, kind: node.isLink ? ('other' as const) : node.kind, size: 0, mtimeMs: 0, isLink: node.isLink ?? false }
        })
    },
    run: async (argv, init) => {
      ran.push({ argv, ...(init?.env ? { env: init.env } : {}) })
      const target = init?.env?.[REMOVE_TARGET_VARIABLE] ?? argv[argv.length - 1]!
      if (options.isDeleting !== false && (options.exitCode ?? 0) === 0) {
        const gone = key(target)
        for (const path of [gone, ...below(gone)]) disk.delete(path)
      }
      return { exitCode: options.exitCode ?? 0, stdout: '', stderr: options.exitCode ? 'Access is denied.\r\n' : '', isStdoutTruncated: false, isStderrTruncated: false }
    },
  }
  return { host, disk, ran }
}

const WIN_FOLDER = 'C:\\Users\\me\\.claude\\sidekick\\ledgers'
const WIN_HOME = 'C:\\Users\\me'
const winTree = (extra: Record<string, Node> = {}): Record<string, Node> => ({
  [WIN_HOME]: { kind: 'dir' },
  [WIN_FOLDER]: { kind: 'dir' },
  [`${WIN_FOLDER}\\old`]: { kind: 'dir' },
  [`${WIN_FOLDER}\\old\\0001.jsonl`]: { kind: 'file' },
  [`${WIN_FOLDER}\\keep`]: { kind: 'dir' },
  [`${WIN_FOLDER}\\keep\\0001.jsonl`]: { kind: 'file' },
  ...extra,
})

describe('removeInside', () => {
  test('on Windows: PowerShell deletes the resolved path, handed over in an environment variable', async () => {
    const { host, disk, ran } = fakeHost(winTree())
    expect(await removeInside(host, `${WIN_FOLDER}/old`, WIN_FOLDER, WIN_HOME)).toBe(true)
    expect(ran.length).toBe(1)
    expect(ran[0]!.argv[0]).toBe('powershell.exe')
    expect(ran[0]!.argv.join(' ')).not.toContain('old')
    expect(ran[0]!.env).toEqual({ [REMOVE_TARGET_VARIABLE]: `${WIN_FOLDER}\\old` })
    expect(disk.has('c:/Users/me/.claude/sidekick/ledgers/old/0001.jsonl')).toBe(false)
    expect(disk.has('c:/Users/me/.claude/sidekick/ledgers/keep/0001.jsonl')).toBe(true)
  })

  test('on POSIX: rm -rf -- on the resolved path', async () => {
    const { host, ran } = fakeHost({ '/home/me/l': { kind: 'dir' }, '/home/me/l/old': { kind: 'dir' }, '/home/me/l/old/a': { kind: 'file' } })
    expect(await removeInside(host, '/home/me/l/x/../old', '/home/me/l', '/home/me')).toBe(true)
    expect(ran).toEqual([{ argv: ['rm', '-rf', '--', '/home/me/l/old'] }])
    expect(removeCommand('/a/b')).toEqual({ argv: ['rm', '-rf', '--', '/a/b'] })
  })

  test('nothing there: nothing runs', async () => {
    const { host, ran } = fakeHost(winTree())
    expect(await removeInside(host, `${WIN_FOLDER}\\gone`, WIN_FOLDER, WIN_HOME)).toBe(false)
    expect(ran.length).toBe(0)
  })

  test('refused by spelling before anything is touched: outside, .., roots, the folder itself, home', async () => {
    const { host, ran } = fakeHost(winTree())
    for (const target of ['', WIN_FOLDER, `${WIN_FOLDER}\\..`, `${WIN_FOLDER}\\old\\..\\..\\..`, 'C:\\', WIN_HOME, 'D:\\x', '\\\\server\\share\\x', 'old']) {
      await expect(removeInside(host, target, WIN_FOLDER, WIN_HOME)).rejects.toThrow(RemoveRefused)
    }
    await expect(removeInside(host, 'C:\\x', 'C:\\', WIN_HOME)).rejects.toThrow(RemoveRefused)
    await expect(removeInside(host, '/x', '/')).rejects.toThrow(RemoveRefused)
    expect(ran.length).toBe(0)
  })

  test('refused on disk: a link, a junction inside, a target that lands outside, too many entries', async () => {
    const link = fakeHost(winTree({ [`${WIN_FOLDER}\\linked`]: { kind: 'dir', isLink: true, realPath: 'C:\\Windows' } }))
    await expect(removeInside(link.host, `${WIN_FOLDER}\\linked`, WIN_FOLDER, WIN_HOME)).rejects.toThrow('is a link')

    const junction = fakeHost(winTree({ [`${WIN_FOLDER}\\old\\junction`]: { kind: 'dir', isLink: true, realPath: 'C:\\Users\\me\\Documents' } }))
    await expect(removeInside(junction.host, `${WIN_FOLDER}\\old`, WIN_FOLDER, WIN_HOME)).rejects.toThrow('is a link or a special file')

    // A parent folder that is a link elsewhere: the target resolves outside the folder as it resolves.
    const elsewhere = fakeHost(winTree({ [`${WIN_FOLDER}\\moved`]: { kind: 'dir', realPath: 'D:\\elsewhere\\moved' } }))
    await expect(removeInside(elsewhere.host, `${WIN_FOLDER}\\moved`, WIN_FOLDER, WIN_HOME)).rejects.toThrow('lands outside')

    const many: Record<string, Node> = {}
    for (let index = 0; index <= MAX_REMOVE_ENTRIES; index++) many[`${WIN_FOLDER}\\old\\${index}.jsonl`] = { kind: 'file' }
    const big = fakeHost(winTree(many))
    await expect(removeInside(big.host, `${WIN_FOLDER}\\old`, WIN_FOLDER, WIN_HOME)).rejects.toThrow('more than')

    for (const fake of [link, junction, elsewhere, big]) expect(fake.ran.length).toBe(0)
  })

  test('a failed delete says why, and one that leaves the target behind is a failure', async () => {
    const denied = fakeHost(winTree(), { exitCode: 1 })
    await expect(removeInside(denied.host, `${WIN_FOLDER}\\old`, WIN_FOLDER, WIN_HOME)).rejects.toThrow('Access is denied.')
    const stuck = fakeHost(winTree(), { isDeleting: false })
    await expect(removeInside(stuck.host, `${WIN_FOLDER}\\old`, WIN_FOLDER, WIN_HOME)).rejects.toThrow('still there')
  })
})
