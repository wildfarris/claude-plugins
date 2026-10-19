// The scope guard's deterministic half: decides whether a change stays inside
// the session's target folders. Pure; the model is asked only about commands
// this cannot judge.
//
// Policed: paths inside the session root but outside every scope folder.
// Anything outside the session root (temp files, ~/.claude) is left alone.

export type ScopeContext = {
  root: string
  cwd: string
  folders: readonly string[]
  // The home folder, to resolve `~` paths; without it they stay unresolved.
  home?: string
}

export type GuardVerdict =
  | { kind: 'allow' }
  | { kind: 'block'; target: string; reason: string }
  | { kind: 'unclear'; reason: string }

// ── Paths ──────────────────────────────────────────────────────────────────
//
// Two styles, picked by the session root: POSIX, and Windows (drive letters,
// backslashes, UNC). Every path the guard compares (a file edit, a command's
// paths, and the root, cwd, home and scope folders themselves) is first put in
// one canonical form: POSIX paths as they always were; Windows paths as
// `c:/a/b` (forward slashes, the drive letter lowercased) or `//server/share/a`.
//
// On Windows the root's own folders compare case-insensitively, as NTFS does,
// so a path spelled in another case is still policed. The folders below the
// root, which decide what a scope covers, compare exactly: another case is
// blocked rather than let through.

export type PathStyle = 'posix' | 'windows'

// A path the guard cannot place, though it could be inside the root: a UNC or
// device path beside a drive-letter root (\\localhost\c$ reaches the root), a
// drive-relative path on the root's drive, a short (8.3) name or wildcard
// where the root's own folders are, a name Windows would trim (trailing dot or
// space) or a stream (`name:stream`). It counts as out of scope: blocked.
export const UNPLACEABLE = '(a path the guard cannot place)'

export const pathStyleOf = (root: string): PathStyle => (/^[A-Za-z]:([\\/]|$)/.test(root) || root.startsWith('\\\\') ? 'windows' : 'posix')

// A canonical absolute path: '' (POSIX), 'c:' (a drive) or '//server/share'.
type Parsed = { prefix: string; segments: string[] }

type Placing = {
  style: PathStyle
  // The canonical root, for the Windows checks that need it (absent: skipped).
  root?: Parsed
  // The canonical home folder, for `~`.
  home?: string
  // A file tool's path: `$` is literal, and `/c/…` could be read either way.
  isFileTool?: boolean
}

function normalizePosix(path: string): string {
  const isAbsolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!isAbsolute) parts.push('..')
      continue
    }
    parts.push(part)
  }
  const joined = parts.join('/')
  return isAbsolute ? `/${joined}` : joined || '.'
}

// POSIX unless told otherwise (scope-rules relies on that).
export function normalizePath(path: string, style: PathStyle = 'posix'): string {
  return style === 'posix' ? normalizePosix(path) : (placeAll(undefined, path, { style, isFileTool: true })[0] ?? path)
}

const formatPath = ({ prefix, segments }: Parsed) => (prefix.startsWith('//') ? [prefix, ...segments].join('/') : `${prefix}/${segments.join('/')}`)

