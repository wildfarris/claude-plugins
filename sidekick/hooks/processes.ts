// The process snapshot the policy judge reads beside a command that stops or
// signals processes: the session's own process tree, and every process the
// command names, marked inside or outside that tree. Pure; register.tsx runs
// the one query.
//
// Windows: one Get-CimInstance Win32_Process query through powershell.exe,
// printed as JSON with each command line cut to 200 characters. Linux and
// macOS: one `ps` (which reads /proc on Linux). The query's own process is
// the hook host's child, so its parent (or the nearest claude ancestor) is
// the session's process; the tree is everything descended from it.

export type SnapshotProcess = { pid: number; ppid: number; name: string; started: string; commandLine: string }
export type ProcessSnapshot = { sessionPid: number | undefined; processes: SnapshotProcess[] }

export const COMMAND_LINE_LIMIT = 200

// The query, and what it prints.
export const WINDOWS_SNAPSHOT_ARGV: readonly string[] = [
  'powershell.exe',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  "$p = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,CommandLine; " +
    "@{ self = $PID; procs = @($p | ForEach-Object { @{ i = $_.ProcessId; p = $_.ParentProcessId; n = $_.Name; t = if ($_.CreationDate) { $_.CreationDate.ToString('s') } else { '' }; c = if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(" +
    `${COMMAND_LINE_LIMIT}` +
    ', $_.CommandLine.Length)) } else { \'\' } } }) } | ConvertTo-Json -Compress -Depth 3',
]
export const POSIX_SNAPSHOT_ARGV: readonly string[] = ['ps', '-A', '-o', 'pid=,ppid=,lstart=,comm=,args=']

const toNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined)

// Walks up from the query's parent to the nearest claude process (a hook
// host may run in a worker under it); the parent itself when there's none.
function sessionPidFrom(processes: readonly SnapshotProcess[], queryPid: number | undefined): number | undefined {
  const byPid = new Map(processes.map(process => [process.pid, process]))
  const parent = queryPid === undefined ? undefined : byPid.get(queryPid)?.ppid
  if (parent === undefined) return undefined
  let current = byPid.get(parent)
  for (let step = 0; step < 4 && current !== undefined; step++) {
    if (/^claude(\.exe)?$/i.test(current.name)) return current.pid
    current = byPid.get(current.ppid)
  }
  return parent
}

export function parseWindowsSnapshot(stdout: string): ProcessSnapshot | undefined {
  let value: unknown
  try {
    value = JSON.parse(stdout.replace(/^﻿/, '').trim())
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { self, procs } = value as { self?: unknown; procs?: unknown }
  const list = Array.isArray(procs) ? procs : procs !== undefined ? [procs] : []
  const processes = list.flatMap(entry => {
    const item = (entry ?? {}) as Record<string, unknown>
    const pid = toNumber(item.i)
    const ppid = toNumber(item.p)
    return pid === undefined || ppid === undefined ? [] : [{ pid, ppid, name: String(item.n ?? ''), started: String(item.t ?? ''), commandLine: String(item.c ?? '').slice(0, COMMAND_LINE_LIMIT) }]
  })
  const queryPid = toNumber(self)
  return { sessionPid: sessionPidFrom(processes, queryPid), processes: processes.filter(process => process.pid !== queryPid) }
}

// `ps -A -o pid=,ppid=,lstart=,comm=,args=`: lstart is five words.
export function parsePosixSnapshot(stdout: string, argv: readonly string[] = POSIX_SNAPSHOT_ARGV): ProcessSnapshot | undefined {
  const processes: SnapshotProcess[] = []
  let queryPid: number | undefined
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)\s*(.*)$/.exec(line)
    if (!match) continue
    const process = { pid: Number(match[1]), ppid: Number(match[2]), started: match[3]!, name: match[4]!.split('/').pop()!, commandLine: match[5]!.slice(0, COMMAND_LINE_LIMIT) }
    if (process.commandLine === argv.join(' ')) queryPid = process.pid
    processes.push(process)
  }
  if (processes.length === 0) return undefined
  return { sessionPid: sessionPidFrom(processes, queryPid), processes: processes.filter(process => process.pid !== queryPid) }
}

export function sessionTree(snapshot: ProcessSnapshot): SnapshotProcess[] {
  if (snapshot.sessionPid === undefined) return []
  const children = new Map<number, SnapshotProcess[]>()
  for (const process of snapshot.processes) children.set(process.ppid, [...(children.get(process.ppid) ?? []), process])
  const root = snapshot.processes.find(process => process.pid === snapshot.sessionPid)
  const tree: SnapshotProcess[] = root ? [root] : []
  const queue = [snapshot.sessionPid]
  const seen = new Set(queue)
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      tree.push(child)
      queue.push(child.pid)
    }
  }
  return tree
}

