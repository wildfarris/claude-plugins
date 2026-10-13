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
  // The court's glyph tally of each order's tool calls (tally.ts).
  isTallyShown: boolean
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

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
  }
}
