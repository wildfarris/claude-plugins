// Council members: the five built-ins, plus member files that add members or
// replace a built-in by id. Pure: parses member files and decides who sits;
// the hooks module finds and reads the files.
//
// A member file is markdown with a small header, e.g. ~/.claude/council/members/auditor.md:
//
//   ---
//   title: The Auditor
//   concern: Compliance
//   color: "#2a9d8f"
//   accessory: shield
//   references:
//     - ~/policies/data-retention.md
//     - ./soc2-controls.md
//   ---
//   compliance with our internal data-retention and SOC 2 controls: what is
//   logged, kept, or shared, and for how long
//
// The body is the remit: what the member weighs. The id is the file name.
// Reference paths are absolute, ~/…, or relative to the member file's folder.

import type { Accessory, AdvisorId, Seat } from '../types'
import { nativePath, parseAbsolute, pathStyleOf } from './paths'
import { ACCESSORIES, isHexColor } from './sprites'

export type MemberSource = 'built-in' | 'user' | 'project'

// A member as defined: a seat before its references are read.
export type MemberDefinition = Omit<Seat, 'references'> & { source: MemberSource; referencePaths: string[] }

// Each reference is trimmed to this, and a member's references to the total.
export const REFERENCE_LIMITS = { each: 4000, total: 8000 }

export const BUILT_IN_MEMBERS: readonly MemberDefinition[] = [
  {
    id: 'castellan',
    title: 'The Castellan',
    concern: 'Security',
    remit: 'security: secrets, tokens or keys leaking into code, logs, prompts or commits; injection of any kind (shell, SQL, prompt, path traversal); where untrusted input crosses a trust boundary and how it is checked; authentication, authorization, least privilege, and tokens or scopes broader than the job needs; sensitive or personal data exposed at rest, in transit or in URLs; supply-chain risk (unvetted, abandoned or look-alike packages, unpinned versions, install scripts); and destructive or irreversible operations without a backup or confirmation. A control counts only where it is a real boundary: extra layers that resolve to the same identity and operator add no security, so their absence is no cause for concern',
    color: '#4f86c6',
    accessory: 'shield',
  },
  {
    id: 'treasurer',
    title: 'The Lord Treasurer',
    concern: 'Money',
    remit: "money: metered spend (API and model tokens, per-request, storage and egress charges) and whether it has a ceiling; subscriptions, plan tiers and usage limits, and what breaks when a free tier ends or a quota runs out; infrastructure and hosting cost now and as use grows; lock-in that makes leaving expensive; and the time cost of the approach, in build effort and ongoing upkeep, against cheaper paths to the same result. Widely held judgements: an unbounded or metered cost with no ceiling is not acceptable; don't rent capacity that is already owned; don't depend on a paid-only tier; and back up only what is cheap to keep and painful to lose",
    color: '#2f9e5b',
    accessory: 'crown',
  },
  {
    id: 'seneschal',
    title: 'The Seneschal',
    concern: 'Reasonableness',
    remit: "reasonableness: whether the plan is proportionate to the goal and solves the problem actually asked; simpler or existing alternatives, including tools already in use; scope creep and unrequested extras; maintainability (how hard it will be to read, change and debug later, and whether it brings a dependency or pattern the codebase doesn't already have); hidden assumptions and failure modes; and whether it will actually work as described, with a way to verify that it does. Widely held judgements: take the platform's native path first; prefer one tool of each kind, used everywhere, over several that overlap; adopt a mature tool that fits most of the need and live with a small gap, building only when the gap matters; don't stack heavy frameworks; code a reviewer can't follow counts against a tool; test the contract or abstraction rather than every function; what nothing depends on can be rewritten freely, while change to what is in use is contained behind switches; known, rare nuisances can be lived with; and small third-party libraries likely to be abandoned are a liability",
    color: '#e0913a',
    accessory: 'none',
  },
  {
    id: 'justiciar',
    title: 'The High Justiciar',
    concern: 'Legal',
    remit: "legal: licenses for code, models, data and assets (copyleft obligations, compatibility, attribution and notices); the terms of service and acceptable-use rules of every service touched, including limits on scraping and automation; privacy and personal data (what is collected, kept, shared or sent across borders, consent and retention, under laws such as GDPR and CCPA); intellectual property, including copied or generated content; contracts and liability; and regulated areas such as payments, health or children's data. Relying on a grey area of a service's terms is a risk in itself",
    color: '#c0392b',
    accessory: 'standard',
  },
  {
    id: 'jester',
    title: 'The Court Jester',
    concern: 'Vibes',
    remit: 'vibes: how this will feel to build, use and live with day to day; whether it is delightful or a slog, elegant or a pile of workarounds; friction, confusing names or flows, and what will grate on the hundredth use; whether the person will still like it in six months; and the gut-level red flags, awkward truths and elephants in the room nobody else will say out loud',
    color: '#8e44ad',
    accessory: 'antenna',
  },
].map(member => ({ ...member, accessory: member.accessory as Accessory, source: 'built-in' as const, referencePaths: [] }))

// The built-ins as seats (no references): what an old council had.
export const BUILT_IN_SEATS: readonly Seat[] = BUILT_IN_MEMBERS.map(({ source: _source, referencePaths: _paths, ...seat }) => ({ ...seat, references: [] }))

// A member's id: its file name, lowercased, letters and digits joined by dashes.
export function memberId(fileName: string): AdvisorId {
  return fileName
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// For new members without a color: steady, distinct, readable on the plaque.
const SPARE_COLORS = ['#2a9d8f', '#d4a017', '#5c7cfa', '#e76f51', '#6a994e', '#b5838d', '#457b9d', '#9c6644']

const expandColor = (color: string) => (color.length === 4 ? `#${color.slice(1).replace(/./g, digit => digit + digit)}` : color).toLowerCase()

const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/, '$2')