// A canonical path back into its parts; undefined for anything else.
function parseCanonical(path: string): Parsed | undefined {
  if (path.startsWith('//')) {
    const [server, share, ...segments] = path.slice(2).split('/')
    return server && share ? { prefix: `//${server}/${share}`, segments: segments.filter(Boolean) } : undefined
  }
  if (/^[a-z]:\//.test(path)) return { prefix: path.slice(0, 2), segments: path.slice(3).split('/').filter(Boolean) }
  if (path.startsWith('/')) return { prefix: '', segments: path.split('/').filter(Boolean) }
  return undefined
}

const sameName = (a: string, b: string, isCaseless: boolean) =>
  a === b || (isCaseless && (a.toLowerCase() === b.toLowerCase() || a.toUpperCase() === b.toUpperCase()))

// The segments of a canonical path below a canonical folder, or undefined when
// it isn't inside it. Windows names compare case-insensitively.
function segmentsBelow(path: string, folder: string): string[] | undefined {
  const inner = parseCanonical(path)
  const outer = parseCanonical(folder)
  if (!inner || !outer) return undefined
  const isCaseless = outer.prefix !== ''
  if (!sameName(inner.prefix, outer.prefix, isCaseless) || inner.segments.length < outer.segments.length) return undefined
  if (!outer.segments.every((segment, index) => sameName(inner.segments[index]!, segment, isCaseless))) return undefined
  return inner.segments.slice(outer.segments.length)
}

// Win32 path forms, backslashes already turned to slashes: \\?\ and \\.\
// device forms, drive-absolute paths and UNC. undefined: none of those.
function parseWindowsAbsolute(text: string): { prefix: string; parts: string[] } | typeof UNPLACEABLE | undefined {
  let rest = text
  const device = /^(?:\/\/[?.]\/|\/\?\?\/)([\s\S]*)$/.exec(text)
  if (device) {
    const inner = device[1]!
    const drive = /^([A-Za-z]):(?:\/([\s\S]*))?$/.exec(inner)
    if (drive) return { prefix: `${drive[1]!.toLowerCase()}:`, parts: (drive[2] ?? '').split('/') }
    // \\?\UNC\server\share; anything else (pipes, volumes, GLOBALROOT) can't be placed.
    if (!/^unc\//i.test(inner)) return UNPLACEABLE
    rest = `//${inner.slice(4)}`
  }
  const drive = /^([A-Za-z]):\/([\s\S]*)$/.exec(rest)
  if (drive) return { prefix: `${drive[1]!.toLowerCase()}:`, parts: drive[2]!.split('/') }
  if (rest.startsWith('//')) {
    const [server, share, ...parts] = rest.slice(2).split('/')
    return server && share ? { prefix: `//${server}/${share}`, parts } : UNPLACEABLE
  }
  return undefined
}

const isDriveRoot = (root: Parsed | undefined) => root !== undefined && !root.prefix.startsWith('//')

// A short (8.3) name, a wildcard or a brace where the root's own folders are
// could stand for one of them.
function aliasesRoot(path: Parsed, root: Parsed): boolean {
  if (!sameName(path.prefix, root.prefix, true)) return false
  for (let index = 0; index < Math.min(path.segments.length, root.segments.length); index++) {
    const segment = path.segments[index]!
    if (/~\d|[*?[{]/.test(segment)) return true
    if (!sameName(segment, root.segments[index]!, true)) return false
  }
  return false
}

// Resolves `..` and `.` (never above the drive or share) and checks what
// Windows would read differently from the guard.
function finishWindows(raw: { prefix: string; parts: string[] }, placing: Placing): string {
  if (raw.prefix.startsWith('//') && isDriveRoot(placing.root)) return UNPLACEABLE
  const segments: string[] = []
  for (const part of raw.parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      segments.pop()
      continue
    }
    // Windows trims trailing dots and spaces; `name:stream` is a stream on name.
    if (/[. ]$/.test(part) || part.includes(':')) return UNPLACEABLE
    segments.push(part)
  }
  const parsed = { prefix: raw.prefix, segments }
  return placing.root && aliasesRoot(parsed, placing.root) ? UNPLACEABLE : formatPath(parsed)
}

function placePosix(base: string | undefined, path: string, placing: Placing): string | undefined {
  if (!placing.isFileTool && path.includes('$')) return undefined
  if (path === '~' || path.startsWith('~/')) return placing.home === undefined ? undefined : normalizePosix(`${placing.home}${path.slice(1)}`)
  if (path.startsWith('~')) return undefined
  if (path.startsWith('/')) return normalizePosix(path)
  if (base === UNPLACEABLE) return UNPLACEABLE
  return base === undefined ? undefined : normalizePosix(`${base}/${path}`)
}

function placeWindows(base: string | undefined, path: string, placing: Placing): (string | undefined)[] {
  const text = path.replace(/\\/g, '/')
  const absolute = parseWindowsAbsolute(text)
  // Whatever a variable in it holds, a UNC or device path stays one.
  if (absolute === UNPLACEABLE || (absolute !== undefined && absolute.prefix.startsWith('//') && isDriveRoot(placing.root))) return [UNPLACEABLE]
  if (!placing.isFileTool && text.includes('$')) return [undefined]
  if (absolute !== undefined) return [finishWindows(absolute, placing)]
  if (text === '~' || text.startsWith('~/')) return placing.home === undefined ? [undefined] : placeWindows(undefined, `${placing.home}${text.slice(1)}`, placing)
  if (text.startsWith('~')) return [undefined]
  const baseParsed = base === undefined || base === UNPLACEABLE ? undefined : parseCanonical(base)

  // C:foo: relative to the folder the drive is in, known only for the base's drive.
  const driveRelative = /^([A-Za-z]):([\s\S]*)$/.exec(text)
  if (driveRelative) {
    const drive = `${driveRelative[1]!.toLowerCase()}:`
    if (baseParsed?.prefix === drive) return placeWindows(base, driveRelative[2]!, placing)
    if (placing.root === undefined || placing.root.prefix === drive) return [UNPLACEABLE]
    return [finishWindows({ prefix: drive, parts: driveRelative[2]!.split('/') }, placing)]
  }

  if (text.startsWith('/')) {
    // \foo or /foo: the current drive's root to Windows; Git Bash's own
    // folders (/tmp, /usr) are outside any root, so the drive reading is the
    // stricter stand-in for them.
    const current = baseParsed?.prefix ?? placing.root?.prefix
    const onCurrentDrive = current === undefined ? undefined : finishWindows({ prefix: current, parts: text.split('/') }, placing)
    // /c/…, /cygdrive/c/…, /mnt/c/…: drive C in Git Bash, Cygwin and WSL.
    const mounted = /^\/(?:cygdrive\/|mnt\/)?([A-Za-z])(?=\/|$)([\s\S]*)$/.exec(text)
    if (!mounted) return [onCurrentDrive]
    const onMountedDrive = finishWindows({ prefix: `${mounted[1]!.toLowerCase()}:`, parts: mounted[2]!.split('/') }, placing)
    // A file tool might read /c/x either way: both are checked.
    return placing.isFileTool ? [onMountedDrive, onCurrentDrive] : [onMountedDrive]
  }

  if (base === UNPLACEABLE) return [UNPLACEABLE]
  if (baseParsed === undefined) return [undefined]
  return [finishWindows({ prefix: baseParsed.prefix, parts: [...baseParsed.segments, ...text.split('/')] }, placing)]
}

// Every reading of a path: canonical paths, UNPLACEABLE, or undefined for one
// that can't be resolved (`$VAR` in a command, `~user`, `~` without a known
// home, a relative path from an unknown directory). Only a file tool's
// `/c/…` on Windows has two readings.
function placeAll(base: string | undefined, path: string, placing: Placing): (string | undefined)[] {
  return placing.style === 'posix' ? [placePosix(base, path, placing)] : placeWindows(base, path, placing)
}

// A command's path, as the shell reads it. The style follows the base (or the
// path itself, when it's absolute).
export function resolvePath(base: string | undefined, path: string, home?: string): string | undefined {
  const style = pathStyleOf(base ?? path)
  const canonicalBase = base === undefined || style === 'posix' ? base : placeAll(undefined, base, { style })[0]
  return placeAll(canonicalBase, path, { style, ...(home === undefined ? {} : { home }) })[0]
}

// A canonical absolute path for display and comparison, or undefined.
export function canonicalAbsolute(path: string, style: PathStyle): string | undefined {
  const placed = placeAll(undefined, path, { style, isFileTool: true })[0]
  return placed === UNPLACEABLE ? undefined : placed
}

// The guard's context with every path in canonical form. A scope folder the
// guard can't place covers nothing but still keeps the guard on.
type Placed = { style: PathStyle; root: string; rootParsed: Parsed; cwd?: string; home?: string; folders: string[] }

function placeContext(context: Pick<ScopeContext, 'root' | 'folders'> & Partial<Pick<ScopeContext, 'cwd' | 'home'>>): Placed {
  const style = pathStyleOf(context.root)
  const root = style === 'posix' ? normalizePosix(context.root) : placeAll(undefined, context.root, { style, isFileTool: true })[0]
  const rootParsed = root === undefined ? undefined : parseCanonical(root)
  // Fails closed: the caller blocks the call when the guard throws.
  if (root === undefined || rootParsed === undefined) throw new Error(`the session root ${context.root} cannot be placed`)
  // These paths are literal (no `$` expansion); of /c/… the drive reading is taken.
  const bare: Placing = { style, root: rootParsed, isFileTool: true }
  const homePlaced = context.home ? placeAll(undefined, context.home, bare)[0] : undefined
  const home = homePlaced === UNPLACEABLE ? undefined : homePlaced
  const placing: Placing = home === undefined ? bare : { ...bare, home }
  const cwdPlaced = context.cwd === undefined ? undefined : placeAll(root, context.cwd, placing)[0]
  const cwd = cwdPlaced === UNPLACEABLE ? undefined : cwdPlaced
  const folders = context.folders.map(folder => placeAll(root, folder, placing)[0] ?? UNPLACEABLE)
  return { style, root, rootParsed, folders, ...(cwd === undefined ? {} : { cwd }), ...(home === undefined ? {} : { home }) }
}

const placingOf = (placed: Placed, isFileTool = false): Placing => ({
  style: placed.style,
  root: placed.rootParsed,
  ...(placed.home === undefined ? {} : { home: placed.home }),
  ...(isFileTool ? { isFileTool } : {}),
})

// Both canonical. On Windows, case-insensitive.
export const isInside = (path: string, folder: string) => segmentsBelow(path, folder) !== undefined

export function relativeTo(root: string, path: string): string {
  const style = pathStyleOf(root)
  const canonicalRoot = canonicalAbsolute(root, style)
  const canonicalPath = canonicalAbsolute(path, style)
  const below = canonicalRoot === undefined || canonicalPath === undefined ? undefined : segmentsBelow(canonicalPath, canonicalRoot)
  return below === undefined ? path : below.length === 0 ? '.' : below.join('/')
}

// A path below a folder, `/`-joined ('' for the folder itself), or undefined
// when it isn't inside. Both are read in the folder's style; Windows names
// compare case-insensitively. The path rules match globs against this.
export function pathBelow(folder: string, path: string): string | undefined {
  const style = pathStyleOf(folder)
  const canonicalFolder = canonicalAbsolute(folder, style)
  const canonicalPath = canonicalAbsolute(path, style)
  if (canonicalFolder === undefined || canonicalPath === undefined) return undefined
  return segmentsBelow(canonicalPath, canonicalFolder)?.join('/')
}

// Every canonical absolute path a file tool's path could mean (only Git
// Bash's `/c/…` has two). Ones the guard can't place are left out: the scope
// check blocks those whenever a scope is set.
export function fileReadings(filePath: string, context: Pick<ScopeContext, 'root' | 'cwd' | 'home'>): string[] {
  const placed = placeContext({ ...context, folders: [] })
  return placeAll(placed.cwd, filePath, placingOf(placed, true)).filter((reading): reading is string => reading !== undefined && reading !== UNPLACEABLE)
}

// The root itself as a scope folder covers only the root's own files (and
// commands run at the root), never the folders under it. Below the root, a
// folder covers a path only when its names match exactly.
function covers(folder: string, path: string, below: readonly string[], root: string): boolean {
  if (folder === UNPLACEABLE) return false
  const folderBelow = segmentsBelow(folder, root)
  if (folderBelow === undefined) return isInside(path, folder)
  if (folderBelow.length === 0) return below.length <= 1
  return folderBelow.length <= below.length && folderBelow.every((segment, index) => segment === below[index])
}

function outOfScope(path: string, placed: Placed): boolean {
  if (placed.folders.length === 0) return false
  if (path === UNPLACEABLE) return true
  const below = segmentsBelow(path, placed.root)
  if (below === undefined) return false
  return !placed.folders.some(folder => covers(folder, path, below, placed.root))
}

// Inside the root, outside every scope folder: the one case the guard stops.
export function isOutOfScope(path: string, context: Pick<ScopeContext, 'root' | 'folders'>): boolean {
  if (context.folders.length === 0) return false
  const placed = placeContext(context)
  return outOfScope(path === UNPLACEABLE ? path : (canonicalAbsolute(path, placed.style) ?? UNPLACEABLE), placed)
}

// The scope folder that would hold a path: the top-level folder under the root
// it sits in, or the root itself for the root's own files.
export function topLevelFolder(root: string, path: string): string | undefined {
  const style = pathStyleOf(root)
  const canonicalRoot = canonicalAbsolute(root, style)
  const canonicalPath = canonicalAbsolute(path, style)
  const below = canonicalRoot === undefined || canonicalPath === undefined ? undefined : segmentsBelow(canonicalPath, canonicalRoot)
  if (below === undefined || below.length === 0) return undefined
  if (below.length === 1) return canonicalRoot
  const parsedRoot = parseCanonical(canonicalRoot!)!
  return formatPath({ prefix: parsedRoot.prefix, segments: [...parsedRoot.segments, below[0]!] })
}

// A file tool's path is literal (no `$` expansion). Every reading of it must
// be in scope; one the guard can't place or resolve is blocked.
export function checkFileEdit(filePath: string, context: ScopeContext): GuardVerdict {
  if (context.folders.length === 0) return { kind: 'allow' }
  const placed = placeContext(context)
  const readings = placeAll(placed.cwd, filePath, placingOf(placed, true))
  if (readings.some(reading => reading === undefined || reading === UNPLACEABLE)) {
    return { kind: 'block', target: UNPLACEABLE, reason: `edits a path the guard cannot place inside or outside the root (${filePath})` }
  }
  const offending = readings.find(reading => outOfScope(reading!, placed))
  return offending === undefined ? { kind: 'allow' } : { kind: 'block', target: offending, reason: 'edits a file outside the target folder' }
}

// ── Shell commands ─────────────────────────────────────────────────────────

type Token = { text: string; isQuoted: boolean; isRedirect?: boolean }

export type Segment = {
  tokens: Token[]
  // Paths from $(...) or backticks inside this segment: what it operates on.
  substitutedPaths: Token[]
  // The commands inside those substitutions, judged as commands of their own.
  substitutions: string[]
  // Heredoc bodies this segment reads (the script, when it's fed to a shell).
  heredocs: string[]
  // Joined to the previous segment by a pipe.
  isPiped: boolean
}

const emptySegment = (isPiped: boolean): Segment => ({ tokens: [], substitutedPaths: [], substitutions: [], heredocs: [], isPiped })

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n'])

// Splits a command line into segments of tokens. Handles quotes, $(...) and
// backticks (recursively: the paths the inner command reads or changes),
// heredoc bodies (skipped: they are data), and redirections.
export function parseCommand(command: string): Segment[] {
  const segments: Segment[] = []
  let current: Segment = emptySegment(false)
  let word = ''
  let isWordQuoted = false
  let hasWord = false
  let pendingRedirect = false
  let isNextWordValue = false
  const pendingHeredocDelimiters: string[] = []

  const pushWord = () => {
    if (!hasWord) return
    current.tokens.push({ text: word, isQuoted: isWordQuoted || isNextWordValue, isRedirect: pendingRedirect || undefined })
    pendingRedirect = false
    isNextWordValue = false
    word = ''
    isWordQuoted = false
    hasWord = false
  }
  const endSegment = (separator: string) => {
    pushWord()
    if (current.tokens.length > 0 || current.substitutedPaths.length > 0 || current.substitutions.length > 0) segments.push(current)
    current = emptySegment(separator === '|')
  }
  const addSubstitution = (inner: string) => {
    current.substitutions.push(inner)
    for (const segment of parseCommand(inner)) {
      const analysis = analyzeSegment(segment)
      current.substitutedPaths.push(...analysis.readPaths, ...analysis.targets)
    }
  }
  // $(...) and backticks inside a double-quoted string still run.
  const addQuotedSubstitutions = (text: string) => {
    for (let cursor = 0; cursor < text.length; cursor++) {
      if (text[cursor] === '$' && text[cursor + 1] === '(') {
        let depth = 1
        let end = cursor + 2
        while (end < text.length && depth > 0) {
          if (text[end] === '(') depth++
          else if (text[end] === ')') depth--
          end++
        }
        addSubstitution(text.slice(cursor + 2, end - 1))
        cursor = end - 1
      } else if (text[cursor] === '`') {
        const close = text.indexOf('`', cursor + 1)
        if (close === -1) break
        addSubstitution(text.slice(cursor + 1, close))
        cursor = close
      }
    }
  }
  // After a newline, read each pending heredoc's body through its delimiter;
  // the bodies belong to the segment that declared them.
  const readHeredocBodies = (lineStart: number, owner: Segment | undefined): number => {
    let cursor = lineStart
    while (pendingHeredocDelimiters.length > 0) {
      const delimiter = pendingHeredocDelimiters.shift()!
      const body: string[] = []
      while (cursor < command.length) {
        const lineEnd = command.indexOf('\n', cursor)
        const line = command.slice(cursor, lineEnd === -1 ? command.length : lineEnd)
        cursor = lineEnd === -1 ? command.length : lineEnd + 1
        if (line.trim() === delimiter) break
        body.push(line)
      }
      owner?.heredocs.push(body.join('\n'))
    }
    return cursor - 1
  }

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    const nextChar = command[index + 1]
    if (char === '<' && nextChar === '<') {
      pushWord()
      let cursor = index + 2
      if (command[cursor] === '<') {
        // <<< here-string: the next word is a value, not a file.
        isNextWordValue = true
        index = cursor
        continue
      }
      if (command[cursor] === '-') cursor++
      while (command[cursor] === ' ') cursor++
      const match = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(command.slice(cursor))
      if (match) {
        pendingHeredocDelimiters.push(match[2]!)
        index = cursor + match[0].length - 1
      } else {
        index = cursor - 1
      }
    } else if (char === '\n' && pendingHeredocDelimiters.length > 0) {
      const owner = current.tokens.length > 0 ? current : segments[segments.length - 1]
      endSegment('\n')
      index = readHeredocBodies(index + 1, owner)
    } else if (char === '\\' && nextChar !== undefined) {
      word += nextChar
      hasWord = true
      index++
    } else if (char === "'" || char === '"') {
      const close = command.indexOf(char, index + 1)
      const end = close === -1 ? command.length : close
      if (char === '"') addQuotedSubstitutions(command.slice(index + 1, end))
      word += command.slice(index + 1, end)
      isWordQuoted = true
      hasWord = true
      index = end
    } else if (char === '$' && nextChar === '(') {
      let depth = 1
      let end = index + 2
      while (end < command.length && depth > 0) {
        if (command[end] === '(') depth++
        else if (command[end] === ')') depth--
        end++
      }
      addSubstitution(command.slice(index + 2, end - 1))
      index = end - 1
    } else if (char === '`') {
      const close = command.indexOf('`', index + 1)
      const end = close === -1 ? command.length : close
      addSubstitution(command.slice(index + 1, end))
      index = end
    } else if (char === ' ' || char === '\t') {
      pushWord()
    } else if (char === '>' || (char === '<' && nextChar !== '<')) {
      // `2>&1`, `>/dev/null`, `> file`, `>> file`; input redirects are reads.
      const isOutput = char === '>'
      const descriptor = word
      if (/^\d$/.test(descriptor) || descriptor === '&') {
        word = ''
        hasWord = false
      } else {
        pushWord()
      }
      if (nextChar === '>') index++
      if (command[index + 1] === '&') {
        // >&2 and 2>&1 duplicate a descriptor: no file.
        index++
        while (/\d/.test(command[index + 1] ?? '')) index++
        continue
      }
      if (isOutput) pendingRedirect = true
    } else if (char === '&' && nextChar === '&') {
      endSegment('&&')
      index++
    } else if (char === '|' && nextChar === '|') {
      endSegment('||')
      index++
    } else if (SEPARATORS.has(char)) {
      endSegment(char)
    } else {
      word += char
      hasWord = true
    }
  }
  endSegment(';')
  return segments
}

// Commands whose positional arguments are the files they change.
const FILE_WRITERS = new Set(['rm', 'rmdir', 'mv', 'cp', 'touch', 'mkdir', 'tee', 'ln', 'truncate', 'unlink', 'install', 'rsync', 'patch', 'shred'])
// Of those, the ones that only read their sources: the last positional (or
// -t's value) is what they change.
const COPIERS = new Set(['cp', 'ln', 'install', 'rsync'])
// Shells: their -c code and a heredoc fed to them are commands to judge.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
// Interpreters: inline code (-c/-e) or a heredoc script can't be judged here.
const INTERPRETERS = new Set(['python', 'python3', 'node', 'deno', 'ruby', 'perl', 'php', 'osascript', 'bun'])
// Their first positional is a mode or owner, not a file.
const MODE_THEN_FILES = new Set(['chmod', 'chown', 'chgrp'])
// The first positional is a pattern or script unless -e/-f supplies one.
const PATTERN_THEN_FILES = new Set(['sed', 'perl', 'awk', 'gawk', 'grep', 'egrep', 'fgrep', 'rg', 'ruby'])
// Change the folder they run in (or its tree) rather than named files.
const DIRECTORY_TOOLS = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'make', 'pip', 'pip3', 'poetry', 'uv', 'bundle', 'composer', 'gradle', 'mvn', 'swift', 'dotnet'])
const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'grep', 'ls-files', 'rev-parse', 'describe', 'shortlog', 'fetch', 'reflog', 'help', 'version', 'whatchanged', 'cat-file', 'ls-tree',
  'check-ignore', 'check-attr', 'ls-remote', 'rev-list', 'merge-base', 'for-each-ref', 'show-ref', 'cherry', 'count-objects', 'name-rev', 'var', 'verify-commit', 'verify-tag',
])
// Read-only only as listings: `git branch`, `git tag -l`, `git config --get x`, `git remote -v`,
// `git worktree list`, `git stash list`, `git symbolic-ref HEAD`.
const LISTING_GIT: Record<string, (rest: Token[]) => boolean> = {
  worktree: rest => rest[0]?.text === 'list',
  stash: rest => ['list', 'show'].includes(rest[0]?.text ?? ''),
  'symbolic-ref': rest => rest.filter(token => !isFlag(token)).length <= 1 && !rest.some(token => token.text === '-d' || token.text === '--delete'),
  branch: rest => rest.every(token => ['-a', '-r', '-v', '-vv', '--list', '-l', '--all', '--remotes', '--show-current', '--merged', '--no-merged', '--contains'].includes(token.text)),
  tag: rest => rest.length === 0 || rest.every(token => ['-l', '--list', '-n'].includes(token.text) || token.isQuoted),
  config: rest => rest.some(token => ['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin'].includes(token.text)),
  remote: rest => rest.length === 0 || rest.every(token => ['-v', '--verbose', 'show', 'get-url'].includes(token.text) || !token.text.startsWith('-')) && !['add', 'remove', 'rm', 'rename', 'set-url', 'prune', 'set-head', 'set-branches', 'update'].includes(rest[0]?.text ?? ''),
}
const READ_ONLY_PACKAGE = new Set(['list', 'ls', 'outdated', 'view', 'info', 'why', 'audit', 'help', 'version', '--version', 'search', 'show', 'check', 'tree', 'test', 'run', 'build', 'lint', 'doc'])
// Read-only on their own (sed/perl/find are judged by their flags).
const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'echo', 'printf', 'pwd', 'which', 'type', 'file', 'stat', 'tree', 'du', 'df',
  'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'date', 'env', 'printenv', 'true', 'false', 'test', '[', 'sleep', 'ps',
  'basename', 'dirname', 'realpath', 'readlink', 'md5', 'shasum', 'sha256sum', 'xxd', 'hexdump', 'od', 'column', 'fold', 'nl',
  'grep', 'egrep', 'fgrep', 'rg', 'awk', 'gawk', 'find', 'fd', 'cd', 'pushd', 'popd', 'export', 'set', 'unset', 'source', 'alias',
  'whoami', 'id', 'uname', 'hostname', 'man', 'claude', 'gh',
])
// xargs options that take the next word as their value.
const XARGS_VALUE_OPTIONS = new Set(['-I', '-J', '-L', '-n', '-P', '-s', '-d', '-E', '-R'])
// Wrappers whose next word is the real command.
const WRAPPERS = new Set(['sudo', 'command', 'time', 'nohup', 'exec', 'nice', 'env', 'builtin'])

