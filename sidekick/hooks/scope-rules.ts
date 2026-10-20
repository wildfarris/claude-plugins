// Long-lived rules: written into Claude Code's own settings so the built-in
// checks enforce them, while the scope guard handles each session's live
// scope. Pure: the caller reads and writes <root>/.claude/settings.local.json.
//
//   fence      "never edit <folder>": a permissions.deny rule, enforced by
//              Claude Code itself in every mode, with no model.
//   exclusive  "never <a> and <b> in the same session": enforced by the scope
//              guard (it depends on what the session already touches), and
//              written as an auto-mode sentence so the classifier knows it.
//   forbid     "never create/edit/delete files matching <glob>": a path rule,
//              enforced by the scope guard on file tools and Bash writers, and
//              written as an auto-mode sentence too. A council order's own
//              `forbid` rules are the same rules, read from the council's state.
//   policy     a plain-language sentence ("Don't run Python") for the guard's
//              policy judge, which reads every command code can't clear
//              against it (policy.ts). A council order's plain-sentence
//              `forbid` entries are the same, for its agent.

import { normalizePath, pathBelow, pathStyleOf, relativeTo } from './scope-guard'
import { policySentence } from './policy'
import { stringList } from './values'

export const RULE_MARKER = '[sidekick rule]'
// The per-session push this replaced tagged its entries so; cleaned on sync.
const RETIRED_MARKERS = ['[sidekick scope]']

export type LongLivedRule = { kind: 'fence'; folder: string } | { kind: 'exclusive'; folders: [string, string] } | ({ kind: 'forbid' } & PathRule) | { kind: 'policy'; text: string }

// ── Path rules ─────────────────────────────────────────────────────────────
//
// A path rule forbids some operations on the files a glob matches: the owner's
// "do not edit tests" or "no new CSS". `glob` is relative to the rule's base
// folder (a council order's folder, or the session root for a standing rule):
// `*` and `?` stay inside one name, `**` spans folders, and a glob with no `/`
// matches the file name at any depth (`*.css` is `**/*.css`); a trailing `/`
// means everything under that folder. No braces, classes or regex. On Windows
// it matches case-insensitively, as NTFS names do.

export type PathOp = 'create' | 'edit' | 'delete'
export const PATH_OPS: readonly PathOp[] = ['create', 'edit', 'delete']
export type PathRule = { glob: string; ops: PathOp[]; reason: string }
// Where a rule came from: a council order, or sidekick's standing rules.
export type RuleSource = { kind: 'order'; id: string } | { kind: 'standing' }
export type ActivePathRule = PathRule & { base: string; source: RuleSource }
// The layer that caught a change: a file tool (Edit, Write, NotebookEdit), the
// paths a Bash command names, or the git backstop when an order's agent stops.
export type GuardLayer = 'file tool' | 'Bash' | 'PowerShell' | 'backstop'
// A change a rule forbids: the path below the rule's base, and the operation.
export type PathRuleHit = { rule: ActivePathRule; path: string; op: PathOp }

// The glob as stored: `/`-separated, no `./`, a trailing `/` spelled `/**`;
// undefined for one that is empty, absolute or climbs (`..`).
export function normalizeGlob(text: string): string | undefined {
  let glob = text.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (glob.startsWith('./')) glob = glob.slice(2)
  if (glob.endsWith('/')) glob = `${glob}**`
  if (glob === '' || glob.startsWith('/') || /^[A-Za-z]:/.test(glob) || glob.startsWith('~')) return undefined
  return glob.split('/').some(part => part === '..' || part === '.' || part === '') ? undefined : glob
}

export function globRegExp(glob: string, isCaseless: boolean): RegExp {
  const parts = (glob.includes('/') ? glob : `**/${glob}`).split('/')
  let source = ''
  parts.forEach((part, index) => {
    const isLast = index === parts.length - 1
    if (part === '**') {
      source += isLast ? '.*' : '(?:[^/]*/)*'
      return
    }
    source += part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    if (!isLast) source += '/'
  })
  return new RegExp(`^${source}$`, isCaseless ? 'i' : '')
}

