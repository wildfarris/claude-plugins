// The inline-code ban: interpreter code written into a command line is
// refused before anything else looks at the command, model or not. Pure.
//
// Inline code is code the command carries itself, which no one can review
// before it runs: `node -e`, `node -p`, `node --eval`, `node -`, or node
// reading code from stdin (a heredoc, a here-string, a pipe), and the same
// shapes for python, python3, py, perl, ruby, php -r, deno eval, bun -e and
// osascript -e; in PowerShell also Invoke-Expression, `powershell
// -EncodedCommand` and Add-Type with inline source. `bash -c`, `sh -c`,
// `eval`, `powershell -Command` and `cmd /c` are read through: refused only
// when the code they wrap is. Running a script file (`node build.mjs`,
// `npm run lint`, `python tool.py`) is not inline code; a heredoc that only
// writes a file (`cat <<'EOF' > notes.md`) is data, not code.

import { isAssignment, parseCommand, type Segment, type Token } from './scope-guard'
import { parsePowerShell, psArgs, psCommandName, psHead, type PsSegment, type PsToken } from './powershell'

// What was found, in a few words: "node -e", "python reading code from a heredoc".
export type InlineFinding = { shape: string }

type Word = { text: string; isQuoted: boolean; isHereString?: boolean }

const MAX_DEPTH = 4

const programOf = (text: string) => text.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')

const isPython = (name: string) => /^python[\d.]*w?$/.test(name) || name === 'py' || name === 'pypy' || name === 'pypy3'

type Interpreter = {
  // The flag that carries code (`-e`), or undefined.
  inlineFlag: (word: string, index: number, words: readonly Word[]) => string | undefined
  // Flags that take the next word as a value.
  valueFlags: readonly string[]
  // Flags after which there's no script and no stdin code (`python -m pkg`, `--version`).
  stopFlags: readonly string[]
  // A first positional that means "code follows on stdin or in the next word".
  codeSubcommand?: (word: string, next: string | undefined) => string | undefined
}

const VERSION_FLAGS = ['--version', '-v', '-V', '--help', '-h']

function interpreterFor(name: string): Interpreter | undefined {
  if (name === 'node' || name === 'nodejs') {
    return {
      inlineFlag: word => (/^(-e|-p|-pe|-ep|--eval|--print)(=|$)/.test(word) ? `node ${word.split('=')[0]}` : undefined),
      valueFlags: ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--title', '--env-file'],
      stopFlags: [...VERSION_FLAGS, '--test', '--run'],
    }
  }
  if (isPython(name)) {
    return {
      // -c, and a cluster ending in it (-Bc, -uc); -c'code' attached.
      inlineFlag: word => (/^-[bBdEhiIOPqsSuvR]*c/.test(word) ? `${name} -c` : undefined),
      valueFlags: ['-W', '-X', '--check-hash-based-pycs'],
      stopFlags: [...VERSION_FLAGS, '-m'],
    }
  }
  if (name === 'perl') {
    return {
      // -e, -E, and clusters like -ne, -pe, -lane, -pi -e.
      inlineFlag: word => (/^-(?![IMmx])[A-Za-z0-9.]*[eE]$/.test(word) || /^-[eE]./.test(word) ? 'perl -e' : undefined),
      valueFlags: ['-I', '-M', '-m'],
      stopFlags: VERSION_FLAGS,
    }
  }
  if (name === 'ruby') {
    return { inlineFlag: word => (/^-[a-zA-Z]*e$/.test(word) || /^-e./.test(word) ? 'ruby -e' : undefined), valueFlags: ['-I', '-r', '-C', '-E'], stopFlags: VERSION_FLAGS }
  }
  if (name === 'php') {
    return { inlineFlag: word => (/^-r/.test(word) || word === '--run' ? 'php -r' : undefined), valueFlags: ['-c', '-d', '-z'], stopFlags: [...VERSION_FLAGS, '-f', '-S', '-l', '-i', '-m'] }
  }
  if (name === 'osascript') return { inlineFlag: word => (word === '-e' ? 'osascript -e' : undefined), valueFlags: ['-l'], stopFlags: [] }
  if (name === 'bun') {
    return {
      inlineFlag: word => (/^(-e|-p|--eval|--print)(=|$)/.test(word) ? `bun ${word.split('=')[0]}` : undefined),
      valueFlags: ['-r', '--preload', '--cwd'],
      stopFlags: [...VERSION_FLAGS, 'test', 'install', 'add', 'remove', 'x', 'build', 'pm', 'create', 'init', 'upgrade', 'link', 'unlink', 'outdated', 'update'],
      codeSubcommand: (word, next) => (word === 'eval' ? 'bun eval' : word === 'run' && next === '-' ? 'bun run -' : undefined),
    }
  }
  if (name === 'deno') {
    return {
      inlineFlag: () => undefined,
      valueFlags: ['--config', '-c'],
      stopFlags: VERSION_FLAGS,
      codeSubcommand: (word, next) => (word === 'eval' ? 'deno eval' : word === 'run' && next === '-' ? 'deno run -' : undefined),
    }
  }
  return undefined
}