// ── What a command names ───────────────────────────────────────────────────

// Commands that stop, signal or inspect processes: only these take a snapshot.
const PROCESS_WORDS = /\b(taskkill|tskill|kill|pkill|killall|skill|Stop-Process|spps|Get-Process|gps|Debug-Process|Wait-Process|wmic|Invoke-CimMethod|Remove-CimInstance|xkill|fuser)\b/i

export const namesProcesses = (command: string) => PROCESS_WORDS.test(command)

export type ProcessTargets = { pids: number[]; names: string[] }

// The ids and program names a command points at: taskkill /PID and /IM,
// Stop-Process -Id and -Name (and a Get-Process name piped into it), kill
// and its signals, pkill and killall.
export function processTargets(command: string): ProcessTargets {
  const pids = new Set<number>()
  const names = new Set<string>()
  const words = command.replace(/["']/g, ' ').split(/[\s,;|&()]+/).filter(Boolean)
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!
    const lower = word.toLowerCase()
    const next = words[index + 1]
    if (/^\/pid$/i.test(word) || /^-(id|processid|pid)$/i.test(word)) {
      for (let cursor = index + 1; cursor < words.length && /^\d+$/.test(words[cursor]!); cursor++) pids.add(Number(words[cursor]))
    } else if (/^\/im$/i.test(word) || /^-(name|processname)$/i.test(word)) {
      if (next !== undefined) names.add(next)
    } else if (/^(kill|stop-process|spps|skill)$/.test(lower) || lower === 'tskill') {
      for (let cursor = index + 1; cursor < words.length; cursor++) {
        const value = words[cursor]!
        if (/^\d+$/.test(value)) pids.add(Number(value))
        else if (/^-/.test(value) || /^\//.test(value)) continue
        else if (lower === 'tskill') names.add(value)
        else break
      }
    } else if (/^(pkill|killall)$/.test(lower)) {
      const target = words.slice(index + 1).find(value => !value.startsWith('-'))
      if (target !== undefined) names.add(target)
    } else if (/^(get-process|gps)$/.test(lower) && next !== undefined && !next.startsWith('-') && !/^\d+$/.test(next)) {
      names.add(next)
    }
  }
  return { pids: [...pids], names: [...names] }
}

const baseName = (name: string) => name.toLowerCase().replace(/\.exe$/, '')

function nameMatches(processName: string, pattern: string): boolean {
  const target = baseName(pattern)
  const name = baseName(processName)
  if (!target.includes('*') && !target.includes('?')) return name === target
  const source = target.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${source}$`).test(name)
}

export type ResolvedTargets = { lines: string[] }

// Each named id and program against every process: running or not, and
// inside or outside the session's tree.
export function resolveTargets(targets: ProcessTargets, snapshot: ProcessSnapshot): string[] {
  const inTree = new Set(sessionTree(snapshot).map(process => process.pid))
  const lines: string[] = []
  for (const pid of targets.pids) {
    const process = snapshot.processes.find(candidate => candidate.pid === pid)
    lines.push(
      process === undefined
        ? `pid ${pid}: not running`
        : `pid ${pid} (${process.name}, started ${process.started}): ${inTree.has(pid) ? "inside this session's process tree" : "outside this session's process tree"}; command line: ${process.commandLine.slice(0, COMMAND_LINE_LIMIT)}`,
    )
  }
  for (const name of targets.names) {
    const matching = snapshot.processes.filter(process => nameMatches(process.name, name))
    const inside = matching.filter(process => inTree.has(process.pid))
    lines.push(
      matching.length === 0
        ? `${name} (by name): none running`
        : `${name} (by name): ${matching.length} running; ${inside.length} inside this session's process tree${inside.length > 0 ? ` (pid ${inside.map(process => process.pid).join(', ')})` : ''}; ${matching.length - inside.length} outside it`,
    )
  }
  return lines
}

// The tree, newest first, at most `limit` processes, one line each.
export function treeLines(snapshot: ProcessSnapshot, limit = 25): string[] {
  const tree = sessionTree(snapshot)
  return tree
    .slice()
    .sort((left, right) => right.started.localeCompare(left.started))
    .slice(0, limit)
    .map(process => `pid ${process.pid} parent ${process.ppid} ${process.name} started ${process.started}: ${process.commandLine.slice(0, COMMAND_LINE_LIMIT)}`)
}