// Options that take the next word as their value, per command family.
const VALUE_OPTIONS: Record<string, readonly string[]> = {
  sed: ['-e', '-f', '--expression', '--file', '-l'],
  perl: ['-e', '-E', '-M', '-I'],
  grep: ['-e', '-f', '-m', '-A', '-B', '-C', '--include', '--exclude', '--exclude-dir'],
  rg: ['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '--glob', '--type'],
  awk: ['-f', '-v', '-F'],
  git: ['-C', '-c', '-m', '-b', '-B', '--message', '--author', '-u'],
  cp: ['-t', '--target-directory'],
  mv: ['-t', '--target-directory'],
  ln: ['-t', '--target-directory'],
  install: ['-t', '--target-directory', '-m', '-o', '-g'],
  find: [],
  make: ['-C', '-f', '-j'],
  tee: [],
}

const familyOf = (command: string) => (command === 'egrep' || command === 'fgrep' ? 'grep' : command === 'gawk' ? 'awk' : command)

export const isAssignment = (token: Pick<Token, 'text' | 'isQuoted'>) => !token.isQuoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text)

const isFlag = (token: Token) => !token.isQuoted && token.text.startsWith('-') && token.text !== '-'

// Backslashes and a drive letter mark Windows paths ('C:\x', 'docs\a.md').
const looksLikePath = (text: string) =>
  text === '.' || text === '..' || text.startsWith('/') || text.startsWith('./') || text.startsWith('../') || text.startsWith('~') || text.includes('/') || text.includes('\\') || /^[A-Za-z]:/.test(text)