// How the interpreter would get code: a flag, `-`, a code subcommand, or
// stdin (a heredoc, a here-string, a pipe) when no script file is named.
function interpreterFinding(name: string, args: readonly Word[], stdin: string | undefined): InlineFinding | undefined {
  const spec = interpreterFor(name)
  if (spec === undefined) return undefined
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word.isHereString) continue
    if (word.isQuoted || !word.text.startsWith('-') || word.text === '-') {
      if (word.text === '-' && !word.isQuoted) return { shape: `${name} -` }
      const subcommand = spec.codeSubcommand?.(word.text, args[index + 1]?.text)
      if (subcommand !== undefined) return { shape: subcommand }
      // The first positional: a script file (or a subcommand that isn't code).
      return undefined
    }
    const inline = spec.inlineFlag(word.text, index, args)
    if (inline !== undefined) return { shape: inline }
    if (spec.stopFlags.includes(word.text)) return undefined
    if (spec.valueFlags.includes(word.text)) index++
  }
  return stdin === undefined ? undefined : { shape: `${name} reading code from ${stdin}` }
}

// Wrappers whose next word is the real command, with the options they take a value for.
const WRAPPERS: Record<string, readonly string[]> = {
  sudo: ['-u', '-g', '-C', '-D'], command: [], builtin: [], time: [], nohup: [], exec: ['-a'], nice: ['-n'], env: ['-u', '-C', '-S'],
  timeout: ['-s', '-k', '--signal', '--kill-after'], xargs: ['-I', '-J', '-L', '-n', '-P', '-s', '-d', '-E', '-R', '-a'], npx: ['-p', '--package', '-c'], stdbuf: ['-i', '-o', '-e'],
  winpty: [], start: [],
}
// Wrappers with a fixed first argument (`timeout 10 node -e …`).
const WRAPPER_LEADING_VALUES: Record<string, number> = { timeout: 1 }

// The command a word list runs, past assignments and wrappers: its index.
function commandStart(words: readonly Word[]): number {
  let index = 0
  while (index < words.length && isAssignment(words[index]!)) index++
  for (;;) {
    const word = words[index]
    if (word === undefined || word.isQuoted) return index
    const wrapper = programOf(word.text)
    const valueFlags = WRAPPERS[wrapper]
    if (valueFlags === undefined) return index
    index++
    while (index < words.length && !words[index]!.isQuoted && (words[index]!.text.startsWith('-') || (wrapper === 'env' && isAssignment(words[index]!)))) {
      index += valueFlags.includes(words[index]!.text) ? 2 : 1
    }
    index += WRAPPER_LEADING_VALUES[wrapper] ?? 0
  }
}

// One Bash command line, read through the shells it wraps.
export function inlineCodeInBash(command: string, depth = 0): InlineFinding | undefined {
  if (depth > MAX_DEPTH) return undefined
  for (const segment of parseCommand(command)) {
    const found = inlineInBashSegment(segment, depth)
    if (found) return found
  }
  return undefined
}

