// PowerShell commands, as the guard reads them: the PowerShell tool's
// commands (and `powershell -Command` code inside a Bash command). Pure.
//
// A small reader, not a full parser: statements split on `;`, newlines, `|`,
// `&&` and `||`; words on spaces and unquoted commas; '…' and "…" strings,
// backtick escapes, @'…'@ here-strings (data), comments, and the code inside
// `$(…)`, `@(…)`, `(…)` and `{…}` (read as commands of their own). The
// cmdlets that write files (Set-Content, Add-Content, Clear-Content,
// Out-File, Tee-Object, Export-Csv, New-Item, Remove-Item, Move-Item,
// Copy-Item, Rename-Item) are read for the paths they change, with their
// aliases and parameter prefixes; a native command (git, npm, rg…) is read as
// the Bash reader would read it. Anything else is unknown.

import { analyzeCommand, clearCommand, commandPathOps, isInsideArea, isOutOfScope, resolvePath, UNPLACEABLE, type Clearance, type ClearedSegment, type CommandPathOp, type GuardVerdict, type ScopeContext } from './scope-guard'

export type PsToken = { text: string; isQuoted: boolean; isRedirect?: boolean; isHereString?: boolean; isBlock?: boolean }

export type PsSegment = {
  tokens: PsToken[]
  // Code inside `$(…)`, `@(…)`, `(…)`, `{…}` and "…$(…)…" in this statement.
  inner: string[]
  // Fed by the statement before it through a pipe.
  isPiped: boolean
  // The statement as written (here-string bodies included).
  text: string
}

// The index of the bracket closing the one at `open`, skipping strings and
// nested brackets; the end of the text when it never closes.
function matchClose(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' }
  const stack: string[] = [pairs[text[open]!] ?? ')']
  for (let index = open + 1; index < text.length; index++) {
    const char = text[index]!
    if (char === '`') {
      index++
    } else if (char === "'") {
      index++
      while (index < text.length && !(text[index] === "'" && text[index + 1] !== "'")) index += text[index] === "'" ? 2 : 1
    } else if (char === '"') {
      index++
      while (index < text.length && text[index] !== '"') index += text[index] === '`' ? 2 : 1
    } else if (pairs[char] !== undefined) {
      stack.push(pairs[char]!)
    } else if (char === stack[stack.length - 1]) {
      stack.pop()
      if (stack.length === 0) return index
    }
  }
  return text.length
}

// The `$(…)` code inside an expandable string.
function expandableInner(text: string): string[] {
  const found: string[] = []
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '`') index++
    else if (text[index] === '$' && text[index + 1] === '(') {
      const close = matchClose(text, index + 1)
      found.push(text.slice(index + 2, close))
      index = close
    }
  }
  return found
}