// sed -i, -i.bak, -Ei; perl -pi, -i.orig: in-place edits.
const hasInPlaceFlag = (tokens: Token[]) =>
  tokens.some(token => !token.isQuoted && (token.text === '--in-place' || token.text.startsWith('--in-place=') || /^-[a-zA-Z]*i/.test(token.text)))

type SegmentAnalysis = {
  isMutating: boolean
  isUnknown: boolean
  // Paths it changes; empty means "the folder it runs in".
  targets: Token[]
  // Paths it changes, relative to the folder it runs in (`git -C dir add x`).
  runTargets?: Token[]
  // Shell code it runs (`bash -c '…'`, `eval …`, a heredoc fed to a shell).
  innerCommands?: string[]
  // Paths it only reads (fed to a later mutating command through a pipe).
  readPaths: Token[]
  directoryOption?: string
  changesDirectoryTo?: string
  // Interpreter code given inline: unclear wherever it runs.
  isInlineCode?: boolean
}

function positionals(family: string, args: Token[]): Token[] {
  const valueOptions = VALUE_OPTIONS[family] ?? []
  const found: Token[] = []
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!
    if (token.isRedirect) continue
    if (isFlag(token)) {
      if (valueOptions.includes(token.text)) index++
      continue
    }
    found.push(token)
  }
  return found
}