function inlineInBashSegment(segment: Segment, depth: number): InlineFinding | undefined {
  for (const code of segment.substitutions) {
    const found = inlineCodeInBash(code, depth + 1)
    if (found) return found
  }
  const words: Token[] = segment.tokens.filter(token => !token.isRedirect)
  const stdin = segment.heredocs.length > 0 ? 'a heredoc' : words.some(word => word.isHereString) ? 'a here-string' : segment.isPiped ? 'a pipe' : undefined
  const found = inlineInWords(words, stdin, depth, segment.heredocs)
  if (found) return found
  // find … -exec <command> …: that command too.
  const execIndex = words.findIndex(word => ['-exec', '-execdir', '-ok', '-okdir'].includes(word.text))
  if (execIndex !== -1 && programOf(words[commandStart(words)]?.text ?? '') === 'find') return inlineInWords(words.slice(execIndex + 1), undefined, depth, [])
  return undefined
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

function inlineInWords(words: readonly Word[], stdin: string | undefined, depth: number, heredocs: readonly string[]): InlineFinding | undefined {
  const start = commandStart(words)
  const head = words[start]
  if (head === undefined) return undefined
  const name = programOf(head.text)
  const args = words.slice(start + 1)
  if (SHELLS.has(name)) {
    const codeIndex = args.findIndex(word => !word.isQuoted && /^-[a-z]*c$/.test(word.text))
    if (codeIndex !== -1) return inlineCodeInBash(args[codeIndex + 1]?.text ?? '', depth + 1)
    for (const body of heredocs) {
      const found = inlineCodeInBash(body, depth + 1)
      if (found) return found
    }
    return undefined
  }
  if (name === 'eval') return inlineCodeInBash(args.map(word => word.text).join(' '), depth + 1)
  if (name === 'cmd') {
    const codeIndex = args.findIndex(word => /^\/[ck]$/i.test(word.text))
    return codeIndex === -1 ? undefined : inlineCodeInBash(args.slice(codeIndex + 1).map(word => word.text).join(' '), depth + 1)
  }
  if (name === 'powershell' || name === 'pwsh') return powerShellLaunch(args, stdin, depth)
  return interpreterFinding(name, args, stdin)
}

// `powershell -Command <code>` (read through), `-EncodedCommand` (opaque),
// or a script on stdin (`-Command -`, or no -File with code piped in).
function powerShellLaunch(args: readonly Word[], stdin: string | undefined, depth: number): InlineFinding | undefined {
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word.isQuoted || !word.text.startsWith('-')) return undefined
    if (/^-(e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/i.test(word.text)) return { shape: 'powershell -EncodedCommand' }
    if (/^-(c|co|com|comm|comma|comman|command)$/i.test(word.text)) {
      const rest = args.slice(index + 1)
      if (rest.length === 1 && rest[0]!.text === '-' && !rest[0]!.isQuoted) return { shape: 'powershell reading a script from stdin' }
      return inlineCodeInPowerShell(rest.map(part => part.text).join(' '), depth + 1)
    }
    if (/^-(f|fi|fil|file)$/i.test(word.text)) return undefined
    if (/^-(executionpolicy|ep|ex|exec|workingdirectory|wd|w|windowstyle|version|v|configurationname|psconsolefile|outputformat|of|inputformat|if)$/i.test(word.text)) index++
  }
  return stdin === undefined ? undefined : { shape: `powershell reading a script from ${stdin}` }
}

// ── PowerShell ─────────────────────────────────────────────────────────────

const asWords = (tokens: readonly PsToken[]): Word[] => tokens.filter(token => !token.isRedirect && !token.isBlock).map(token => ({ text: token.text, isQuoted: token.isQuoted, ...(token.isHereString ? { isHereString: true } : {}) }))

export function inlineCodeInPowerShell(command: string, depth = 0): InlineFinding | undefined {
  if (depth > MAX_DEPTH) return undefined
  const segments = parsePowerShell(command)
  for (const segment of segments) {
    const found = inlineInPsSegment(segment, depth)
    if (found) return found
  }
  return undefined
}

