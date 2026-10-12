import type { PluginOptions } from 'claude-code'

import { nativePath, parseAbsolute, pathStyleOf } from './paths'

export type CommonsSettings = {
  // Empty: ~/.claude/commons.
  memoryDir: string
  contextLimit: number
}

// The engine validates options against plugin.json's userConfig and fills in
// defaults; this re-checks so a test or a hand-edited settings file can't
// hand the hooks an out-of-range value.
export function readSettings(options: PluginOptions): CommonsSettings {
  const limit = options.contextLimit
  return {
    memoryDir: typeof options.memoryDir === 'string' ? options.memoryDir.trim() : '',
    contextLimit: typeof limit === 'number' && Number.isFinite(limit) ? Math.min(30000, Math.max(1000, Math.round(limit))) : 6000,
  }
}

// The memory folder: the setting with a leading ~ expanded, or ~/.claude/commons.
// Must be absolute (a relative one would land inside each session's repo):
// /x, or on Windows C:\x, C:/x or \\server\share\x (~\ works there too),
// with no . or .. parts. A Windows folder comes back in its own spelling
// (C:\x); a POSIX one with repeated and trailing slashes dropped.
export function memoryFolder(setting: string, home: string): string {
  const isWindowsHome = pathStyleOf(home) === 'windows'
  const isHomeRelative = setting.startsWith('~/') || (isWindowsHome && setting.startsWith('~\\'))
  const expanded = setting === '' ? `${home}/.claude/commons` : setting === '~' ? home : isHomeRelative ? `${home}/${setting.slice(2)}` : setting
  const style = pathStyleOf(expanded)
  if (expanded.split(style === 'windows' ? /[\\/]/ : '/').some(part => part === '.' || part === '..')) throw new Error(`memoryDir must not contain . or .. (got "${setting}")`)
  const parsed = parseAbsolute(expanded, style)
  if (parsed === undefined) throw new Error(`memoryDir must be an absolute path or start with ~/ (got "${setting}")`)
  return nativePath(parsed)
}