function analyzeSegment(segment: Segment): SegmentAnalysis {
  // `FOO=bar cmd …`: assignments only count before the command (dd's of=x is an argument).
  let assignments = 0
  while (assignments < segment.tokens.length && isAssignment(segment.tokens[assignments]!)) assignments++
  const tokens = segment.tokens.slice(assignments)
  let start = 0
  while (start < tokens.length && WRAPPERS.has(tokens[start]!.text)) start++
  const head = tokens[start]
  const redirects = segment.tokens.filter(token => token.isRedirect && token.text !== '/dev/null')
  const base: SegmentAnalysis = { isMutating: redirects.length > 0, isUnknown: false, targets: [...redirects], readPaths: [] }
  if (!head) return base

  const command = head.text.split('/').pop()!
  const family = familyOf(command)
  const args = tokens.slice(start + 1)
  const substituted = segment.substitutedPaths

  if (SHELLS.has(command) || command === 'eval') {
    const codeIndex = args.findIndex(token => token.text === '-c')
    const code = command === 'eval' ? [args.map(token => token.text).join(' ')] : codeIndex === -1 ? segment.heredocs : [args[codeIndex + 1]?.text ?? '']
    // A script file it runs can't be judged: unknown, like any script.
    if (code.length === 0) return { ...base, isUnknown: true, targets: [...base.targets, ...args.filter(token => !token.isQuoted && looksLikePath(token.text))] }
    return { ...base, innerCommands: code }
  }

  // (perl -pi -e and ruby -pi -e are in-place edits of named files: judged below.)
  const isInPlaceEdit = PATTERN_THEN_FILES.has(command) && hasInPlaceFlag(args)
  if (INTERPRETERS.has(command) && !isInPlaceEdit && (args.some(token => ['-c', '-e', '-E', '--eval', '-'].includes(token.text)) || segment.heredocs.length > 0)) {
    // Inline code: the folder it runs in is all the guard knows.
    return { ...base, isUnknown: true, isInlineCode: true }
  }

  if (command === 'curl' || command === 'wget') {
    const outputIndex = args.findIndex(token => ['-o', '--output', '-O', '--output-document', '-P', '--directory-prefix'].includes(token.text) || /^--output(-document)?=/.test(token.text))
    if (outputIndex === -1 && !args.some(token => token.text === '-O' || token.text === '--remote-name')) return { ...base, readPaths: [...substituted] }
    const flag = args[outputIndex]
    const value = flag?.text.includes('=') ? { text: flag.text.split('=')[1]!, isQuoted: false } : flag && !(command === 'curl' && flag.text === '-O') ? args[outputIndex + 1] : undefined
    return { ...base, isMutating: true, targets: [...base.targets, ...(value ? [value] : [])] }
  }

  if (command === 'dd') {
    const output = args.find(token => token.text.startsWith('of='))
    return output ? { ...base, isMutating: true, targets: [...base.targets, { text: output.text.slice(3), isQuoted: false }] } : { ...base, readPaths: [...substituted] }
  }

  if (command === 'cd' || command === 'pushd') {
    const target = args.find(token => !isFlag(token))
    return { ...base, changesDirectoryTo: target?.text ?? '' }
  }

  if (command === 'xargs') {
    // xargs [its own options] <command>: the command's paths arrive through the pipe.
    let commandStart = 0
    while (commandStart < args.length && isFlag(args[commandStart]!)) {
      commandStart += XARGS_VALUE_OPTIONS.has(args[commandStart]!.text) ? 2 : 1
    }
    // The piped input is xargs' own stdin, so the inner command has no heredocs or substitutions of its own.
    const inner = analyzeSegment({ ...emptySegment(false), tokens: args.slice(commandStart), substitutedPaths: substituted })
    return { ...inner, targets: [...inner.targets, ...redirects], isMutating: inner.isMutating || base.isMutating }
  }

  if (COPIERS.has(command)) {
    const files = positionals(family, args)
    const targetIndex = args.findIndex(token => token.text === '-t' || token.text === '--target-directory')
    const destination = targetIndex === -1 ? files.slice(-1) : [args[targetIndex + 1]].filter((token): token is Token => token !== undefined)
    const sources = targetIndex === -1 ? files.slice(0, -1) : files
    return { ...base, isMutating: true, targets: [...base.targets, ...destination], readPaths: [...sources, ...substituted] }
  }

  if (FILE_WRITERS.has(command) || MODE_THEN_FILES.has(command)) {
    const files = positionals(family, args).slice(MODE_THEN_FILES.has(command) ? 1 : 0)
    return { ...base, isMutating: true, targets: [...base.targets, ...files, ...substituted] }
  }

  if (PATTERN_THEN_FILES.has(command)) {
    const valueOptions = VALUE_OPTIONS[family] ?? []
    const suppliesPattern = args.some(token => valueOptions.includes(token.text) && ['-e', '-f', '-E', '--expression', '--file'].includes(token.text))
    const files = positionals(family, args).filter(token => !token.isQuoted || looksLikePath(token.text)).slice(suppliesPattern ? 0 : 1)
    const isInPlace = (command === 'sed' || command === 'perl' || command === 'ruby') && hasInPlaceFlag(args)
    return isInPlace
      ? { ...base, isMutating: true, targets: [...base.targets, ...files, ...substituted] }
      : { ...base, readPaths: [...files, ...substituted] }
  }

  if (command === 'find') {
    const firstExpression = args.findIndex(token => token.text.startsWith('-') || token.text === '(' || token.text === '!')
    const roots = (firstExpression === -1 ? args : args.slice(0, firstExpression)).filter(token => !token.isRedirect)
    const isMutating = args.some(token => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(token.text))
    const searched = roots.length > 0 ? roots : [{ text: '.', isQuoted: false }]
    return isMutating ? { ...base, isMutating: true, targets: [...base.targets, ...searched] } : { ...base, readPaths: searched }
  }

  if (DIRECTORY_TOOLS.has(command)) {
    const directoryIndex = args.findIndex(token => token.text === '-C' || token.text === '--prefix' || token.text === '--cwd')
    const directoryOption = directoryIndex === -1 ? undefined : args[directoryIndex + 1]?.text
    const subcommandIndex = args.findIndex((token, index) => !isFlag(token) && !(VALUE_OPTIONS[family] ?? []).includes(args[index - 1]?.text ?? ''))
    const subcommand = subcommandIndex === -1 ? undefined : args[subcommandIndex]!.text
    const rest = subcommandIndex === -1 ? [] : args.slice(subcommandIndex + 1).filter(token => !token.isRedirect)
    const isReadOnly =
      command === 'git'
        ? subcommand === undefined || READ_ONLY_GIT.has(subcommand) || (LISTING_GIT[subcommand]?.(rest) ?? false)
        : subcommand !== undefined && READ_ONLY_PACKAGE.has(subcommand)
    const pathArgs = positionals(family, args).slice(1).filter(token => !token.isQuoted && looksLikePath(token.text))
    return isReadOnly ? base : { ...base, isMutating: true, runTargets: pathArgs, directoryOption }
  }

  if (READ_ONLY.has(command)) {
    return { ...base, readPaths: [...positionals(family, args).filter(token => !token.isQuoted && looksLikePath(token.text)), ...substituted] }
  }

  // Scripts, interpreters, anything unrecognized: can't tell from the words.
  return { ...base, isUnknown: true, targets: [...base.targets, ...args.filter(token => !token.isQuoted && looksLikePath(token.text))] }
}