// "create", "create,edit", "edit,delete"…: the operations named, in order.
export function parseOps(text: string): PathOp[] | undefined {
  const names = text.toLowerCase().split(',')
  if (!names.every(name => (PATH_OPS as readonly string[]).includes(name))) return undefined
  return PATH_OPS.filter(op => names.includes(op))
}

// A rule from someone else's state (a council order's `forbid` entry), checked
// by shape: a usable glob, the ops (all three when absent or empty), a reason.
export function readPathRule(value: unknown): PathRule | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const entry = value as Record<string, unknown>
  const glob = typeof entry.glob === 'string' ? normalizeGlob(entry.glob) : undefined
  if (glob === undefined) return undefined
  const named = Array.isArray(entry.ops) ? PATH_OPS.filter(op => (entry.ops as unknown[]).includes(op)) : []
  const reason = typeof entry.reason === 'string' && entry.reason.trim() !== '' ? entry.reason.trim().replace(/\s+/g, ' ').slice(0, 300) : 'no reason given'
  return { glob, ops: named.length > 0 ? named : [...PATH_OPS], reason }
}

// The rules a change to `path` (canonical, absolute) breaks, by any of `ops`
// (two when the guard can't tell a create from an edit).
export function matchPathRules(path: string, ops: readonly PathOp[], rules: readonly ActivePathRule[]): PathRuleHit[] {
  const hits: PathRuleHit[] = []
  for (const rule of rules) {
    const below = pathBelow(rule.base, path)
    if (below === undefined || below === '') continue
    const op = ops.find(candidate => rule.ops.includes(candidate))
    if (op === undefined || !globRegExp(rule.glob, pathStyleOf(rule.base) === 'windows').test(below)) continue
    hits.push({ rule, path: below, op })
  }
  return hits
}

const OP_VERB: Record<PathOp, string> = { create: 'creating', edit: 'editing', delete: 'deleting' }
const LAYER_NAME: Record<GuardLayer, string> = { 'file tool': 'file-tool layer', Bash: 'Bash layer', PowerShell: 'PowerShell layer', backstop: 'stop backstop' }

export const opsText = (ops: readonly PathOp[]) => (ops.length === PATH_OPS.length ? 'create, edit, delete' : ops.join(', '))
const ruleText = (rule: ActivePathRule) => `${rule.source.kind === 'order' ? `order ${rule.source.id}'s rule` : 'the standing rule'} \`${rule.glob}\` (${opsText(rule.ops)})`

// One forbidden change, as every message names it: the change, the rule, its
// source and its reason.
export const hitText = (hit: PathRuleHit) => `${OP_VERB[hit.op]} ${hit.path} is forbidden by ${ruleText(hit.rule)}, reason: ${hit.rule.reason}`

// What Claude reads when a path rule refuses a call: the rule, its source,
// the layer that fired, and what to do instead.
export function pathRuleDenial(hits: readonly PathRuleHit[], layer: GuardLayer): string {
  const first = hits[0]!
  const where = first.rule.source.kind === 'order' ? 'in this order' : 'by a standing rule in this workspace'
  return [
    `Blocked by the sidekick path rules (${LAYER_NAME[layer]}): ${hits.slice(0, 5).map(hitText).join('; ')}.`,
    `This path is protected ${where} (reason: ${first.rule.reason}); if it must change, stop and report why instead of working around it.`,
  ].join(' ')
}

// Two spellings of an absolute path in a permission rule; the caller checks
// which one the engine honors with $.tool.check.
export type PathRuleStyle = 'absolute' | 'project-relative'

type SettingsObject = Record<string, unknown>

export function ruleKey(rule: LongLivedRule): string {
  if (rule.kind === 'forbid') return `forbid ${rule.glob} ${rule.ops.join(',')}`
  if (rule.kind === 'policy') return `policy ${rule.text.toLowerCase()}`
  return rule.kind === 'fence' ? `fence ${rule.folder}` : `exclusive ${[...rule.folders].sort().join(' ')}`
}

export function describeRule(rule: LongLivedRule, root: string): string {
  const show = (folder: string) => `${relativeTo(root, folder)}/`
  if (rule.kind === 'forbid') return `never ${rule.ops.join(' or ')} ${rule.glob} (${rule.reason})`
  if (rule.kind === 'policy') return `"${rule.text}" (policy, for the judge)`
  return rule.kind === 'fence'
    ? `never edit ${show(rule.folder)}`
    : `never ${show(rule.folders[0])} and ${show(rule.folders[1])} in the same session`
}