export function parsePowerShell(command: string): PsSegment[] {
  const segments: PsSegment[] = []
  let current: PsSegment = { tokens: [], inner: [], isPiped: false, text: '' }
  let start = 0
  let word = ''
  let hasWord = false
  let isWordQuoted = false
  let isHere = false
  let pendingRedirect = false

  const pushWord = () => {
    if (!hasWord) return
    current.tokens.push({ text: word, isQuoted: isWordQuoted, ...(pendingRedirect ? { isRedirect: true } : {}), ...(isHere ? { isHereString: true } : {}) })
    word = ''
    hasWord = false
    isWordQuoted = false
    isHere = false
    pendingRedirect = false
  }
  const endSegment = (end: number, next: number, isPipe: boolean) => {
    pushWord()
    current.text = command.slice(start, end).trim()
    if (current.tokens.length > 0 || current.inner.length > 0) segments.push(current)
    current = { tokens: [], inner: [], isPiped: isPipe, text: '' }
    start = next
  }

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    const next = command[index + 1]
    if (char === '@' && (next === "'" || next === '"') && /^[ \t]*\r?\n/.test(command.slice(index + 2))) {
      // A here-string: its body is data, closed by '@ or "@ at a line start.
      const bodyStart = command.indexOf('\n', index) + 1
      const closing = new RegExp(`\\r?\\n${next}@`).exec(command.slice(bodyStart - 1))
      const bodyEnd = closing ? bodyStart - 1 + closing.index : command.length
      const body = command.slice(bodyStart, bodyEnd)
      if (next === '"') current.inner.push(...expandableInner(body))
      word += body
      hasWord = true
      isWordQuoted = true
      isHere = true
      index = closing ? bodyEnd + closing[0].length - 1 : command.length
    } else if (char === "'") {
      let cursor = index + 1
      while (cursor < command.length) {
        if (command[cursor] === "'" && command[cursor + 1] === "'") {
          word += "'"
          cursor += 2
          continue
        }
        if (command[cursor] === "'") break
        word += command[cursor]
        cursor++
      }
      hasWord = true
      isWordQuoted = true
      index = cursor
    } else if (char === '"') {
      let cursor = index + 1
      let text = ''
      while (cursor < command.length && command[cursor] !== '"') {
        if (command[cursor] === '`' && cursor + 1 < command.length) {
          text += command[cursor + 1]
          cursor += 2
          continue
        }
        if (command[cursor] === '$' && command[cursor + 1] === '(') {
          const close = matchClose(command, cursor + 1)
          current.inner.push(command.slice(cursor + 2, close))
          text += command.slice(cursor, close + 1)
          cursor = close + 1
          continue
        }
        text += command[cursor]
        cursor++
      }
      word += text
      hasWord = true
      isWordQuoted = true
      index = cursor
    } else if (char === '`') {
      // An escape; a backtick before a line break continues the line.
      if (next === '\r' && command[index + 2] === '\n') index += 2
      else if (next !== '\n' && next !== undefined) {
        word += next
        hasWord = true
        index++
      } else index++
    } else if (char === '#' && !hasWord) {
      const lineEnd = command.indexOf('\n', index)
      index = (lineEnd === -1 ? command.length : lineEnd) - 1
    } else if (char === '<' && next === '#') {
      const close = command.indexOf('#>', index + 2)
      index = close === -1 ? command.length : close + 1
    } else if ((char === '$' || char === '@') && next === '(') {
      const close = matchClose(command, index + 1)
      current.inner.push(command.slice(index + 2, close))
      word += '$(…)'
      hasWord = true
      index = close
    } else if (char === '(') {
      const close = matchClose(command, index)
      current.inner.push(command.slice(index + 1, close))
      word += '$(…)'
      hasWord = true
      index = close
    } else if (char === '{' && word.endsWith('$')) {
      // ${name}: a variable.
      const close = command.indexOf('}', index)
      word += command.slice(index, close === -1 ? command.length : close + 1)
      hasWord = true
      index = close === -1 ? command.length : close
    } else if (char === '{' || (char === '@' && next === '{')) {
      const open = char === '@' ? index + 1 : index
      const close = matchClose(command, open)
      current.inner.push(command.slice(open + 1, close))
      pushWord()
      current.tokens.push({ text: char === '@' ? '@{…}' : '{…}', isQuoted: false, isBlock: true })
      index = close
    } else if (char === ' ' || char === '\t' || char === '\r') {
      pushWord()
    } else if (char === ',') {
      pushWord()
    } else if (char === '\n' || char === ';') {
      endSegment(index, index + 1, false)
    } else if ((char === '|' && next === '|') || (char === '&' && next === '&')) {
      endSegment(index, index + 2, false)
      index++
    } else if (char === '|') {
      endSegment(index, index + 1, true)
    } else if (char === '>') {
      // `>`, `>>`, `2>`, `*>`, `2>&1`: the next word is a file, unless a stream is duplicated.
      if (/^(\d|\*)$/.test(word) && !isWordQuoted) {
        word = ''
        hasWord = false
      } else {
        pushWord()
      }
      if (next === '>') index++
      if (command[index + 1] === '&') {
        index++
        while (/\d/.test(command[index + 1] ?? '')) index++
        continue
      }
      pendingRedirect = true
    } else if (char === '&' && !hasWord && current.tokens.length === 0) {
      // The call operator: the next word is the command.
    } else if (char === '&') {
      endSegment(index, index + 1, false)
    } else {
      word += char
      hasWord = true
    }
  }
  endSegment(command.length, command.length, false)
  return segments
}

