// Stands in for the engine beneath the plugin: the session, the clock, the UI
// calls, the prompt box, and a small in-memory file system for the memory
// folder (fs.read/write/list, and `rm -rf` through process.run), with HOME set.

import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const HOME = '/home/me'
export const FOLDER = `${HOME}/.claude/commons`
export const presentation = { isFullscreen: false, columns: 140 }
export const composer = (command: string, args: string) => ({ command, args, origin: { kind: 'composer' as const }, presentation })

export type Harness = {
  files: Map<string, string>
  toasts: string[]
  filled: string[]
  draft: { text: string }
  removed: string[]
  opened: string[]
  // The session root; a test changes it to look from another project.
  root: string
}

export function standIn(on: On, options: { root: string; files?: Map<string, string> }): Harness {
  const harness: Harness = { files: options.files ?? new Map(), toasts: [], filled: [], draft: { text: '' }, removed: [], opened: [], root: options.root }
  const { files } = harness
  mock.clock(on, { now: Date.UTC(2026, 9, 8, 12, 0, 0) })
  mock.env(on, { HOME })
  on('session.root', () => ({ value: harness.root }))
  on('session.cwd', () => ({ value: harness.root }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.run', () => ({ text: '' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__commons__${e.name}` } }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('tool.call', () => ({ deny: 'no such tool' }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('ui.toast', ($, e) => {
    harness.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    harness.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('prompt.read', () => ({ value: { text: harness.draft.text, cursor: harness.draft.text.length } }))
  on('prompt.fill', ($, e) => {
    harness.filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path)! } : { deny: 'no such file' }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const prefix = `${e.path.replace(/\/$/, '')}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue
      const [head, ...rest] = path.slice(prefix.length).split('/')
      names.set(head!, rest.length > 0 ? 'dir' : 'file')
    }
    if (names.size === 0) return { deny: 'no such directory' }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  // What a delete checks first: whether the path is there, what it is and where it lands.
  const isFolder = (path: string) => [...files.keys()].some(key => key.startsWith(`${path.replace(/\/$/, '')}/`))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || isFolder(e.path) }))
  on('fs.stat', ($, e) => {
    const kind = files.has(e.path) ? ('file' as const) : isFolder(e.path) ? ('dir' as const) : undefined
    if (kind === undefined) return { deny: 'no such file' }
    return { value: { kind, size: files.get(e.path)?.length ?? 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'rm') {
      const target = argv[argv.length - 1]!
      harness.removed.push(target)
      for (const path of [...files.keys()]) if (path === target || path.startsWith(`${target}/`)) files.delete(path)
      return out('')
    }
    return out('', 1)
  })
  return harness
}