// The command a segment runs (past leading assignments and wrappers).
export function commandName(segment: Segment): string {
  const tokens = segment.tokens.filter((token, index) => !(isAssignment(token) && segment.tokens.slice(0, index).every(isAssignment)))
  const head = tokens.find(token => !WRAPPERS.has(token.text))
  return head?.text.split('/').pop() ?? ''
}

// Reads only: changes nothing, runs no nested code, and is a command the guard knows.
export function isReadOnlySegment(segment: Segment): boolean {
  if (segment.substitutions.length > 0 || segment.heredocs.length > 0) return false
  const analysis = analyzeSegment(segment)
  return !analysis.isMutating && !analysis.isUnknown && !analysis.isInlineCode && (analysis.innerCommands ?? []).length === 0
}

// Commands nested this deep (bash -c inside eval inside $(…)…) are unclear.
const MAX_NESTING = 4

export function analyzeCommand(command: string, context: ScopeContext, depth = 0): GuardVerdict {
  if (context.folders.length === 0) return { kind: 'allow' }
  if (depth > MAX_NESTING) return { kind: 'unclear', reason: 'nests shell code too deeply to judge' }
  const placed = placeContext(context)
  // undefined once a `cd` goes somewhere the guard can't resolve or place.
  let directory: string | undefined = placed.cwd
  let pipelineReadPaths: { path: string }[] = []
  let unclearReason: string | undefined

  // Canonical, UNPLACEABLE (out of scope: blocked) or undefined (unresolvable).
  const resolve = (base: string | undefined, path: string) => placeAll(base, path, placingOf(placed))[0]
  const outside = (path: string | undefined) => path !== undefined && outOfScope(path, placed)
  // Shell code run from here: judged as a command of its own.
  const judgeInner = (inner: string): GuardVerdict | undefined => {
    if (directory === undefined) {
      unclearReason = 'runs shell code from a folder the guard cannot resolve'
      return undefined
    }
    const verdict = analyzeCommand(inner, { ...context, cwd: directory }, depth + 1)
    if (verdict.kind === 'block') return verdict
    if (verdict.kind === 'unclear') unclearReason = verdict.reason
    return undefined
  }

  for (const segment of parseCommand(command)) {
    for (const inner of segment.substitutions) {
      const blocked = judgeInner(inner)
      if (blocked) return blocked
    }
    const analysis = analyzeSegment(segment)
    if (!segment.isPiped) pipelineReadPaths = []

    if (analysis.changesDirectoryTo !== undefined) {
      // A bare `cd` goes home.
      const next = analysis.changesDirectoryTo === '' ? placed.home : resolve(directory, analysis.changesDirectoryTo)
      directory = next === UNPLACEABLE ? undefined : next
      continue
    }
    for (const inner of analysis.innerCommands ?? []) {
      const blocked = judgeInner(inner)
      if (blocked) return blocked
    }
    const runsIn = analysis.directoryOption ? resolve(directory, analysis.directoryOption) : directory

    if (analysis.isMutating) {
      const explicit = [...analysis.targets.map(token => resolve(directory, token.text)), ...(analysis.runTargets ?? []).map(token => resolve(runsIn, token.text))]
      // A command changing "whatever the pipe sends" changes what was read.
      const fed = segment.isPiped ? pipelineReadPaths.map(entry => entry.path) : []
      const candidates = explicit.length > 0 || fed.length > 0 ? [...explicit, ...fed] : [runsIn]
      const offending = candidates.find(outside)
      if (offending !== undefined) {
        return { kind: 'block', target: offending, reason: 'changes files outside the target folder' }
      }
      if (candidates.some(path => path === undefined) && (runsIn === undefined || outside(runsIn) || directory === undefined)) {
        unclearReason = 'changes a path the guard cannot resolve'
      }
    } else if (analysis.isInlineCode) {
      unclearReason = 'runs inline interpreter code that could change files anywhere'
    } else if (analysis.isUnknown && (runsIn === undefined || outside(runsIn) || analysis.targets.some(token => outside(resolve(directory, token.text))))) {
      unclearReason = 'runs a script or unfamiliar command that could change files outside the target folder'
    }

    for (const token of analysis.readPaths) {
      const path = resolve(directory, token.text)
      if (path !== undefined) pipelineReadPaths.push({ path })
    }
  }
  return unclearReason ? { kind: 'unclear', reason: unclearReason } : { kind: 'allow' }
}