// ── Commands ───────────────────────────────────────────────────────────────

const ALIASES: Record<string, string> = {
  gci: 'get-childitem', ls: 'get-childitem', dir: 'get-childitem',
  gc: 'get-content', cat: 'get-content', type: 'get-content',
  sls: 'select-string', gi: 'get-item', gp: 'get-itemproperty', rvpa: 'resolve-path',
  gl: 'get-location', pwd: 'get-location', cd: 'set-location', sl: 'set-location', chdir: 'set-location',
  pushd: 'push-location', popd: 'pop-location',
  echo: 'write-output', write: 'write-output',
  select: 'select-object', where: 'where-object', '?': 'where-object', '%': 'foreach-object', foreach: 'foreach-object',
  sort: 'sort-object', measure: 'measure-object', ft: 'format-table', fl: 'format-list', fw: 'format-wide', oh: 'out-host',
  gcm: 'get-command', gm: 'get-member', gcim: 'get-ciminstance', gwmi: 'get-wmiobject', gsv: 'get-service',
  compare: 'compare-object', diff: 'compare-object', group: 'group-object', gv: 'get-variable', gal: 'get-alias',
  h: 'get-history', history: 'get-history', gmo: 'get-module', sleep: 'start-sleep',
  gps: 'get-process', ps: 'get-process', kill: 'stop-process', spps: 'stop-process',
  saps: 'start-process', start: 'start-process', iex: 'invoke-expression', icm: 'invoke-command',
  irm: 'invoke-restmethod', iwr: 'invoke-webrequest', ipmo: 'import-module',
  rm: 'remove-item', del: 'remove-item', erase: 'remove-item', rd: 'remove-item', rmdir: 'remove-item', ri: 'remove-item',
  mv: 'move-item', move: 'move-item', mi: 'move-item',
  cp: 'copy-item', copy: 'copy-item', cpi: 'copy-item', ci: 'copy-item',
  ni: 'new-item', mkdir: 'new-item', md: 'new-item',
  ren: 'rename-item', rni: 'rename-item', ac: 'add-content', clc: 'clear-content', tee: 'tee-object',
}

// Read-only on their own (a script block they take is read as code).
export const PS_READ_ONLY = new Set([
  'get-childitem', 'get-content', 'select-string', 'get-item', 'get-itemproperty', 'test-path', 'resolve-path', 'get-location',
  'write-output', 'write-host', 'write-verbose', 'write-debug', 'write-warning', 'write-error', 'write-information',
  'select-object', 'where-object', 'foreach-object', 'sort-object', 'measure-object', 'group-object', 'compare-object',
  'format-table', 'format-list', 'format-wide', 'out-string', 'out-host', 'out-null', 'get-member',
  'convertto-json', 'convertfrom-json', 'convertto-csv', 'convertfrom-csv', 'get-date', 'get-command', 'get-help',
  'get-process', 'get-service', 'get-ciminstance', 'get-wmiobject', 'get-filehash', 'join-path', 'split-path',
  'get-variable', 'get-alias', 'get-psdrive', 'get-host', 'get-history', 'get-module', 'get-acl', 'get-uptime',
  'start-sleep', 'get-random', 'test-json', 'get-itempropertyvalue',
])

type WriterKind = 'write' | 'new' | 'delete' | 'move' | 'copy' | 'rename'
type Role = 'path' | 'dest' | 'newname' | 'name' | 'value'

// Each writer and its positional parameters, in order.
const WRITERS: Record<string, { kind: WriterKind; positional: Role[] }> = {
  'set-content': { kind: 'write', positional: ['path', 'value'] },
  'add-content': { kind: 'write', positional: ['path', 'value'] },
  'clear-content': { kind: 'write', positional: ['path'] },
  'out-file': { kind: 'write', positional: ['path', 'value'] },
  'tee-object': { kind: 'write', positional: ['path'] },
  'export-csv': { kind: 'write', positional: ['path'] },
  'new-item': { kind: 'new', positional: ['path'] },
  'remove-item': { kind: 'delete', positional: ['path'] },
  'move-item': { kind: 'move', positional: ['path', 'dest'] },
  'copy-item': { kind: 'copy', positional: ['path', 'dest'] },
  'rename-item': { kind: 'rename', positional: ['path', 'newname'] },
}

