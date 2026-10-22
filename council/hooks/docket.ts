// The docket: a record of every sitting, kept per project under
// ~/.claude/council/docket/<project key>/, one JSON line per entry, in one
// file per calendar day (MM-DD.jsonl, UTC). Pure: an entry's fields from a
// council, redaction and caps, the project key and paths, parsing, appending,
// retention, the lock's text and the view's helpers. Reading and writing are
// register.tsx's.
//
// Why a file per day, and a lock: the engine's $.fs writes whole files only
// (no append, no rename, no file modes) and reads at most 4 MiB at a time. A
// day's file stays small whatever the docket holds, and a day's name comes
// round again only after a year, well past the 180 days kept, so its old lines
// are simply dropped when the day is next written and no file is left behind
// to delete. Two sessions writing one project take turns through the lock
// file (DOCKET_LOCK), so neither overwrites the other's line.

import type { AdvisorStatus, Council, DocketEntry, DocketFilter, DocketKind, DocketTally, DocketVote, OrderRole } from '../types'
import { beyondOf, seatsOf } from './council'
import { conditionAtOf, parseLevels } from './court'
import { isPathInside } from './paths'
import { redactSecrets } from './redact'

export const DOCKET_VERSION = 1

export const DOCKET_LIMITS = {
  // Kept per project: at most this many entries, none older than `days`.
  entries: 2000,
  days: 180,
  // Characters kept of each text.
  question: 4000,
  plan: 4000,
  detail: 600,
  verdict: 300,
  // A condition, note, reason, option, leave sentence or check.
  line: 1000,
  findings: 1500,
  // The person's words a sitting carried: each prompt, and Claude's answer's end.
  words: 2000,
  answer: 800,
  // Entries the view lists at a time.
  page: 20,
} as const

export const DAY_MS = 24 * 60 * 60 * 1000

// The lock file: a session writes its token and time, waits `settleMs`, and
// holds the lock if its token is still there. A lock older than `staleMs` (a
// session that died holding it) is taken over; after `waitMs` the write gives
// up and counts as failed.
export const DOCKET_LOCK = { staleMs: 10_000, settleMs: 40, retryMs: 100, waitMs: 15_000 } as const

// Every kind a line may hold. 'summons' and 'advise' are written no more
// (council 0.6.0 removed the advisor agent), but older entries of them are
// still read and shown.
export const DOCKET_KINDS: readonly DocketKind[] = ['consult', 'orders', 'summons', 'amendment', 'court', 'council', 'leave', 'advise', 'recall']

// ── Where it lives ────────────────────────────────────────────────────────

// FNV-1a, 32 bits, as eight hex digits.
function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

// A project's key: the session root as a slug (its last 40 characters) and a
// hash of the whole root, e.g. `claude-workspace-1f2e3d4c`. Only lowercase
// letters, digits and dashes: never a separator or `..`. Windows roots are
// caseless, so C:\Work and c:/work are one project.
export function projectKey(root: string): string {
  const spelled = root.trim().replace(/\\/g, '/').replace(/(.)\/+$/, '$1')
  const isWindows = /^[A-Za-z]:(\/|$)/.test(spelled) || spelled.startsWith('//')
  const normalized = isWindows ? spelled.toLowerCase() : spelled
  const slug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-40)
    .replace(/^-+/, '')
  return `${slug || 'root'}-${shortHash(normalized)}`
}

