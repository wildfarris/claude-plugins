// Long-lived rules: written into Claude Code's own settings so the built-in
// checks enforce them, while the scope guard handles each session's live
// scope. Pure: the caller reads and writes <root>/.claude/settings.local.json.
//
//   fence      "never edit <folder>": a permissions.deny rule, enforced by
//              Claude Code itself in every mode, with no model.
//   exclusive  "never <a> and <b> in the same session": enforced by the scope
//              guard (it depends on what the session already touches), and
//              written as an auto-mode sentence so the classifier knows it.

import { normalizePath, relativeTo } from './scope-guard'
import { stringList } from './values'

export const RULE_MARKER = '[sidekick rule]'
// The per-session push this replaced tagged its entries so; cleaned on sync.
const RETIRED_MARKERS = ['[sidekick scope]']

export type LongLivedRule = { kind: 'fence'; folder: string } | { kind: 'exclusive'; folders: [string, string] }

// Two spellings of an absolute path in a permission rule; the caller checks
// which one the engine honors with $.tool.check.
export type PathRuleStyle = 'absolute' | 'project-relative'

type SettingsObject = Record<string, unknown>

export function ruleKey(rule: LongLivedRule): string {
  return rule.kind === 'fence' ? `fence ${rule.folder}` : `exclusive ${[...rule.folders].sort().join(' ')}`
}

export function describeRule(rule: LongLivedRule, root: string): string {
  const show = (folder: string) => `${relativeTo(root, folder)}/`
  return rule.kind === 'fence'
    ? `never edit ${show(rule.folder)}`
    : `never ${show(rule.folders[0])} and ${show(rule.folders[1])} in the same session`
}

// "fence other" or "exclusive api web", folders relative to the root.
export function parseRule(text: string, root: string): LongLivedRule | undefined {
  const [kind, ...names] = text.trim().replace(/^`|`$/g, '').split(/\s+/)
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
  return rule.kind === 'fence' ? `fence ${relativeTo(root, rule.folder)}` : `exclusive ${rule.folders.map(folder => relativeTo(root, folder)).join(' ')}`
}

export function isLongLivedRule(value: unknown): value is LongLivedRule {
  if (value === null || typeof value !== 'object') return false
  const rule = value as Record<string, unknown>
  if (rule.kind === 'fence') return typeof rule.folder === 'string'
  return rule.kind === 'exclusive' && Array.isArray(rule.folders) && rule.folders.length === 2 && rule.folders.every(folder => typeof folder === 'string')
}

function denyEntry(root: string, folder: string, style: PathRuleStyle): string {
  return style === 'absolute' ? `Edit(/${folder}/**)` : `Edit(/${relativeTo(root, folder)}/**)`
}

function softDenyEntry(rule: Extract<LongLivedRule, { kind: 'exclusive' }>, root: string): string {
  const [first, second] = rule.folders.map(folder => `${relativeTo(root, folder)}/`)
  return `${RULE_MARKER} Changing files in both ${first} and ${second} under ${root} within one session or task: they are separate projects the user keeps apart.`
}

export function builtInEntries(rules: readonly LongLivedRule[], root: string, style: PathRuleStyle): { deny: string[]; softDeny: string[] } {
  return {
    deny: rules.flatMap(rule => (rule.kind === 'fence' ? [denyEntry(root, rule.folder, style)] : [])),
    softDeny: rules.flatMap(rule => (rule.kind === 'exclusive' ? [softDenyEntry(rule, root)] : [])),
  }
}

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