// Parameters that take a value, by any prefix PowerShell accepts; every other
// parameter is a switch. A value read as a path only makes the check stricter.
const VALUE_PARAMETERS: Array<[string, Role | 'other', number]> = [
  ['path', 'path', 1], ['literalpath', 'path', 3], ['lp', 'path', 2], ['pspath', 'path', 3], ['filepath', 'path', 2],
  ['destination', 'dest', 1], ['newname', 'newname', 2], ['name', 'name', 2], ['value', 'value', 2],
  ['itemtype', 'other', 2], ['type', 'other', 2], ['encoding', 'other', 2], ['filter', 'other', 3], ['include', 'other', 3],
  ['exclude', 'other', 2], ['credential', 'other', 2], ['stream', 'other', 2], ['delimiter', 'other', 3], ['width', 'other', 2],
  ['inputobject', 'other', 2], ['target', 'other', 2],
]

function parameterRole(token: PsToken): { role: Role | 'other' | 'switch'; attached?: string } | undefined {
  if (token.isQuoted || !/^-[A-Za-z]/.test(token.text)) return undefined
  const colon = token.text.indexOf(':')
  const name = (colon === -1 ? token.text.slice(1) : token.text.slice(1, colon)).toLowerCase()
  const attached = colon === -1 ? undefined : token.text.slice(colon + 1)
  const found = VALUE_PARAMETERS.find(([full, , least]) => name.length >= least && full.startsWith(name))
  if (found === undefined) return { role: 'switch', ...(attached !== undefined ? { attached } : {}) }
  return { role: found[1], ...(attached !== undefined ? { attached } : {}) }
}

// The command a statement runs, lowercased, aliases resolved, a path and .exe dropped.
export function psCommandName(segment: PsSegment): string {
  const head = psHead(segment)
  return head === undefined ? '' : normalizeName(head.text)
}

const normalizeName = (text: string) => {
  const name = text.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
  return ALIASES[name] ?? name
}

// The statement's command word: past the call operator's `.` (dot-sourcing).
export function psHead(segment: PsSegment): PsToken | undefined {
  const tokens = segment.tokens.filter(token => !token.isRedirect)
  return tokens[0]?.text === '.' && !tokens[0].isQuoted ? tokens[1] : tokens[0]
}

export const psArgs = (segment: PsSegment): PsToken[] => {
  const head = psHead(segment)
  const tokens = segment.tokens.filter(token => !token.isRedirect)
  return head === undefined ? [] : tokens.slice(tokens.indexOf(head) + 1)
}