export const isSafeKey = (key: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(key)

// A day's file: `10-22.jsonl`.
export const isDayFileName = (name: string) => /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\.jsonl$/.test(name)

export function dayFileName(time: string | number): string {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}.jsonl`
}

// The docket's folders and lock for one project: `root` is
// ~/.claude/council/docket, `folder` the project's own. Undefined without a
// home folder or for a key that isn't safe, so nothing is written outside the
// docket.
export type DocketPaths = { root: string; folder: string; lock: string }

export function docketPaths(home: string, key: string): DocketPaths | undefined {
  if (home.trim() === '' || !isSafeKey(key)) return undefined
  const root = `${home.trim().replace(/[\\/]+$/, '')}/.claude/council/docket`
  const folder = `${root}/${key}`
  const lock = `${folder}/lock`
  return isPathInside(folder, root) && isPathInside(lock, folder) ? { root, folder, lock } : undefined
}

// A day file's path in the project's folder; undefined for any other name.
export function docketFile(paths: DocketPaths, name: string): string | undefined {
  if (!isDayFileName(name)) return undefined
  const path = `${paths.folder}/${name}`
  return isPathInside(path, paths.folder) ? path : undefined
}

// ── An entry from a sitting ───────────────────────────────────────────────

type Replies = ReadonlyMap<string, string> | Readonly<Record<string, string>>

const replyOf = (replies: Replies | undefined, id: string): string | undefined =>
  replies === undefined ? undefined : typeof (replies as ReadonlyMap<string, string>).get === 'function' ? (replies as ReadonlyMap<string, string>).get(id) : (replies as Readonly<Record<string, string>>)[id]

// Each seated member's vote; with the members' raw replies (newest round
// first) and the number of dispatches, its LEVEL ratings too.
export function votesOf(council: Council, replies?: Replies, dispatchCount = 0): DocketVote[] {
  return seatsOf(council).map(seat => {
    const report = council.advisors[seat.id]
    const reply = replyOf(replies, seat.id)
    const ratings = reply !== undefined && dispatchCount > 0 ? parseLevels(reply, dispatchCount) : undefined
    const status: AdvisorStatus = report?.status ?? 'failed'
    return {
      id: seat.id,
      title: seat.title,
      status,
      concern: status === 'done' ? (report?.concern ?? 0) : 0,
      verdict: report?.verdict ?? '',
      detail: report?.detail ?? '',
      ...(typeof report?.choice === 'number' ? { choice: report.choice } : {}),
      ...(ratings !== undefined && ratings.size > 0 ? { levels: Array.from({ length: dispatchCount }, (_, index) => ratings.get(index + 1) ?? null) } : {}),
    }
  })
}

export function tallyOf(council: Council): DocketTally {
  const reports = seatsOf(council).map(seat => council.advisors[seat.id])
  const done = reports.filter(report => report?.status === 'done').map(report => report!)
  const abstained = reports.filter(report => report?.status === 'abstained').length
  const options = council.options ?? []
  return {
    gravest: Math.max(0, ...done.map(report => report.concern)),
    concerns: [1, 2, 3, 4, 5].map(level => done.filter(report => report.concern === level).length),
    abstained,
    silent: reports.length - done.length - abstained,
    ...(options.length > 0 ? { picks: options.map((_, index) => done.filter(report => report.choice === index + 1).length) } : {}),
  }
}

// A consult's result: the option most picked, a tie, no pick, or plain advice
// when there were no options.
export function consultOutcome(council: Council): string {
  if (council.phase !== 'done') return 'dissolved'
  const { picks } = tallyOf(council)
  if (picks === undefined) return 'advice'
  const most = Math.max(0, ...picks)
  const leaders = picks.flatMap((count, index) => (count === most && most > 0 ? [index + 1] : []))
  return leaders.length === 0 ? 'no pick' : leaders.length > 1 ? `tie ${leaders.join(', ')}` : `option ${leaders[0]}`
}

// What every sitting records of its council: the votes, abstentions, tally,
// and the strictness and threshold in effect; and, for a sitting that
// carried the person's own words, those words and what members said the
// request adds beyond them.
export function sittingFields(council: Council, replies?: Replies, dispatchCount = 0): Pick<DocketEntry, 'votes' | 'abstentions' | 'tally' | 'strictness' | 'threshold' | 'isDeep' | 'options' | 'beyond' | 'words'> {
  const votes = votesOf(council, replies, dispatchCount)
  const abstentions = votes.filter(vote => vote.status === 'abstained').map(vote => ({ id: vote.id, title: vote.title, reason: vote.verdict }))
  const beyond = beyondOf(council)
  return {
    ...(beyond.length > 0 ? { beyond } : {}),
    ...(council.words ? { words: { prompts: [...council.words.prompts], ...(council.words.answered ? { answered: council.words.answered } : {}) } } : {}),
    votes,
    ...(abstentions.length > 0 ? { abstentions } : {}),
    tally: tallyOf(council),
    strictness: council.strictness ?? 0,
    threshold: conditionAtOf(council),
    ...(council.isDeep ? { isDeep: true } : {}),
    ...(council.options && council.options.length > 0 ? { options: [...council.options] } : {}),
  }
}

// A plan's dispatches as the docket keeps them: folder, role and leave asked.
export const docketDispatches = (dispatches: ReadonlyArray<{ folder: string; role: OrderRole; leave?: string[] }>): NonNullable<DocketEntry['dispatches']> =>
  dispatches.map(dispatch => ({ folder: dispatch.folder, role: dispatch.role, ...(dispatch.leave && dispatch.leave.length > 0 ? { leave: [...dispatch.leave] } : {}) }))

// `20261022T101500-ab12`: the time, then four random hex digits.
export const docketId = (now: number, random: number) =>
  `${new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15)}-${Math.floor(random * 0x10000).toString(16).padStart(4, '0')}`

// Text redacted, then cut to `limit` characters.
export function capText(text: string, limit: number): string {
  const clean = redactSecrets(text)
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean
}

// An entry as it is written: every text redacted and capped.
export function sealEntry(entry: DocketEntry): DocketEntry {
  const line = (text: string) => capText(text, DOCKET_LIMITS.line)
  const lines = (list: readonly string[] | undefined) => list?.map(line)
  return {
    ...entry,
    question: entry.question === undefined ? undefined : capText(entry.question, DOCKET_LIMITS.question),
    plan: entry.plan === undefined ? undefined : capText(entry.plan, DOCKET_LIMITS.plan),
    options: lines(entry.options),
    dispatches: entry.dispatches?.map(dispatch => ({ folder: line(dispatch.folder), role: dispatch.role, leave: lines(dispatch.leave) })),
    folders: lines(entry.folders),
    votes: entry.votes?.map(vote => ({
      ...vote,
      title: line(vote.title),
      verdict: capText(vote.verdict, DOCKET_LIMITS.verdict),
      detail: capText(vote.detail, DOCKET_LIMITS.detail),
      check: vote.check === undefined ? undefined : line(vote.check),
    })),
    abstentions: entry.abstentions?.map(abstention => ({ ...abstention, title: line(abstention.title), reason: line(abstention.reason) })),
    outcome: line(entry.outcome),
    reason: entry.reason === undefined ? undefined : line(entry.reason),
    conditions: lines(entry.conditions),
    notes: lines(entry.notes),
    findings: entry.findings === undefined ? undefined : capText(entry.findings, DOCKET_LIMITS.findings),
    beyond: entry.beyond?.map(item => ({ text: line(item.text), by: lines(item.by)! })),
    words:
      entry.words === undefined
        ? undefined
        : {
            prompts: entry.words.prompts.map(prompt => capText(prompt, DOCKET_LIMITS.words)),
            ...(entry.words.answered !== undefined ? { answered: capText(entry.words.answered, DOCKET_LIMITS.answer) } : {}),
          },
  }
}

// One line of JSON (a newline inside a text is escaped), with no empty fields.
export const formatEntry = (entry: DocketEntry) => JSON.stringify(entry)

// ── Reading ───────────────────────────────────────────────────────────────

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const data = JSON.parse(line) as unknown
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const isText = (value: unknown): value is string => typeof value === 'string'
const texts = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter(isText) : undefined)
const records = (value: unknown): Array<Record<string, unknown>> | undefined =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item)) : undefined

// One line as an entry, its lists checked so the view can trust them; or
// undefined for a line that is not JSON, of another version, or missing what
// every entry has.
export function parseDocketLine(line: string): DocketEntry | undefined {
  const raw = parseRecord(line.replace(/^\uFEFF/, '').trim())
  if (raw === undefined || raw.v !== DOCKET_VERSION) return undefined
  if (!isText(raw.id) || !isText(raw.time) || Number.isNaN(Date.parse(raw.time)) || !isText(raw.outcome) || !DOCKET_KINDS.includes(raw.kind as DocketKind)) return undefined
  const votes = records(raw.votes)?.flatMap(vote =>
    isText(vote.id) && isText(vote.title) && typeof vote.concern === 'number'
      ? [
          {
            ...vote,
            verdict: isText(vote.verdict) ? vote.verdict : '',
            detail: isText(vote.detail) ? vote.detail : '',
            levels: Array.isArray(vote.levels) ? vote.levels.map(level => (typeof level === 'number' ? level : null)) : undefined,
            check: isText(vote.check) ? vote.check : undefined,
          } as DocketVote,
        ]
      : [],
  )
  return {
    ...(raw as DocketEntry),
    session: isText(raw.session) ? raw.session : '',
    project: isText(raw.project) ? raw.project : '',
    question: isText(raw.question) ? raw.question : undefined,
    plan: isText(raw.plan) ? raw.plan : undefined,
    options: texts(raw.options),
    dispatches: records(raw.dispatches)?.flatMap(dispatch =>
      isText(dispatch.folder) && (dispatch.role === 'scout' || dispatch.role === 'knight') ? [{ folder: dispatch.folder, role: dispatch.role, leave: texts(dispatch.leave) }] : [],
    ),
    folders: texts(raw.folders),
    votes,
    abstentions: records(raw.abstentions)?.flatMap(entry => (isText(entry.id) && isText(entry.title) && isText(entry.reason) ? [{ id: entry.id, title: entry.title, reason: entry.reason }] : [])),
    conditions: texts(raw.conditions),
    orderIds: texts(raw.orderIds),
    notes: texts(raw.notes),
    reason: isText(raw.reason) ? raw.reason : undefined,
    findings: isText(raw.findings) ? raw.findings : undefined,
    beyond: records(raw.beyond)?.flatMap(item => (isText(item.text) ? [{ text: item.text, by: texts(item.by) ?? [] }] : [])),
    words: wordsOf(raw.words),
  }
}

// A docket line's words, checked: undefined unless it holds a list of prompts.
function wordsOf(value: unknown): DocketEntry['words'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const prompts = texts(raw.prompts)
  if (prompts === undefined || prompts.length === 0) return undefined
  return { prompts, ...(isText(raw.answered) ? { answered: raw.answered } : {}) }
}

// A file's entries; corrupt lines and lines of another version are skipped.
export const parseDocket = (text: string): DocketEntry[] =>
  text.split('\n').flatMap(line => {
    const entry = line.trim() === '' ? undefined : parseDocketLine(line)
    return entry === undefined ? [] : [entry]
  })

const timeOf = (entry: Pick<DocketEntry, 'time'>) => Date.parse(entry.time)

// The project's entries from its files, newest first, as retention keeps them.
export function docketEntries(fileTexts: readonly string[], now: number): DocketEntry[] {
  const cutoff = now - DOCKET_LIMITS.days * DAY_MS
  return fileTexts
    .flatMap(parseDocket)
    .filter(entry => timeOf(entry) >= cutoff)
    .sort((left, right) => timeOf(right) - timeOf(left) || (right.id > left.id ? 1 : right.id < left.id ? -1 : 0))
    .slice(0, DOCKET_LIMITS.entries)
}

// ── Writing ───────────────────────────────────────────────────────────────

// A line's time, for any JSON line with one (an entry of another version
// counts too); undefined for a corrupt line.
function lineTime(line: string): number | undefined {
  const record = parseRecord(line.trim())
  const time = record !== undefined && isText(record.time) ? Date.parse(record.time) : Number.NaN
  return Number.isNaN(time) ? undefined : time
}

// The day's file with `entry` added at the end. Lines from another day (the
// same calendar day a year or more ago) and corrupt lines are dropped.
export function withEntryAppended(text: string, entry: DocketEntry): string {
  const day = new Date(entry.time).toISOString().slice(0, 10)
  const kept = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      const time = lineTime(line)
      return time !== undefined && new Date(time).toISOString().slice(0, 10) === day
    })
  return `${[...kept, formatEntry(entry)].join('\n')}\n`
}

export type DocketFileText = { name: string; text: string }

// Retention: the new text of every file that changes once lines older than
// DOCKET_LIMITS.days, past the newest DOCKET_LIMITS.entries, or corrupt are
// dropped (a file left with none becomes empty).
export function prunedFiles(files: readonly DocketFileText[], now: number): DocketFileText[] {
  const cutoff = now - DOCKET_LIMITS.days * DAY_MS
  const lines = files.flatMap(file => file.text.split('\n').map((line, index) => ({ key: `${file.name}\n${index}`, time: lineTime(line) })))
  const kept = new Set(
    lines
      .filter((line): line is { key: string; time: number } => line.time !== undefined && line.time >= cutoff)
      .sort((left, right) => right.time - left.time)
      .slice(0, DOCKET_LIMITS.entries)
      .map(line => line.key),
  )
  return files.flatMap(file => {
    const left = file.text.split('\n').flatMap((line, index) => (kept.has(`${file.name}\n${index}`) ? [line.trim()] : []))
    const text = left.length === 0 ? '' : `${left.join('\n')}\n`
    return text === file.text ? [] : [{ name: file.name, text }]
  })
}

export type DocketLock = { token: string; at: number }

export const formatLock = (lock: DocketLock) => JSON.stringify(lock)

export function parseLock(text: string | undefined): DocketLock | undefined {
  const record = text === undefined ? undefined : parseRecord(text.trim())
  return record !== undefined && isText(record.token) && typeof record.at === 'number' ? { token: record.token, at: record.at } : undefined
}

// Another session holds the lock, and not so long ago that it must have died.
export const isLockHeld = (lock: DocketLock | undefined, token: string, now: number) => lock !== undefined && lock.token !== token && Math.abs(now - lock.at) < DOCKET_LOCK.staleMs

// ── The view ──────────────────────────────────────────────────────────────

export const DOCKET_FILTERS: readonly DocketFilter[] = ['all', 'consults', 'orders', 'amendments', 'other']

const FILTER_KINDS: Record<Exclude<DocketFilter, 'all'>, readonly DocketKind[]> = {
  consults: ['consult', 'council', 'court'],
  orders: ['orders', 'summons'],
  amendments: ['amendment'],
  other: ['leave', 'advise', 'recall'],
}

export const matchesFilter = (entry: Pick<DocketEntry, 'kind'>, filter: DocketFilter) => filter === 'all' || FILTER_KINDS[filter].includes(entry.kind)

// One page of the filtered entries, from `offset` (moved back to a page that has entries).
export function docketPage(entries: readonly DocketEntry[], filter: DocketFilter, offset: number): { total: number; offset: number; entries: DocketEntry[] } {
  const filtered = entries.filter(entry => matchesFilter(entry, filter))
  const last = Math.max(0, Math.floor((filtered.length - 1) / DOCKET_LIMITS.page) * DOCKET_LIMITS.page)
  const start = Math.min(Math.max(0, Math.floor(offset / DOCKET_LIMITS.page) * DOCKET_LIMITS.page), last)
  return { total: filtered.length, offset: start, entries: filtered.slice(start, start + DOCKET_LIMITS.page) }
}

// The offset of the page that holds entry `id` under the filter (0 when it isn't there).
export function offsetOf(entries: readonly DocketEntry[], filter: DocketFilter, id: string): number {
  const index = entries.filter(entry => matchesFilter(entry, filter)).findIndex(entry => entry.id === id)
  return index < 0 ? 0 : Math.floor(index / DOCKET_LIMITS.page) * DOCKET_LIMITS.page
}

export const KIND_GLYPH: Record<DocketKind, string> = {
  consult: '?',
  council: '⚜',
  court: '⚖',
  orders: '§',
  summons: '♝',
  amendment: '✎',
  leave: '⚑',
  advise: '⌕',
  recall: '⏏',
}

export const KIND_LABEL: Record<DocketKind, string> = {
  consult: 'consult',
  council: 'council',
  court: 'court',
  orders: 'orders',
  summons: 'second round',
  amendment: 'amendment',
  leave: 'leave',
  advise: 'advisor',
  recall: 'recall',
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

// What an entry was about, on one line, cut to `width` characters.
export function entryTitle(entry: DocketEntry, width = 72): string {
  const orders = (entry.orderIds ?? []).join(', ')
  const leave = entry.dispatches?.[0]?.leave ?? []
  const text =
    entry.kind === 'leave'
      ? `Leave for ${orders}${leave.length > 0 ? `: ${leave.join(' · ')}` : ''}`
      : entry.kind === 'recall'
        ? `Recall ${orders}${entry.reason ? `: ${entry.reason}` : ''}`
        : (entry.plan ?? entry.question ?? KIND_LABEL[entry.kind])
  const flat = oneLine(text)
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
}

// The member with the gravest concern (the first of a tie), if any gave one.
export function gravestVote(entry: Pick<DocketEntry, 'votes'>): DocketVote | undefined {
  return (entry.votes ?? []).filter(vote => vote.status === 'done' && vote.concern > 0).reduce<DocketVote | undefined>((gravest, vote) => (gravest === undefined || vote.concern > gravest.concern ? vote : gravest), undefined)
}

// `10-22 14:03`, in the plugin's local time.
export function entryTime(entry: Pick<DocketEntry, 'time'>): string {
  const date = new Date(entry.time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// The outcome's theme color.
export function outcomeColor(outcome: string): string | undefined {
  if (/^(approved|granted|done|adjourned|option|advice|released)/.test(outcome)) return 'success'
  if (/^(refused|denied|failed|dissolved|timed-out)/.test(outcome)) return 'error'
  if (/^(held|tie|recall|no pick)/.test(outcome)) return 'warning'
  return undefined
}
