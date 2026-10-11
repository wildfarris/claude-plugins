import type { PluginOptions } from 'claude-code'

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
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const textOption = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
const effortOption = (value: unknown, fallback: Effort) => EFFORTS.find(effort => effort === value) ?? fallback

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
  }
}
