// The path rules' backstop: when a council order's agent stops, what changed in
// its repo since it started is read from git and matched against the rules,
// so a forbidden change the file-tool and Bash layers missed (a script, a
// build tool, `xargs`, `find -exec`) is still named. Pure: the caller runs
// git and keeps the baseline.
//
// The baseline, taken at the agent's first tool call: the repo's top folder,
// HEAD, and the paths already changed then that a rule matches, each with its
// content hash, so changes that predate the order are not blamed on it. At the
// stop: `git diff --name-status --no-renames -z <start>` (tracked changes since
// the start, committed or not) plus `git ls-files --others --exclude-standard
// -z` (new files). Ignored files are not seen.

import { hitText, matchPathRules, type ActivePathRule, type PathOp, type PathRuleHit } from './scope-rules'

export const BACKSTOP_MARK = '[sidekick backstop]'
// Baselines left by agents that never stopped are pruned after this long.
export const BACKSTOP_RETENTION_MS = 7 * 24 * 3600 * 1000

export type Change = { path: string; op: PathOp }

export type Baseline = {
  orderId: string
  // The order's folder, for the warning.
  folder: string
  // The repo's top folder, as git prints it; change paths are relative to it.
  top: string
  // HEAD when the agent started.
  start: string
  rules: ActivePathRule[]
  // Paths already changed at the start that a rule matches: their content
  // hash then ('' for a deleted file).
  dirty: Record<string, string>
  startedAt: number
}

// `git status --porcelain=v1 -z --untracked-files=all`: `XY path`, and for a
// rename or copy the origin path in the next field.
export function parseStatus(text: string): Change[] {
  const fields = text.split('\0')
  const changes: Change[] = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (field.length < 4) continue
    const code = field.slice(0, 2)
    const path = field.slice(3)
    if (code === '??') changes.push({ path, op: 'create' })
    else if (code.includes('R') || code.includes('C')) {
      changes.push({ path, op: 'create' })
      const origin = fields[++index]
      if (code.includes('R') && origin) changes.push({ path: origin, op: 'delete' })
    } else if (code.includes('D')) changes.push({ path, op: 'delete' })
    else if (code.includes('A')) changes.push({ path, op: 'create' })
    else changes.push({ path, op: 'edit' })
  }
  return changes
}

// `git diff --name-status --no-renames -z <start>`: a status letter, then the path.
export function parseNameStatus(text: string): Change[] {
  const fields = text.split('\0')
  const changes: Change[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const letter = fields[index]!.charAt(0)
    const path = fields[index + 1]!
    if (letter === '' || path === '') continue
    changes.push({ path, op: letter === 'A' ? 'create' : letter === 'D' ? 'delete' : 'edit' })
  }
  return changes
}

// What changed since the start: tracked changes and new files, once each.
export function changesSince(tracked: readonly Change[], untracked: readonly string[]): Change[] {
  const byPath = new Map<string, Change>()
  for (const change of tracked) byPath.set(change.path, change)
  for (const path of untracked) if (!byPath.has(path)) byPath.set(path, { path, op: 'create' })
  return [...byPath.values()]
}

export const joinTop = (top: string, path: string) => `${top.replace(/[\\/]+$/, '')}/${path}`

// The changes a rule forbids: path (relative to the top) and the hits.
export type Flagged = { path: string; hits: PathRuleHit[] }

export function flaggedChanges(changes: readonly Change[], top: string, rules: readonly ActivePathRule[]): Flagged[] {
  return changes.flatMap(change => {
    const hits = matchPathRules(joinTop(top, change.path), [change.op], rules)
    return hits.length > 0 ? [{ path: change.path, hits }] : []
  })
}

// The order's own changes among the flagged: one already changed at the start
// and untouched since (same hash, or still gone) is not the order's; one it
// changed again is judged by what the order did to it (an edit of a file that
// was there, a create of one that wasn't, a delete).
export function newSinceStart(flagged: readonly Flagged[], dirty: Readonly<Record<string, string>>, hashNow: Readonly<Record<string, string>>, top: string, rules: readonly ActivePathRule[]): Flagged[] {
  return flagged.flatMap(entry => {
    if (!(entry.path in dirty)) return [entry]
    const before = dirty[entry.path]!
    const after = hashNow[entry.path] ?? ''
    if (before === after) return []
    const op: PathOp = before === '' ? 'create' : after === '' ? 'delete' : 'edit'
    const hits = matchPathRules(joinTop(top, entry.path), [op], rules)
    return hits.length > 0 ? [{ path: entry.path, hits }] : []
  })
}

// The paths of a status that any rule matches (by any operation): the ones
// whose state the baseline records.
export function dirtyMatches(changes: readonly Change[], top: string, rules: readonly ActivePathRule[]): Change[] {
  return changes.filter(change => matchPathRules(joinTop(top, change.path), ['create', 'edit', 'delete'], rules).length > 0)
}

// The warning the main session reads (appended to the agent's report) when an
// order stopped with forbidden changes: each file, its rule, its source, and
// that the backstop (not the file-tool or Bash layer) found it.
export function backstopWarning(baseline: Pick<Baseline, 'orderId' | 'folder'>, flagged: readonly Flagged[]): string | undefined {
  if (flagged.length === 0) return undefined
  const lines = flagged.slice(0, 20).flatMap(entry => entry.hits.map(hit => `- ${hitText(hit)}`))
  return [
    `${BACKSTOP_MARK} Order ${baseline.orderId} (${baseline.folder}) stopped with ${flagged.length === 1 ? 'a change' : `${flagged.length} changes`} its path rules forbid. The stop backstop found ${flagged.length === 1 ? 'it' : 'them'} in git; the file-tool and Bash layers did not see ${flagged.length === 1 ? 'it' : 'them'} (an indirect write such as a script, a build tool, xargs or find -exec):`,
    ...lines,
    ...(flagged.length > 20 ? [`- and ${flagged.length - 20} more`] : []),
    'These paths are protected in this order. Review the changes (in the working tree or its commits) before they are merged, and ask the agent why if it did not report it.',
  ].join('\n')
}

// A short toast for the person.
export function backstopToast(orderId: string, flagged: readonly Flagged[]): string {
  const names = flagged.slice(0, 3).map(entry => entry.path).join(', ')
  return `Path rules backstop: ${orderId} changed ${flagged.length} protected path${flagged.length === 1 ? '' : 's'} (${names}${flagged.length > 3 ? ', …' : ''}); see its report.`
}

export function isBaseline(value: unknown): value is Baseline {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.orderId === 'string' && typeof entry.folder === 'string' && typeof entry.top === 'string' && typeof entry.start === 'string' && Array.isArray(entry.rules) && typeof entry.dirty === 'object' && entry.dirty !== null
}