// The header's fields: `key: value` lines and `- item` lists under a key.
// (The profile file's header is read the same way: profile.ts.)
export function parseHeader(lines: readonly string[]): Record<string, string | string[]> {
  const fields: Record<string, string | string[]> = {}
  let listKey: string | undefined
  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && listKey !== undefined) {
      const list = fields[listKey]
      fields[listKey] = [...(Array.isArray(list) ? list : []), unquote(item[1]!)]
      continue
    }
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!pair) continue
    const key = pair[1]!.toLowerCase()
    const value = unquote(pair[2]!)
    if (value === '') {
      listKey = key
      fields[key] = []
    } else {
      listKey = undefined
      fields[key] = value
    }
  }
  return fields
}

export type ParsedMember = { member: MemberDefinition } | { problem: string }

// One member file. `base` is the built-in it replaces, if its id matches one:
// fields the file leaves out come from it.
export function parseMemberFile(fileName: string, text: string, source: 'user' | 'project', base: MemberDefinition | undefined, spareIndex: number): ParsedMember {
  const id = memberId(fileName)
  if (id === '') return { problem: `${fileName}: the file name gives no id` }
  // A leading byte-order mark (Windows editors write one) would hide the header.
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text.replace(/^﻿/, '').replace(/\r\n/g, '\n'))
  const header = match ? parseHeader(match[1]!.split('\n')) : {}
  const remit = (match ? match[2]! : text).trim().replace(/\s+/g, ' ')
  const field = (key: string) => (typeof header[key] === 'string' ? (header[key] as string).trim() : undefined)
  const title = field('title') ?? base?.title
  if (title === undefined || title === '') return { problem: `${fileName}: needs a title in its header` }
  const finalRemit = remit !== '' ? remit : base?.remit
  if (finalRemit === undefined) return { problem: `${fileName}: needs a remit (the text below the header)` }
  const color = field('color')
  const accessory = field('accessory')
  if (color !== undefined && !isHexColor(color)) return { problem: `${fileName}: color must be #rgb or #rrggbb` }
  if (accessory !== undefined && !ACCESSORIES.includes(accessory as Accessory)) return { problem: `${fileName}: accessory must be one of ${ACCESSORIES.join(', ')}` }
  const references = header.references
  return {
    member: {
      id,
      title,
      concern: field('concern') ?? base?.concern ?? title.replace(/^the\s+/i, ''),
      remit: finalRemit,
      color: color !== undefined ? expandColor(color) : (base?.color ?? SPARE_COLORS[spareIndex % SPARE_COLORS.length]!),
      accessory: (accessory as Accessory | undefined) ?? base?.accessory ?? 'none',
      source,
      referencePaths: Array.isArray(references) ? references : typeof references === 'string' ? [references] : [],
    },
  }
}

// A reference path as written, resolved: absolute, ~/…, or relative to the
// member file's folder, `..` resolved, in the platform's own spelling. On
// Windows (the member folder's style) `C:\…`, `C:/…`, `~\…` and backslashes
// work too. Undefined when it can't be placed (`~user/…`, a variable, a
// drive-relative `C:x`, or a drive-less `\x` on Windows).
export function resolveReference(path: string, memberFolder: string, home: string): string | undefined {
  const style = pathStyleOf(memberFolder)
  const isSeparator = (character: string | undefined) => character === '/' || (style === 'windows' && character === '\\')
  if (path.includes('$') || (path.startsWith('~') && !isSeparator(path[1]))) return undefined
  const isAbsolute = style === 'windows' ? /^([A-Za-z]:|[\\/])/.test(path) : path.startsWith('/')
  const absolute = path.startsWith('~') ? `${home}/${path.slice(2)}` : isAbsolute ? path : `${memberFolder}/${path}`
  const parsed = parseAbsolute(absolute, style)
  return parsed === undefined ? undefined : nativePath(parsed)
}

// The references' text within the limits, in order; a reference that doesn't
// fit is cut, and the ones after it are left out with a note.
export function trimReferences(read: ReadonlyArray<{ source: string; text: string }>): Seat['references'] {
  const kept: Seat['references'] = []
  let used = 0
  for (const [index, reference] of read.entries()) {
    const room = Math.min(REFERENCE_LIMITS.each, REFERENCE_LIMITS.total - used)
    if (room <= 200) {
      kept.push({ source: `${read.length - index} more`, text: '(left out: the references exceed what one member is given)' })
      break
    }
    const text = reference.text.length > room ? `${reference.text.slice(0, room)}\n… (cut at ${room} characters)` : reference.text
    kept.push({ source: reference.source, text })
    used += Math.min(reference.text.length, room)
  }
  return kept
}

// Everyone this project could seat: built-ins, replaced or joined by user
// member files, then by project member files (the most specific wins).
export function mergeMembers(userMembers: readonly MemberDefinition[], projectMembers: readonly MemberDefinition[]): MemberDefinition[] {
  const byId = new Map<AdvisorId, MemberDefinition>()
  for (const member of [...BUILT_IN_MEMBERS, ...userMembers, ...projectMembers]) byId.set(member.id, member)
  return [...byId.values()]
}

// Who sits: everyone not turned off for this project, in order.
export const seatedMembers = (members: readonly MemberDefinition[], off: readonly AdvisorId[]) => members.filter(member => !off.includes(member.id))

export const MAX_SEATS = 8