// An expression rather than a command: `$x`, `'text'`, `123`, `(…)`, `[Type]…`.
export function isExpression(segment: PsSegment): boolean {
  const head = segment.tokens.find(token => !token.isRedirect)
  if (head === undefined) return true
  return head.isQuoted || head.isBlock === true || /^(\$|\[|\d|-\d|@)/.test(head.text)
}

// Native programs, as the Bash reader reads them: a word in single quotes,
// `$` left bare so the reader treats a variable as unresolvable.
export function bashTextOf(segment: PsSegment): string {
  const quote = (text: string) => (text.includes('$') ? text.replace(/\s/g, '') : /^[A-Za-z0-9_./:=@%+,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`)
  const head = psHead(segment)
  const tokens = segment.tokens.slice(head === undefined ? 0 : segment.tokens.indexOf(head))
  return tokens.map(token => (token.isRedirect ? (token.text.toLowerCase() === '$null' ? '>/dev/null' : `> ${quote(token.text)}`) : token.isHereString ? '' : quote(token.text))).filter(Boolean).join(' ')
}

const isNative = (name: string, head: PsToken) => !name.includes('-') || /\.(exe|cmd|bat|com)$/i.test(head.text)

// What one statement does to files: where a location change goes; the paths
// a writer changes (resolved; undefined for one that can't be); native and
// shell code to read as Bash or PowerShell; or unknown.
export type PsAction =
  | { kind: 'location'; to: string | undefined }
  | { kind: 'read' }
  | { kind: 'write'; changes: Array<{ path: string | undefined; op: 'write' | 'delete'; into: string[] }> }
  | { kind: 'native'; text: string }
  | { kind: 'powershell'; code: string }
  | { kind: 'bash'; code: string }
  | { kind: 'unknown'; paths: Array<string | undefined> }

const looksLikePath = (text: string) => /[\\/]/.test(text) || text === '.' || text === '..' || text.startsWith('~') || /^[A-Za-z]:/.test(text)

const nameOf = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

export function psAction(segment: PsSegment, directory: string | undefined, home: string | undefined): PsAction {
  const resolve = (path: string) => {
    if (path.toLowerCase() === '$null') return undefined
    const resolved = resolvePath(directory, path, home)
    return resolved
  }
  const redirects = segment.tokens.filter(token => token.isRedirect && token.text.toLowerCase() !== '$null')
  const redirectChanges = redirects.map(token => ({ path: resolve(token.text), op: 'write' as const, into: [] }))
  const head = psHead(segment)
  const withRedirects = (action: PsAction): PsAction => {
    if (redirectChanges.length === 0) return action
    if (action.kind === 'write') return { ...action, changes: [...action.changes, ...redirectChanges] }
    if (action.kind === 'read' || action.kind === 'location') return { kind: 'write', changes: redirectChanges }
    if (action.kind === 'unknown') return { kind: 'unknown', paths: [...action.paths, ...redirectChanges.map(change => change.path)] }
    return action
  }
  if (head === undefined || isExpression(segment)) return withRedirects({ kind: 'read' })
  const name = normalizeName(head.text)
  const args = psArgs(segment)

  // Named and positional values, by role.
  const values: Record<string, string[]> = {}
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!
    const parameter = parameterRole(token)
    if (parameter === undefined) {
      if (!token.isBlock) positional.push(token.text)
      continue
    }
    if (parameter.role === 'switch') continue
    const value = parameter.attached ?? args[++index]?.text
    if (value !== undefined) (values[parameter.role] ??= []).push(value)
  }

  if (name === 'set-location' || name === 'push-location') {
    const target = values.path?.[0] ?? positional[0]
    if (target === undefined) return { kind: 'location', to: home === undefined ? undefined : resolve(home) }
    const to = target === '-' || target === '+' ? undefined : resolve(target)
    return { kind: 'location', to: to === UNPLACEABLE ? undefined : to }
  }
  if (name === 'pop-location') return { kind: 'location', to: undefined }

  const writer = WRITERS[name]
  if (writer !== undefined) {
    writer.positional.forEach((role, index) => {
      if (positional[index] !== undefined) (values[role] ??= []).push(positional[index]!)
    })
    // Remove-Item a b c: every positional is a path.
    if (writer.kind === 'delete') values.path = [...(values.path ?? []), ...positional.slice(1)]
    const paths = values.path ?? []
    let changes: Array<{ path: string | undefined; op: 'write' | 'delete'; into: string[] }> = []
    if (writer.kind === 'write') changes = paths.map(path => ({ path: resolve(path), op: 'write', into: [] }))
    else if (writer.kind === 'delete') changes = paths.map(path => ({ path: resolve(path), op: 'delete', into: [] }))
    else if (writer.kind === 'new') {
      const names = values.name ?? []
      const bases = paths.length > 0 ? paths : ['.']
      changes = names.length > 0 ? bases.flatMap(base => names.map(name => ({ path: resolve(`${base}/${name}`), op: 'write' as const, into: [] }))) : bases.map(path => ({ path: resolve(path), op: 'write', into: [] }))
    } else if (writer.kind === 'rename') {
      const newName = values.newname?.[0]
      changes = paths.flatMap(path => {
        const parent = path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '') || '.'
        const hasParent = /[\\/]/.test(path.replace(/[\\/]+$/, ''))
        return [{ path: resolve(path), op: 'delete' as const, into: [] }, { path: newName === undefined ? undefined : resolve(hasParent ? `${parent}/${newName}` : newName), op: 'write' as const, into: [] }]
      })
    } else {
      const destination = values.dest?.[0] ?? '.'
      const into = paths.map(nameOf).filter(Boolean)
      changes = [...(writer.kind === 'move' ? paths.map(path => ({ path: resolve(path), op: 'delete' as const, into: [] })) : []), { path: resolve(destination), op: 'write', into }]
    }
    return withRedirects({ kind: 'write', changes })
  }

  if (PS_READ_ONLY.has(name)) return withRedirects({ kind: 'read' })

  if (name === 'powershell' || name === 'pwsh') {
    const commandIndex = args.findIndex(token => !token.isQuoted && /^-(c|co|com|comm|comma|comman|command)$/i.test(token.text))
    if (commandIndex !== -1) return withRedirects({ kind: 'powershell', code: args.slice(commandIndex + 1).map(token => token.text).join(' ') })
  }
  if (['bash', 'sh', 'zsh', 'dash'].includes(name)) {
    const commandIndex = args.findIndex(token => token.text === '-c')
    if (commandIndex !== -1) return withRedirects({ kind: 'bash', code: args[commandIndex + 1]?.text ?? '' })
  }
  if (isNative(name, head)) return { kind: 'native', text: bashTextOf(segment) }
  return withRedirects({ kind: 'unknown', paths: [...positional, ...Object.values(values).flat()].filter(text => looksLikePath(text)).map(resolve) })
}

const MAX_NESTING = 4

// The scope verdict for a PowerShell command, as analyzeCommand gives it for
// Bash: block a change outside the target folders, unclear for what can't be
// told from the words.
export function analyzePowerShell(command: string, context: ScopeContext, depth = 0): GuardVerdict {
  if (context.folders.length === 0) return { kind: 'allow' }
  if (depth > MAX_NESTING) return { kind: 'unclear', reason: 'nests code too deeply to judge' }
  let directory: string | undefined = resolvePath(undefined, context.cwd, context.home)
  if (directory === UNPLACEABLE) directory = undefined
  let unclear: string | undefined
  const outside = (path: string) => isOutOfScope(path, context)
  const inner = (verdict: GuardVerdict): GuardVerdict | undefined => {
    if (verdict.kind === 'block') return verdict
    if (verdict.kind === 'unclear') unclear = verdict.reason
    return undefined
  }
  const here = (): ScopeContext | undefined => (directory === undefined ? undefined : { ...context, cwd: directory })

  for (const segment of parsePowerShell(command)) {
    for (const code of segment.inner) {
      const at = here()
      if (at === undefined) unclear = 'runs code from a folder the guard cannot resolve'
      else {
        const blocked = inner(analyzePowerShell(code, at, depth + 1))
        if (blocked) return blocked
      }
    }
    const action = psAction(segment, directory, context.home)
    if (action.kind === 'location') {
      directory = action.to
      continue
    }
    if (action.kind === 'write') {
      for (const change of action.changes) {
        if (change.path === undefined) unclear = 'changes a path the guard cannot resolve'
        else if (outside(change.path)) return { kind: 'block', target: change.path, reason: 'changes files outside the target folder' }
      }
      continue
    }
    if (action.kind === 'native' || action.kind === 'bash' || action.kind === 'powershell') {
      const at = here()
      if (at === undefined) {
        unclear = 'runs a command from a folder the guard cannot resolve'
        continue
      }
      const verdict = action.kind === 'powershell' ? analyzePowerShell(action.code, at, depth + 1) : analyzeCommand(action.kind === 'native' ? action.text : action.code, at, depth + 1)
      const blocked = inner(verdict)
      if (blocked) return blocked
      continue
    }
    if (action.kind === 'unknown') {
      const offending = action.paths.find(path => path !== undefined && outside(path))
      if (directory === undefined || outside(directory) || offending !== undefined) unclear = 'runs a script or unfamiliar command that could change files outside the target folder'
    }
  }
  return unclear ? { kind: 'unclear', reason: unclear } : { kind: 'allow' }
}

// The fast path for PowerShell (see clearCommand): read-only cmdlets and
// expressions, location changes, and file cmdlets whose every path lands in
// the area clear; a native command clears as the Bash reader clears it; code
// in blocks and subexpressions clears on its own. Everything else (Stop-
// Process, Start-Process, Set-ItemProperty, a .NET method call…) goes to the
// judge.
export function clearPowerShell(command: string, context: Omit<ScopeContext, 'cwd'> & { cwd?: string }, depth = 0): Clearance {
  if (depth > 2) return { segments: [{ text: command.trim(), isCleared: false }], opaque: 'shells nested several deep' }
  let directory: string | undefined = context.cwd === undefined ? undefined : resolvePath(undefined, context.cwd, context.home)
  if (directory === UNPLACEABLE) directory = undefined
  const segments: ClearedSegment[] = []
  let opaque: string | undefined
  const { cwd: _cwd, ...rest } = context
  const at = () => (directory === undefined ? rest : { ...rest, cwd: directory })
  const take = (clearance: Clearance) => {
    segments.push(...clearance.segments)
    opaque ??= clearance.opaque
  }
  for (const segment of parsePowerShell(command)) {
    for (const code of segment.inner) take(clearPowerShell(code, at(), depth + 1))
    const action = psAction(segment, directory, context.home)
    if (action.kind === 'location') {
      directory = action.to
      segments.push({ text: segment.text, isCleared: true })
    } else if (action.kind === 'read') {
      // A static .NET call ([IO.File]::Delete(…)) or a method on an object ($p.Kill()) can change anything.
      segments.push({ text: segment.text, isCleared: !/::|\.\s*[A-Za-z_]\w*\s*(\(|\$\(…\))/.test(segment.tokens.map(token => (token.isQuoted ? "''" : token.text)).join(' ')) })
    } else if (action.kind === 'write') {
      segments.push({ text: segment.text, isCleared: action.changes.length > 0 && action.changes.every(change => isInsideArea(change.path, context)) })
    } else if (action.kind === 'native') {
      take(clearCommand(action.text, at(), depth))
    } else if (action.kind === 'bash') {
      take(clearCommand(action.code, at(), depth + 1))
      segments.push({ text: segment.text, isCleared: true })
    } else if (action.kind === 'powershell') {
      take(clearPowerShell(action.code, at(), depth + 1))
      segments.push({ text: segment.text, isCleared: true })
    } else {
      segments.push({ text: segment.text, isCleared: false })
    }
  }
  return { segments, ...(opaque === undefined ? {} : { opaque }) }
}

// The paths a PowerShell command surely changes, by name: what the path
// rules match, as commandPathOps gives them for Bash.
export function powerShellPathOps(command: string, context: Pick<ScopeContext, 'root' | 'cwd' | 'home'>, depth = 0): CommandPathOp[] {
  if (depth > MAX_NESTING) return []
  let directory: string | undefined = resolvePath(undefined, context.cwd, context.home)
  if (directory === UNPLACEABLE) directory = undefined
  const found: CommandPathOp[] = []
  for (const segment of parsePowerShell(command)) {
    if (directory !== undefined) for (const code of segment.inner) found.push(...powerShellPathOps(code, { ...context, cwd: directory }, depth + 1))
    const action = psAction(segment, directory, context.home)
    if (action.kind === 'location') directory = action.to
    else if (action.kind === 'write') {
      for (const change of action.changes) if (change.path !== undefined && change.path !== UNPLACEABLE) found.push({ path: change.path, op: change.op, into: change.into })
    } else if (directory !== undefined && (action.kind === 'native' || action.kind === 'bash')) {
      found.push(...commandPathOps(action.kind === 'native' ? action.text : action.code, { ...context, cwd: directory }, depth + 1))
    } else if (directory !== undefined && action.kind === 'powershell') {
      found.push(...powerShellPathOps(action.code, { ...context, cwd: directory }, depth + 1))
    }
  }
  return found
}
