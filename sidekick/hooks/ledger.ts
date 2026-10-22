// The turn ledger: a record of what happened in a session, kept as it happens
// (prompts, Claude's own words between calls, every tool call with its
// outcome, final answers), for the TL;DR brief. No model calls. Kept in
// segment files under ~/.claude/sidekick/ledgers/<session>/ so no transcript
// limit applies and a resumed session still has it. Pure: the hooks module
// reads and writes the files.

import { redactSecrets } from './secrets'

export type LedgerFile = { path: string; added: number; removed: number }

export type LedgerEntry =
  // A prompt the person sent: a main turn starts.
  | { kind: 'prompt'; at: number; turnId: string; text: string }
  // Claude's own words in a response (the narration between calls).
  | { kind: 'say'; at: number; text: string; agentId?: string }
  | {
      kind: 'call'
      at: number
      tool: string
      // What it did, in a few words: the Bash description, a path, a pattern.
      summary: string
      durationMs: number
      isError?: true
      agentId?: string
      files?: LedgerFile[]
      commit?: string
      push?: string
      isTest?: true
      // An Agent or Task call's report, cut short.
      report?: string
    }
  | { kind: 'answer'; at: number; turnId: string; text: string; durationMs: number; isAborted?: true }
  // A brief was made: "since the last brief" starts after the newest one.
  | { kind: 'brief'; at: number }
  // One of sidekick's own model calls and what it cost (usage.ts), for
  // /scope usage and the council's /council usage; never part of a brief.
  | ModelEntry

export type ModelEntry = {
  kind: 'model'
  v: 1
  at: number
  plugin: 'sidekick'
  // judge, stop-review, tldr, heads-up, rule, brief or handoff.
  purpose: string
  model: string
  effort?: string
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  session: string
  agentId?: string
  orderId?: string
}

export type BriefSpan = 'last' | 'since' | 'full'

export const LEDGER_FOLDER = '.claude/sidekick/ledgers'
// Entries per segment file: only the newest segment is rewritten on a flush.
export const SEGMENT_ENTRIES = 250
// Unwritten entries that trigger a flush mid-turn (a turn's end always flushes).
export const FLUSH_EVERY = 10
// Ledgers untouched this long are deleted at session start.
export const LEDGER_RETENTION_MS = 14 * 24 * 3600 * 1000

const LIMITS = { summary: 200, prompt: 1500, say: 1500, report: 600, answer: 24000 }

const cut = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text)
const clean = (text: string, limit: number) => cut(redactSecrets(text.replace(/\s+/g, ' ').trim()), limit)
// Long text keeps its line breaks (an answer's lists), redacted and cut.
export const keptText = (text: string, limit: number) => cut(redactSecrets(text.trim()), limit)

const field = (input: Record<string, unknown>, key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined)

// A tool call in a few words.
export function describeCall(tool: string, input: Record<string, unknown>): string {
  const text =
    tool === 'Bash'
      ? (field(input, 'description') ?? field(input, 'command'))
      : (field(input, 'file_path') ??
        field(input, 'notebook_path') ??
        field(input, 'description') ??
        field(input, 'pattern') ??
        field(input, 'url') ??
        field(input, 'query') ??
        field(input, 'path') ??
        field(input, 'prompt'))
  return clean(text ?? '', LIMITS.summary)
}

