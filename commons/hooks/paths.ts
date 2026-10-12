// Paths on POSIX and Windows: where an agent may write, which folders a plugin
// names, the home folder, and what a delete may remove. Pure.
//
// Plugins can't import from one another (each is installed into its own
// folder), so this file is kept identical in sidekick, council and commons
// (hooks/paths.ts): change all three together. It follows sidekick's
// scope-guard approach: every path is read into one canonical form before it
// is compared, and a path that can't be read with certainty is refused, never
// let through.
//
// Canonical forms: POSIX `/a/b` (unchanged, `..` resolved); Windows `c:/a/b`
// for a drive (any spelling: `C:\a\b`, `c:/a`, mixed separators, `\\?\C:\a`,
// `\\.\C:\a`) and `//server/share/a` for UNC (`\\server\share\a`,
// `\\?\UNC\server\share\a`). The style comes from the folder a path is
// compared with: on POSIX a backslash is an ordinary character.

export type PathStyle = 'posix' | 'windows'

// A canonical absolute path in parts: prefix '' (POSIX), 'c:' (a drive) or
// '//server/share' (UNC).
export type ParsedPath = { prefix: string; segments: string[] }

export const pathStyleOf = (path: string): PathStyle => (/^[A-Za-z]:([\\/]|$)/.test(path) || /^[\\/]{2}/.test(path) ? 'windows' : 'posix')

export const formatPath = ({ prefix, segments }: ParsedPath): string =>
  prefix.startsWith('//') ? [prefix, ...segments].join('/') : `${prefix}/${segments.join('/')}`

// `..` and `.` resolved, never above the drive, share or `/`; undefined for a
// name Windows would read differently (a trailing dot or space, which it
// trims, or `name:stream`).
function resolveSegments(parts: readonly string[], style: PathStyle): string[] | undefined {
  const segments: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      segments.pop()
      continue
    }
    if (style === 'windows' && (/[. ]$/.test(part) || part.includes(':'))) return undefined
    segments.push(part)
  }
  return segments
}

// An absolute path in canonical parts, or undefined when it isn't one this
// can place: relative paths, `~`, drive-relative `C:x`, a Windows path with no
// drive (`\x`, or Git Bash's `/c/x`, which Windows could also read as C:\c\x),
// device paths other than a drive or UNC, and anything with a variable in it.
export function parseAbsolute(path: string, style: PathStyle = pathStyleOf(path)): ParsedPath | undefined {
  if (path.includes('\0')) return undefined
  if (style === 'posix') {
    if (!path.startsWith('/')) return undefined
    const segments = resolveSegments(path.split('/'), style)
    return segments && { prefix: '', segments }
  }
  let text = path.replace(/\\/g, '/')
  const device = /^\/\/[?.]\/([\s\S]*)$/.exec(text) ?? /^\/\?\?\/([\s\S]*)$/.exec(text)
  if (device) {
    const inner = device[1]!
    if (/^[A-Za-z]:(\/|$)/.test(inner)) text = inner
    else if (/^unc\//i.test(inner)) text = `//${inner.slice(4)}`
    else return undefined
  }
  // `C:` and `C:x` are drive-relative (the drive's current folder): not placeable.
  const drive = /^([A-Za-z]):\/([\s\S]*)$/.exec(text)
  if (drive) {
    const segments = resolveSegments(drive[2]!.split('/'), style)
    return segments && { prefix: `${drive[1]!.toLowerCase()}:`, segments }
  }
  if (text.startsWith('//')) {
    const [server, share, ...parts] = text.slice(2).split('/')
    if (!server || !share || server === '.' || server === '?' || share === '.' || share === '..') return undefined
    const segments = resolveSegments(parts, style)
    return segments && { prefix: `//${server.toLowerCase()}/${share.toLowerCase()}`, segments }
  }
  return undefined
}

// A path's canonical absolute form, or undefined (see parseAbsolute).
export function canonicalPath(path: string, style: PathStyle = pathStyleOf(path)): string | undefined {
  const parsed = parseAbsolute(path, style)
  return parsed && formatPath(parsed)
}

const sameName = (a: string, b: string, isCaseless: boolean) => a === b || (isCaseless && a.toLowerCase() === b.toLowerCase())

// The segments of `path` below `folder`, both already parsed, or undefined
// when it isn't inside. On Windows the first `caselessCount` segments of the
// folder (the session root's own) compare case-insensitively, as NTFS does;
// the rest compare exactly, so a name in another case is refused rather than
// let through on a case-sensitive folder.
export function segmentsBelow(path: ParsedPath, folder: ParsedPath, caselessCount = Infinity): string[] | undefined {
  const isWindows = folder.prefix !== ''
  if (!sameName(path.prefix, folder.prefix, isWindows)) return undefined
  if (path.segments.length < folder.segments.length) return undefined
  for (const [index, segment] of folder.segments.entries()) {
    if (!sameName(path.segments[index]!, segment, isWindows && index < caselessCount)) return undefined
  }
  return path.segments.slice(folder.segments.length)
}

// Whether `path` provably resolves inside `folder` (or is the folder itself).
// The style is the folder's. Fails closed: a relative path, or one either side
// can't place, is outside. `exactBelow` names how many of the folder's own last
// segments compare exactly on Windows (the part below the session root).
export function isPathInside(path: string, folder: string, exactBelow = 0): boolean {
  const style = pathStyleOf(folder)
  const outer = parseAbsolute(folder, style)
  const inner = parseAbsolute(path, style)
  if (outer === undefined || inner === undefined) return false
  return segmentsBelow(inner, outer, Math.max(0, outer.segments.length - exactBelow)) !== undefined
}

// A path relative to `root` in `/`-separated segments ('' for the root
// itself), or undefined when it isn't inside the root.
export function relativeToRoot(root: string, path: string): string | undefined {
  const style = pathStyleOf(root)
  const outer = parseAbsolute(root, style)
  const inner = parseAbsolute(path, style)
  const below = outer && inner ? segmentsBelow(inner, outer) : undefined
  return below?.join('/')
}

// A folder below `root`, joined with the root's own separator so a Windows
// root never gets a mixed path (`C:\a/b`).
export function joinUnder(root: string, relative: string): string {
  const separator = pathStyleOf(root) === 'windows' && root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const trimmed = root.replace(/[\\/]+$/, '')
  return `${trimmed}${separator}${relative.split('/').join(separator)}`
}

// Git Bash, Cygwin and WSL spell drive C as /c/…, /cygdrive/c/… or /mnt/c/…;
// as a home folder (HOME in Git Bash) that means C:/…. Anything else is
// returned as it is.
export function fromBashDrivePath(path: string): string {
  const mounted = /^\/(?:cygdrive\/|mnt\/)?([A-Za-z])(\/[\s\S]*)?$/.exec(path)
  return mounted ? `${mounted[1]!.toUpperCase()}:${mounted[2] ?? '/'}` : path
}

// The home folder from the environment ($.env.get): HOME, else USERPROFILE,
// which is all native Windows sets. A Git Bash HOME (/c/Users/me), taken as
// one only where USERPROFILE is set too, becomes C:/Users/me. undefined when
// neither is set: callers say so rather than guess.
export function homeFromEnvironment(home: string | undefined, profile: string | undefined): string | undefined {
  const fromHome = home?.trim()
  const fromProfile = profile?.trim()
  if (fromHome) return fromProfile ? fromBashDrivePath(fromHome) : fromHome
  return fromProfile || undefined
}

export const NO_HOME = 'could not find the home folder: neither HOME nor USERPROFILE is set'
