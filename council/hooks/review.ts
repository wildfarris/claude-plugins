// Council review mode: judge a repo's work since a ref, with no conversation
// needed (for work done in another session, e.g. on mobile, and pushed).
// Pure: the git commands to run, the material's trimming, and the herald's
// two prompts (pick files, then brief). The hooks module runs and reads.

import { joinUnder, pathStyleOf } from './paths'

export const DEFAULT_REVIEW_QUESTION = 'Is this work sound and ready?'

// The folder `review <folder> …` may name: absolute in any spelling (/x, and
// on Windows C:\x, C:/x, \\server\share), else under the session root in the
// root's own separators. Trailing separators and a leading ./ or .\ dropped.
export function reviewFolderCandidate(root: string, first: string): string {
  const isWindows = pathStyleOf(root) === 'windows'
  const isAbsolute = isWindows ? /^([A-Za-z]:|[\\/])/.test(first) : first.startsWith('/')
  const bare = first.replace(isWindows ? /(?<=.)[\\/]+$/ : /(?<=.)\/+$/, '')
  return isAbsolute ? bare : joinUnder(root, bare.replace(isWindows ? /^\.[\\/]/ : /^\.\//, ''))
}
export const MAX_PICKED_FILES = 5

// How the material is capped (characters), about 30k in all.
// Five picked files fit: 3000 each, 15000 in all.
export const REVIEW_LIMITS = { log: 3000, diffStat: 3000, patch: 12000, map: 4000, file: 3000, files: 15000 }

export type ReviewRef = { kind: 'commit'; ref: string } | { kind: 'time'; since: string }

export type ReviewRequest = { ref: ReviewRef; question: string }

const TIME_REF = /^(yesterday|today|last (?:week|month)|\d+\s+(?:minute|hour|day|week|month)s?\s+ago|\d{4}-\d{2}-\d{2})\b/i

// `<ref> [question]`: a commit, branch or tag, or a time ("yesterday",
// "2 days ago", 2026-10-01; quote any other phrase git understands, e.g.
// "last friday"). The rest is the question.
export function parseReviewArgs(args: string): ReviewRequest | undefined {
  const text = args.trim().replace(/^since\s+/i, '')
  if (text === '') return undefined
  const quoted = /^(["'])(.+?)\1\s*(.*)$/s.exec(text)
  const time = TIME_REF.exec(text)
  const [refText, rest] = quoted
    ? [quoted[2]!.trim(), quoted[3]!]
    : time
      ? [time[1]!, text.slice(time[0].length)]
      : [text.split(/\s+/)[0]!, text.slice(text.split(/\s+/)[0]!.length)]
  const question = rest.trim().replace(/^[:—–-]\s*/, '') || DEFAULT_REVIEW_QUESTION
  // A time phrase, or anything quoted with spaces, is a time; the rest is a commit-ish.
  const isTime = TIME_REF.test(refText) || (quoted !== null && /\s/.test(refText))
  return { ref: isTime ? { kind: 'time', since: refText } : { kind: 'commit', ref: refText }, question }
}

export const describeRef = (ref: ReviewRef) => (ref.kind === 'commit' ? ref.ref : ref.since)

// git's own spelling for "yesterday" and friends.
const gitTime = (since: string) => (/^yesterday$/i.test(since) ? '1 day ago' : /^today$/i.test(since) ? 'midnight' : since.replace(/^last /i, '1 '))

// git's empty tree: the base when the work starts at the repo's first commit,
// so that commit's own changes count too.
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const diffRange = (base: string) => (base === EMPTY_TREE ? EMPTY_TREE : `${base}...HEAD`)

export const GIT = {
  topLevel: ['git', 'rev-parse', '--show-toplevel'],
  // Where FETCH_HEAD lives (a worktree's .git is a file pointing elsewhere).
  commonDir: ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
  verifyCommit: (ref: string) => ['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
  // The last commit before a time: the base the changes are measured from.
  baseBefore: (since: string) => ['git', 'rev-list', '-1', `--before=${gitTime(since)}`, 'HEAD'],
  // Commits since the base (all of HEAD when the base is the empty tree).
  log: (base: string) => ['git', 'log', '-n', '200', '--no-decorate', '--format=%h %ad %s', '--date=short', base === EMPTY_TREE ? 'HEAD' : `${base}..HEAD`],
  // `base...HEAD`: the work on this side since the two met, not the other
  // side's newer commits reversed. Full paths (the herald copies them), and
  // no local diff drivers.
  diffStat: (base: string) => ['git', 'diff', '--no-ext-diff', '--no-textconv', '--stat=1000', diffRange(base)],
  patch: (base: string) => ['git', 'diff', '--no-ext-diff', '--no-textconv', '--unified=2', diffRange(base)],
  // A file as committed at HEAD (not the working tree, and never through a symlink).
  showFile: (path: string) => ['git', 'show', `HEAD:${path}`],
  trackedFiles: ['git', 'ls-files'],
  branch: ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
} as const

const MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Package.swift', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'project.godot']

export function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters cut)` : text
}

// Top-level folders with file counts, and top-level files: a short map.
export function projectMap(trackedFiles: readonly string[]): string {
  const folders = new Map<string, number>()
  const files: string[] = []
  for (const path of trackedFiles) {
    const [head, ...rest] = path.split('/')
    if (!head) continue
    if (rest.length === 0) files.push(head)
    else folders.set(head, (folders.get(head) ?? 0) + 1)
  }
  const folderLines = [...folders].sort((left, right) => right[1] - left[1]).map(([name, count]) => `${name}/ (${count} files)`)
  return cap([`${trackedFiles.length} tracked files.`, ...folderLines, ...files].join('\n'), REVIEW_LIMITS.map)
}

// The top-level README and manifests worth reading for context.
export function contextFiles(trackedFiles: readonly string[]): string[] {
  const topLevel = trackedFiles.filter(path => !path.includes('/'))
  const readme = topLevel.find(path => /^readme(\.|$)/i.test(path))
  return [...(readme ? [readme] : []), ...topLevel.filter(path => MANIFESTS.includes(path))].slice(0, 3)
}

// Where git records the last contact with the remote: a fetch or pull writes
// FETCH_HEAD; a clone that was never fetched again only logs its remote HEAD.
export const FETCH_MARKERS = ['FETCH_HEAD', 'logs/refs/remotes/origin/HEAD']

// A warning when the remote hasn't been fetched in a while; none for a repo
// with no remote record (nothing to pull).
export function fetchAge(lastFetchMs: number | undefined, nowMs: number): string | null {
  if (lastFetchMs === undefined) return null
  const hours = (nowMs - lastFetchMs) / 3_600_000
  if (hours < 1) return null
  const age = hours < 48 ? `${Math.round(hours)} hours` : `${Math.round(hours / 24)} days`
  return `Last fetched ${age} ago; pull first if the work was pushed from elsewhere.`
}

export type ReviewMaterial = {
  question: string
  ref: string
  branch: string
  log: string
  diffStat: string
  patch: string
  map: string
  context: Array<{ path: string; text: string }>
}

const section = (title: string, body: string) => `${title}:\n${body.trim() === '' ? '(none)' : body.trim()}`

function materialSections(material: ReviewMaterial): string[] {
  return [
    `QUESTION FOR THE COUNCIL:\n${material.question}`,
    `REVIEWING: branch ${material.branch}, changes since ${material.ref}`,
    section('COMMITS', cap(material.log, REVIEW_LIMITS.log)),
    section('FILES CHANGED', cap(material.diffStat, REVIEW_LIMITS.diffStat)),
    section('PROJECT MAP', material.map),
    ...material.context.map(file => section(`FILE ${file.path}`, file.text)),
  ]
}

export const PICK_FILES_SYSTEM = 'You help prepare a code review. You pick the few files a reviewer most needs to read in full. Answer in the requested format only.'

export function pickFilesPrompt(material: ReviewMaterial): string {
  return [
    ...materialSections(material),
    `Which files (at most ${MAX_PICKED_FILES}) should the reviewer read in full to judge this work? Prefer changed files that carry the core logic, configuration or risk. Answer with one line: FILES: path, path, … (paths exactly as in FILES CHANGED or the tracked files), or FILES: NONE.`,
  ].join('\n\n')
}

// The picked paths that are really tracked, at most five: from the FILES:
// line and any list lines under it, split on commas (paths may hold spaces).
export function parsePickedFiles(text: string, trackedFiles: readonly string[]): string[] {
  const start = /FILES:\s*/i.exec(text)
  if (start === null) return []
  const rest = text.slice(start.index + start[0].length)
  if (/^none\b/i.test(rest.trim())) return []
  const tracked = new Set(trackedFiles)
  const picked = rest
    .split(/[,\n]+/)
    .map(path => path.trim().replace(/^[-*•]\s*/, '').replace(/^[`'"]|[`'"]$/g, '').replace(/^\.\//, ''))
    .filter(path => tracked.has(path))
  return [...new Set(picked)].slice(0, MAX_PICKED_FILES)
}

export const REVIEW_BRIEF_SYSTEM =
  'You are the Herald of a small advisory council. You prepare one factual brief that five advisors will read; they see only your brief. Report facts, give no verdict, and follow the requested format.'

export function reviewBriefPrompt(material: ReviewMaterial, patch: string, picked: Array<{ path: string; text: string }>): string {
  return [
    ...materialSections(material),
    section('PATCH (trimmed)', cap(patch, REVIEW_LIMITS.patch)),
    ...picked.map(file => section(`FILE ${file.path}`, file.text)),
    'Write the brief, at most 250 words. Its first line is a single sentence summing up what was built or changed. After it, short bullet points: what the work does, the concrete facts that bear on it (code or data touched, services, costs, licenses, permissions, who uses it), anything unfinished or risky you can see, and open questions.',
  ].join('\n\n')
}
