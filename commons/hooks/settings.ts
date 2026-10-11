import type { PluginOptions } from 'claude-code'

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
// Must be absolute (a relative one would land inside each session's repo),
// with no . or .. parts.
export function memoryFolder(setting: string, home: string): string {
  const expanded = setting === '' ? `${home}/.claude/commons` : setting === '~' ? home : setting.startsWith('~/') ? `${home}/${setting.slice(2)}` : setting
  const folder = expanded.replace(/\/+$/, '').replace(/\/{2,}/g, '/')
  if (!folder.startsWith('/')) throw new Error(`memoryDir must be an absolute path or start with ~/ (got "${setting}")`)
  if (folder.split('/').some(part => part === '.' || part === '..')) throw new Error(`memoryDir must not contain . or .. (got "${setting}")`)
  return folder
}
