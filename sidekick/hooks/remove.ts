// Deleting a file or a folder and everything in it, on POSIX and Windows. The
// engine's fs noun has no delete, so this runs a command ($.process.run spawns
// without a shell): `rm -rf` on POSIX, PowerShell's Remove-Item on Windows,
// with the path handed over in an environment variable so no character in it
// is ever read as syntax.
//
// Kept identical in sidekick and commons (hooks/remove.ts), like paths.ts.
//
// Before anything runs, the target must be safely inside its folder:
// - by spelling (paths.ts deleteTarget): absolute, strictly inside the folder
//   after `..` is resolved, never a root, a drive or share root, the home
//   folder or a folder holding it; what is deleted is that resolved spelling;
// - on disk: the target is not itself a link, it lands inside the folder as
//   the folder itself lands (both resolved), and no link (or junction, or other
//   special entry) is anywhere inside it, which Windows PowerShell's recursive
//   delete could follow out of the folder.
// What remains is the moment between the checks and the delete.

import type { FsEntry, FsStat, FsStatOptions, ProcessRunInit, ProcessRunResult } from 'claude-code'

import { deleteTarget, pathStyleOf } from './paths'

// The engine calls this uses, as closures over the plugin's `$` (the engine
// follows `$` into no other file): `$.fs.stat`, `$.fs.list`, `$.fs.exists`
// and `$.process.run`.
export type RemoveHost = {
  stat: (path: string, options?: FsStatOptions) => Promise<FsStat>
  list: (path: string) => Promise<FsEntry[]>
  exists: (path: string) => Promise<boolean>
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
}

// More entries than this inside a target and it is refused rather than walked.
export const MAX_REMOVE_ENTRIES = 5000

export const REMOVE_TARGET_VARIABLE = 'PLUGIN_REMOVE_TARGET'

export class RemoveRefused extends Error {}

// The command that deletes `path` (already checked and in its platform's own
// spelling), and the environment it needs.
export function removeCommand(path: string): { argv: string[]; env?: Record<string, string> } {
  if (pathStyleOf(path) === 'posix') return { argv: ['rm', '-rf', '--', path] }
  return {
    argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Remove-Item -LiteralPath $env:${REMOVE_TARGET_VARIABLE} -Recurse -Force -ErrorAction Stop`],
    env: { [REMOVE_TARGET_VARIABLE]: path },
  }
}

const join = (folder: string, name: string) => `${folder.replace(/[\\/]+$/, '')}${pathStyleOf(folder) === 'windows' ? '\\' : '/'}${name}`

// Refuses when any entry below `folder` is a link or anything but a file or a
// folder, or when there are too many to check.
async function checkNoLinks(host: RemoveHost, folder: string, budget: { left: number }): Promise<void> {
  for (const entry of await host.list(folder)) {
    if (--budget.left < 0) throw new RemoveRefused(`more than ${MAX_REMOVE_ENTRIES} entries to check`)
    if (entry.isLink || entry.kind === 'other') throw new RemoveRefused(`${join(folder, entry.name)} is a link or a special file`)
    if (entry.kind === 'dir') await checkNoLinks(host, join(folder, entry.name), budget)
  }
}

// Deletes `target` inside `folder`. Resolves false when there was nothing to
// delete, true once it is gone; rejects with RemoveRefused when a check
// refuses it, or an Error when the delete failed.
export async function removeInside(host: RemoveHost, target: string, folder: string, home?: string): Promise<boolean> {
  const placed = deleteTarget(target, folder, home)
  if ('refusal' in placed) throw new RemoveRefused(placed.refusal)
  const path = placed.path
  if (!(await host.exists(path))) return false
  const own = await host.stat(path, { resolve: true })
  if (own.isLink) throw new RemoveRefused(`${path} is a link`)
  const realFolder = (await host.stat(folder, { resolve: true }).catch(() => undefined))?.realPath
  if (own.realPath === undefined || realFolder === undefined) throw new RemoveRefused(`${path} cannot be resolved on disk`)
  const real = deleteTarget(own.realPath, realFolder, home)
  if ('refusal' in real) throw new RemoveRefused(`${path} lands outside ${folder} on disk (${real.refusal})`)
  if (own.kind === 'dir') await checkNoLinks(host, path, { left: MAX_REMOVE_ENTRIES })
  else if (own.kind !== 'file') throw new RemoveRefused(`${path} is not a file or a folder`)
  const { argv, env } = removeCommand(path)
  const result = await host.run(argv, { timeoutMs: 15000, ...(env ? { env } : {}) })
  if (result.exitCode !== 0) throw new Error(`could not delete ${path}: ${result.stderr.trim().split('\n')[0] || `exit code ${result.exitCode}`}`)
  if (await host.exists(path)) throw new Error(`${path} is still there after the delete`)
  return true
}