// "fence other", "exclusive api web" or "forbid <glob> [ops] <reason>",
// folders and globs relative to the root.
export function parseRule(text: string, root: string): LongLivedRule | undefined {
  const [kind, ...names] = text.trim().replace(/^`|`$/g, '').split(/\s+/)
  if (kind?.toLowerCase() === 'policy') {
    const sentence = policySentence(names.join(' ').replace(/^["']|["']$/g, ''))
    return sentence === undefined ? undefined : { kind: 'policy', text: sentence }
  }
  if (kind?.toLowerCase() === 'forbid') {
    const glob = names[0] === undefined ? undefined : normalizeGlob(names[0].replace(/^`|`$/g, ''))
    const ops = names[1] === undefined ? undefined : parseOps(names[1])
    const reason = names.slice(ops === undefined ? 1 : 2).join(' ').trim()
    return glob === undefined || reason === '' ? undefined : { kind: 'forbid', glob, ops: ops ?? [...PATH_OPS], reason }
  }
  const folderOf = (name: string | undefined) => {
    if (!name) return undefined
    const cleaned = name.replace(/^\.\//, '').replace(/\/+$/, '')
    if (cleaned === '' || cleaned === '.' || cleaned.includes('..')) return undefined
    return normalizePath(cleaned.startsWith('/') ? cleaned : `${root}/${cleaned}`)
  }
  if (kind?.toLowerCase() === 'fence') {
    const folder = folderOf(names[0])
    return folder && folder !== root ? { kind: 'fence', folder } : undefined
  }
  if (kind?.toLowerCase() === 'exclusive') {
    const first = folderOf(names[0])
    const second = folderOf(names[1])
    return first && second && first !== second ? { kind: 'exclusive', folders: [first, second] } : undefined
  }
  return undefined
}

// The rule as /rules add takes it, folders relative to the root.
export function ruleSpec(rule: LongLivedRule, root: string): string {
  if (rule.kind === 'forbid') return `forbid ${rule.glob} ${rule.ops.join(',')} ${rule.reason}`
  if (rule.kind === 'policy') return `policy ${rule.text}`
  return rule.kind === 'fence' ? `fence ${relativeTo(root, rule.folder)}` : `exclusive ${rule.folders.map(folder => relativeTo(root, folder)).join(' ')}`
}

export function isLongLivedRule(value: unknown): value is LongLivedRule {
  if (value === null || typeof value !== 'object') return false
  const rule = value as Record<string, unknown>
  if (rule.kind === 'fence') return typeof rule.folder === 'string'
  if (rule.kind === 'policy') return typeof rule.text === 'string' && policySentence(rule.text) === rule.text
  if (rule.kind === 'forbid') {
    const read = readPathRule(rule)
    return read !== undefined && read.glob === rule.glob && typeof rule.reason === 'string' && Array.isArray(rule.ops) && rule.ops.length === read.ops.length
  }
  return rule.kind === 'exclusive' && Array.isArray(rule.folders) && rule.folders.length === 2 && rule.folders.every(folder => typeof folder === 'string')
}

function denyEntry(root: string, folder: string, style: PathRuleStyle): string {
  return style === 'absolute' ? `Edit(/${folder}/**)` : `Edit(/${relativeTo(root, folder)}/**)`
}

function softDenyEntry(rule: Extract<LongLivedRule, { kind: 'exclusive' }>, root: string): string {
  const [first, second] = rule.folders.map(folder => `${relativeTo(root, folder)}/`)
  return `${RULE_MARKER} Changing files in both ${first} and ${second} under ${root} within one session or task: they are separate projects the user keeps apart.`
}

// The classifier's copy of a forbid rule: it can see through the indirect
// writes (scripts, build tools) the guard's own layers miss.
function forbidSentence(rule: Extract<LongLivedRule, { kind: 'forbid' }>, root: string): string {
  const action = rule.ops.map(op => OP_VERB[op]).join(' or ')
  return `${RULE_MARKER} ${action.charAt(0).toUpperCase()}${action.slice(1)} files matching ${rule.glob} under ${root}, by any means: a standing rule the user set (${rule.reason}).`
}

export function builtInEntries(rules: readonly LongLivedRule[], root: string, style: PathRuleStyle): { deny: string[]; softDeny: string[] } {
  return {
    deny: rules.flatMap(rule => (rule.kind === 'fence' ? [denyEntry(root, rule.folder, style)] : [])),
    softDeny: rules.flatMap(rule => (rule.kind === 'exclusive' ? [softDenyEntry(rule, root)] : rule.kind === 'forbid' ? [forbidSentence(rule, root)] : [])),
  }
}

// The standing forbid rules, ready to match: their globs are relative to the root.
export function standingPathRules(rules: readonly LongLivedRule[], root: string): ActivePathRule[] {
  return rules.flatMap(rule => (rule.kind === 'forbid' ? [{ glob: rule.glob, ops: rule.ops, reason: rule.reason, base: root, source: { kind: 'standing' as const } }] : []))
}

// The standing policy sentences, for the judge.
export const standingPolicy = (rules: readonly LongLivedRule[]): string[] => rules.flatMap(rule => (rule.kind === 'policy' ? [rule.text] : []))

const objectOf = (value: unknown): SettingsObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...(value as SettingsObject) } : {}

const isOurs = (entry: string) => entry.startsWith(RULE_MARKER) || RETIRED_MARKERS.some(marker => entry.startsWith(marker))

// Replaces every entry sidekick wrote before (the deny strings it recorded,
// and every marked auto-mode entry) with the current rules' entries. Auto-mode
// sections replace the built-in rules unless "$defaults" is listed, so a
// section sidekick adds to keeps it; one left with only "$defaults" is removed.
export function syncRules(settings: SettingsObject, previousDeny: readonly string[], entries: { deny: string[]; softDeny: string[] }): SettingsObject {
  const next = { ...settings }

  const permissions = objectOf(next.permissions)
  const deny = stringList(permissions.deny).filter(rule => !previousDeny.includes(rule))
  const mergedDeny = [...deny, ...entries.deny.filter(rule => !deny.includes(rule))]
  if (mergedDeny.length > 0) permissions.deny = mergedDeny
  else delete permissions.deny
  if (Object.keys(permissions).length > 0) next.permissions = permissions
  else delete next.permissions

  const autoMode = objectOf(next.autoMode)
  for (const section of ['soft_deny', 'environment'] as const) {
    const kept = stringList(autoMode[section]).filter(entry => !isOurs(entry))
    const added = section === 'soft_deny' ? entries.softDeny : []
    // `$defaults` keeps Claude Code's own entries when sidekick creates the
    // section; a section the user wrote without it is left as they meant it.
    const merged = added.length > 0 && kept.length === 0 ? ['$defaults', ...added] : [...kept, ...added]
    if (merged.length === 0 || (merged.length === 1 && merged[0] === '$defaults')) delete autoMode[section]
    else autoMode[section] = merged
  }
  if (Object.keys(autoMode).length > 0) next.autoMode = autoMode
  else delete next.autoMode
  return next
}

// A leading byte-order mark (Windows editors write one) is not JSON: dropped.
export function parseSettingsText(text: string | undefined): SettingsObject {
  const json = text?.replace(/^﻿/, '')
  if (json === undefined || json.trim() === '') return {}
  return objectOf(JSON.parse(json) as unknown)
}

// The exclusive partner a scope change would collide with, if any.
export function exclusiveConflict(rules: readonly LongLivedRule[], scopeFolders: readonly string[], adding: string): LongLivedRule | undefined {
  return rules.find(rule => {
    if (rule.kind !== 'exclusive') return false
    const [first, second] = rule.folders
    const touches = (folder: string) => scopeFolders.some(scope => scope === folder || scope.startsWith(`${folder}/`) || folder.startsWith(`${scope}/`))
    const addsTo = (folder: string) => adding === folder || adding.startsWith(`${folder}/`) || folder.startsWith(`${adding}/`)
    return (addsTo(first) && touches(second)) || (addsTo(second) && touches(first))
  })
}