function inlineInPsSegment(segment: PsSegment, depth: number): InlineFinding | undefined {
  // [ScriptBlock]::Create(…), .Invoke…: code from a string.
  if (/\[\s*scriptblock\s*\]\s*::\s*create/i.test(segment.text)) return { shape: '[ScriptBlock]::Create' }
  if (/\$ExecutionContext\.InvokeCommand\.(InvokeScript|NewScriptBlock)/i.test(segment.text)) return { shape: '$ExecutionContext.InvokeCommand' }
  for (const code of segment.inner) {
    const found = inlineCodeInPowerShell(code, depth + 1)
    if (found) return found
  }
  const head = psHead(segment)
  if (head === undefined) return undefined
  const name = psCommandName(segment)
  const args = psArgs(segment)
  if (name === 'invoke-expression') return { shape: 'Invoke-Expression' }
  if (name === 'add-type' && args.some(token => !token.isQuoted && /^-(typedefinition|memberdefinition|t|ty|typ|m|me|mem)/i.test(token.text))) return { shape: 'Add-Type with inline source' }
  if (name === 'invoke-command' && args.some(token => !token.isQuoted && /^-(scriptblock|sc|s)$/i.test(token.text)) && args.some(token => token.isQuoted)) return { shape: 'Invoke-Command with a script from a string' }
  if (name === 'start-process') {
    // Start-Process node -ArgumentList '-e', '…'
    const program = args.find(token => !token.text.startsWith('-') || token.isQuoted)
    const programName = program === undefined ? '' : programOf(program.text)
    if (interpreterFor(programName) && args.some(token => interpreterFor(programName)!.inlineFlag(token.text.trim().split(/\s+/)[0] ?? '', 0, []) !== undefined)) return { shape: `${programName} inline code through Start-Process` }
    return undefined
  }
  const words = asWords([head, ...args])
  const programName = programOf(head.text)
  // Code piped in, or a here-string argument.
  const stdin = segment.isPiped ? 'a pipe' : args.some(token => token.isHereString) ? 'a here-string' : undefined
  if (SHELLS.has(programName)) {
    const codeIndex = args.findIndex(token => !token.isQuoted && /^-[a-z]*c$/.test(token.text))
    return codeIndex === -1 ? undefined : inlineCodeInBash(args[codeIndex + 1]?.text ?? '', depth + 1)
  }
  if (programName === 'cmd') {
    const codeIndex = args.findIndex(token => /^\/[ck]$/i.test(token.text))
    return codeIndex === -1 ? undefined : inlineCodeInBash(args.slice(codeIndex + 1).map(token => token.text).join(' '), depth + 1)
  }
  if (programName === 'powershell' || programName === 'pwsh') return powerShellLaunch(words.slice(1), stdin, depth)
  return interpreterFinding(programName, words.slice(1), stdin)
}

// ── The refusal ────────────────────────────────────────────────────────────

export const INLINE_CODE_ADVICE =
  'Inline scripts are not allowed: use a CLI tool (jq, rg, sed without -i), or write a script file in the repo and run it, so it can be reviewed.'

// What Claude reads: what was found, what to do instead, and (for a council
// order's agent) to stop and report when no other way works.
export function inlineCodeDenial(finding: InlineFinding, isOrderAgent: boolean): string {
  return [
    `Blocked by the sidekick guard: this command runs inline interpreter code (${finding.shape}).`,
    INLINE_CODE_ADVICE,
    isOrderAgent
      ? 'If the task cannot be done without it, stop and report that instead of working around the ban.'
      : 'The owner can approve this one call when asked, or turn the ban off with inlineCodeBanEnabled.',
  ].join(' ')
}

// The question the owner is asked in an interactive session.
export const inlineCodeQuestion = (finding: InlineFinding) => `Sidekick: this command runs inline interpreter code (${finding.shape}), which the guard refuses by default. ${INLINE_CODE_ADVICE} Allow it this once?`