const TEST_COMMAND =
  /(?:^|[\s;&|(])(?:go test|node --test|(?:npm|pnpm|yarn|bun)(?: run)? test|bun test|npx (?:vitest|jest|playwright test)|vitest|jest|swift test|xcodebuild test|pytest|python3? -m (?:pytest|unittest)|cargo test|make (?:test|check)|claude plugin test|deno test|mvn test|gradle test|\.\/gradlew test|dotnet test|rspec|phpunit|mix test)\b/

export const isTestCommand = (command: string) => TEST_COMMAND.test(command)

// Lines added and removed per file in a Bash call's working-tree diff
// (its `bashEditDiff`), when the engine reported one.
export function filesFromBashDiff(diff: unknown): LedgerFile[] {
  const files = (diff as { files?: unknown } | undefined)?.files
  if (!Array.isArray(files)) return []
  return files.flatMap(file => {
    const record = file as { filePath?: unknown; hunks?: unknown }
    if (typeof record.filePath !== 'string') return []
    let added = 0
    let removed = 0
    for (const hunk of Array.isArray(record.hunks) ? record.hunks : []) {
      for (const line of Array.isArray((hunk as { lines?: unknown }).lines) ? (hunk as { lines: unknown[] }).lines : []) {
        if (typeof line !== 'string') continue
        if (line.startsWith('+')) added++
        else if (line.startsWith('-')) removed++
      }
    }
    return [{ path: record.filePath, added, removed }]
  })
}

export type CallFacts = {
  tool: string
  input: Record<string, unknown>
  at: number
  durationMs: number
  isError: boolean
  agentId?: string
  // From an edit tool: the file's absolute path and its line counts.
  editedFile?: LedgerFile
  // From the tool's result record.
  result?: unknown
  // The result as the model read it (an Agent's report).
  resultText?: string
}

export function callEntry(facts: CallFacts): Extract<LedgerEntry, { kind: 'call' }> {
  const result = (facts.result ?? {}) as { gitOperation?: { commit?: { sha?: unknown }; push?: { branch?: unknown } }; bashEditDiff?: unknown }
  const command = field(facts.input, 'command') ?? ''
  const files = facts.editedFile ? [facts.editedFile] : facts.tool === 'Bash' ? filesFromBashDiff(result.bashEditDiff) : []
  const commit = result.gitOperation?.commit?.sha
  const push = result.gitOperation?.push?.branch
  const isAgentCall = facts.tool === 'Agent' || facts.tool === 'Task'
  return {
    kind: 'call',
    at: facts.at,
    tool: facts.tool,
    summary: describeCall(facts.tool, facts.input),
    durationMs: facts.durationMs,
    ...(facts.isError ? { isError: true as const } : {}),
    ...(facts.agentId !== undefined ? { agentId: facts.agentId } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(typeof commit === 'string' ? { commit: commit.slice(0, 12) } : {}),
    ...(typeof push === 'string' ? { push } : {}),
    ...(facts.tool === 'Bash' && isTestCommand(command) ? { isTest: true as const } : {}),
    ...(isAgentCall && facts.resultText ? { report: clean(facts.resultText, LIMITS.report) } : {}),
  }
}

export const promptEntry = (at: number, turnId: string, text: string): LedgerEntry => ({ kind: 'prompt', at, turnId, text: clean(text, LIMITS.prompt) })

export const sayEntry = (at: number, text: string, agentId?: string): LedgerEntry => ({ kind: 'say', at, text: clean(text, LIMITS.say), ...(agentId !== undefined ? { agentId } : {}) })

export const answerEntry = (at: number, turnId: string, text: string, durationMs: number, isAborted: boolean): LedgerEntry => ({
  kind: 'answer',
  at,
  turnId,
  text: keptText(text, LIMITS.answer),
  durationMs,
  ...(isAborted ? { isAborted: true as const } : {}),
})

// The text blocks of a response row, joined (a row's content is a string or blocks).
export function responseText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('\n')
}

// A response's text as compared against the conversation a compaction
// rebuilt: whitespace folded, so joins of text blocks match.
export const sayKey = (text: string) => text.replace(/\s+/g, ' ').trim()

// Whether a response row is Claude's own new words: not empty, not the
// engine's stand-in for an empty row, and not a row a compaction re-appended
// (`compacted` holds the keys of the conversation it rebuilt).
export function isNewSay(text: string, compacted: ReadonlySet<string>): boolean {
  const key = sayKey(text)
  return key !== '' && key !== '(no content)' && !compacted.has(key)
}

// ── Segment files ─────────────────────────────────────────────────────────

// A session id as a folder name: letters, digits, dashes and underscores.
export const safeSessionFolder = (sessionId: string) => sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'session'

export const segmentName = (index: number) => `${String(index).padStart(6, '0')}.jsonl`

export const segmentIndex = (name: string) => (/^(\d{6})\.jsonl$/.test(name) ? Number(name.slice(0, 6)) : undefined)

export const serializeSegment = (entries: readonly LedgerEntry[]) => (entries.length === 0 ? '' : `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`)

const ENTRY_KINDS = new Set(['prompt', 'say', 'call', 'answer', 'brief', 'model'])

// A segment's entries; a line that isn't one (a torn write) is skipped.
export function parseSegment(text: string): LedgerEntry[] {
  const entries: LedgerEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value = JSON.parse(line) as { kind?: unknown; at?: unknown }
      if (typeof value === 'object' && value !== null && ENTRY_KINDS.has(String(value.kind)) && typeof value.at === 'number') entries.push(value as LedgerEntry)
    } catch {
      // skipped
    }
  }
  return entries
}

// ── Spans ─────────────────────────────────────────────────────────────────

// The words /tldr takes for each span.
export const SPAN_WORDS: Record<string, BriefSpan> = {
  last: 'last',
  turn: 'last',
  since: 'since',
  range: 'since',
  full: 'full',
  whole: 'full',
  complete: 'full',
  session: 'full',
}

export const SPAN_LABELS: Record<BriefSpan, string> = { last: 'last turn', since: 'since the last brief', full: 'whole session' }

// The entries a span covers, oldest first. `last`: from the newest main
// prompt. `since`: after the newest brief marker (all, when none). `full`: all.
// Usage records (`model`) are never part of one.
export function spanEntries(all: readonly LedgerEntry[], span: BriefSpan): LedgerEntry[] {
  const entries = all.filter(entry => entry.kind !== 'model')
  const kept = entries.filter(entry => entry.kind !== 'brief')
  if (span === 'full') return kept
  const isStart = span === 'last' ? (entry: LedgerEntry) => entry.kind === 'prompt' : (entry: LedgerEntry) => entry.kind === 'brief'
  const startIndex = entries.findLastIndex(isStart)
  if (startIndex === -1) return kept
  return entries.slice(span === 'last' ? startIndex : startIndex + 1).filter(entry => entry.kind !== 'brief')
}

// ── Retention ─────────────────────────────────────────────────────────────

// The session folders to delete: older than the retention, never the current one.
export function expiredLedgers(folders: ReadonlyArray<{ name: string; newestMs: number }>, current: string, now: number): string[] {
  return folders.filter(folder => folder.name !== current && /^[A-Za-z0-9_-]+$/.test(folder.name) && now - folder.newestMs > LEDGER_RETENTION_MS).map(folder => folder.name)
}