// ── Messages ───────────────────────────────────────────────────────────────

export function describeScope(context: Pick<ScopeContext, 'root' | 'folders'>): string {
  const describe = (folder: string) => {
    const relative = relativeTo(context.root, folder)
    return relative === '.' ? './ (root files)' : `${relative}/`
  }
  return context.folders.length > 0 ? context.folders.map(describe).join(', ') : '(none)'
}

// The folder `/scope set|add <text>` names, if it is the root (its own files)
// or a folder under it (the caller still checks that it exists). Canonical.
export function scopeFolderCandidate(root: string, text: string): string | undefined {
  const style = pathStyleOf(root)
  const canonicalRoot = canonicalAbsolute(root, style)
  const rootParsed = canonicalRoot === undefined ? undefined : parseCanonical(canonicalRoot)
  if (canonicalRoot === undefined || rootParsed === undefined) return undefined
  const trimmed = text.replace(style === 'windows' ? /[\\/]+$/ : /\/+$/, '') || '.'
  const folder = placeAll(canonicalRoot, trimmed, { style, root: rootParsed })[0]
  return folder !== undefined && folder !== UNPLACEABLE && isInside(folder, canonicalRoot) ? folder : undefined
}

// What Claude reads when a call is blocked: enough to correct itself. A shell
// command can be re-run from inside the target; a file edit can't be moved, so
// it names the scope the user would have to add.
export function denialMessage(verdict: { target: string; reason: string }, context: ScopeContext, kind: 'edit' | 'command'): string {
  const scope = describeScope(context)
  const firstFolder = context.folders.find(folder => relativeTo(context.root, folder) !== '.')
  const firstName = firstFolder ? relativeTo(context.root, firstFolder) : undefined
  const reCommand = kind === 'command' && firstName ? [`Re-run it scoped to the target, for example \`cd ${firstName} && …\` or paths under ${firstName}/.`] : []
  if (verdict.target === UNPLACEABLE) {
    return [
      `Blocked by the sidekick scope guard: this ${verdict.reason}.`,
      `This session's target is ${scope} under ${context.root}.`,
      ...reCommand,
      'Spell the path as a plain absolute path (drive letter and full folder names; no UNC, device, short 8.3 or wildcard forms). If the change belongs outside the target, stop and ask the user to run `/scope add <folder>`, or `/scope clear` to stop guarding this session.',
    ].join(' ')
  }
  const needed = topLevelFolder(context.root, verdict.target)
  const addSpec = needed === undefined ? '.' : relativeTo(context.root, needed)
  return [
    `Blocked by the sidekick scope guard: this ${verdict.reason} (${relativeTo(context.root, verdict.target)}).`,
    `This session's target is ${scope} under ${context.root}.`,
    ...reCommand,
    `If the task needs this change, stop and ask the user to run \`/scope add ${addSpec}\`${addSpec === '.' ? " (the root's own files)" : ''}, or \`/scope clear\` to stop guarding this session.`,
  ].join(' ')
}

export const CLASSIFIER_SYSTEM_PROMPT =
  'You check shell commands for one specific accident: changing files outside the folder a coding session is meant to work in. Reading files anywhere is fine. Answer with exactly one line: ALLOW, or BLOCK: <reason in at most 15 words>.'

export function buildClassifierPrompt(command: string, context: ScopeContext): string {
  return [
    `Session root: ${context.root}`,
    `Target folders (changes allowed only inside these): ${context.folders.join(', ')}`,
    `The command runs in: ${context.cwd}`,
    `Command:\n${command}`,
    'Would running this command create, modify or delete files inside the session root but outside every target folder?',
  ].join('\n')
}

export function parseClassifierAnswer(text: string): { kind: 'allow' } | { kind: 'block'; reason: string } | undefined {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  if (/^allow\b/i.test(line)) return { kind: 'allow' }
  const block = /^block\b[:\s-]*(.*)$/i.exec(line)
  return block ? { kind: 'block', reason: block[1]!.trim() || 'the classifier judged it to change files outside the target folder' } : undefined
}
