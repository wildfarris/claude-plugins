import type { PluginOptions } from 'claude-code'

import type { AdvisorId } from '../types'
import { memberId } from './members'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type CouncilSettings = {
  briefModel: string
  advisorModel: string
  advisorEffort: Effort
  // Brain trust (/council deep): every call on this model and effort.
  deepModel: string
  deepEffort: Effort
  // Court mode's triage of each prompt.
  triageModel: string
  // The member who reviews an approved plan's conditions (keeps or drops
  // each); null for none. It must also be seated, which is checked when the
  // council rules (court.ts arbiterSeat).
  arbiter: AdvisorId | null
  // The road's work sites and tents (tally.ts, sprites.ts roadSvg).
  isTallyShown: boolean
  // What each order level (1 to 3) runs on, per role: index 0 is level 1.
  scoutLevels: ModelEffort[]
  knightLevels: ModelEffort[]
  // The advisor agent (council:advisor): [plain, deep]. Not the members'
  // model (advisorModel), which is a plain model call.
  advisorAgentLevels: ModelEffort[]
  // A ruling on orders may summon one advisor agent when members ask a CHECK.
  isSummonsOn: boolean
}

// One level's model (an alias such as sonnet, or a full id) and effort.
export type ModelEffort = { model: string; effort: Effort }

export const DEFAULT_SCOUT_LEVELS = 'haiku:low,haiku:high,sonnet:medium'
export const DEFAULT_KNIGHT_LEVELS = 'sonnet:medium,opus:low,opus:high'
export const DEFAULT_ADVISOR_AGENT_LEVELS = 'opus:low,opus:high'

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// `model:effort` entries, comma-separated, exactly `count` of them; undefined
// when any entry is malformed (an empty or odd model name, an unknown effort).
export function parseModelEfforts(text: unknown, count: number): ModelEffort[] | undefined {
  if (typeof text !== 'string') return undefined
  const entries = text.split(',').map(entry => entry.trim())
  if (entries.length !== count) return undefined
  const parsed = entries.map(entry => {
    const colon = entry.lastIndexOf(':')
    if (colon <= 0) return undefined
    const model = entry.slice(0, colon).trim()
    const effort = EFFORTS.find(candidate => candidate === entry.slice(colon + 1).trim().toLowerCase())
    return effort !== undefined && /^[A-Za-z0-9][\w.\-[\]/@]*$/.test(model) ? { model, effort } : undefined
  })
  return parsed.every((entry): entry is ModelEffort => entry !== undefined) ? parsed : undefined
}

const levelsOption = (value: unknown, fallback: string, count: number) => parseModelEfforts(value, count) ?? parseModelEfforts(fallback, count)!

const textOption = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
const effortOption = (value: unknown, fallback: Effort) => EFFORTS.find(effort => effort === value) ?? fallback
const booleanOption = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)
// A member id, read as a member file's name gives it ("Hand" or "hand.md" is
// hand); null when unset or when nothing of an id is left.
const memberOption = (value: unknown): AdvisorId | null => (typeof value === 'string' && memberId(value.trim()) !== '' ? memberId(value.trim()) : null)

// The engine validates options against plugin.json's userConfig and fills in
// defaults; this re-checks so a test or a hand-edited settings file can't
// hand the hooks an out-of-range value.
export function readSettings(options: PluginOptions): CouncilSettings {
  return {
    briefModel: textOption(options.briefModel, 'opus'),
    advisorModel: textOption(options.advisorModel, 'sonnet'),
    advisorEffort: effortOption(options.advisorEffort, 'low'),
    deepModel: textOption(options.deepModel, 'opus'),
    deepEffort: effortOption(options.deepEffort, 'high'),
    triageModel: textOption(options.triageModel, 'haiku'),
    arbiter: memberOption(options.arbiter),
    isTallyShown: booleanOption(options.callTally, true),
    scoutLevels: levelsOption(options.scoutLevels, DEFAULT_SCOUT_LEVELS, 3),
    knightLevels: levelsOption(options.knightLevels, DEFAULT_KNIGHT_LEVELS, 3),
    advisorAgentLevels: levelsOption(options.advisorAgentLevels, DEFAULT_ADVISOR_AGENT_LEVELS, 2),
    isSummonsOn: booleanOption(options.councilSummons, true),
  }
}
