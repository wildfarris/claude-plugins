import type { PluginOptions } from 'claude-code'

export type NoteLength = 'brief' | 'standard' | 'detailed'

// Whose shell commands the policy judge reads: every session's, subagents' only, or none.
export type PolicyJudgeMode = 'all' | 'agents' | 'off'
const POLICY_JUDGE_MODES: readonly PolicyJudgeMode[] = ['all', 'agents', 'off']

export type SidekickSettings = {
  model: string
  isReplayEnabled: boolean
  isSummaryEnabled: boolean
  isHeadsUpEnabled: boolean
  noteLength: NoteLength
  focusTopics: string
  ignoreTopics: string
  isScopeGuardEnabled: boolean
  policyJudge: PolicyJudgeMode
  judgeBudgetAgent: number
  judgeBudgetSession: number
  judgeMaxSegments: number
  classifierUsageCap: number
  isResumeWarningEnabled: boolean
  isRuleSuggestionsEnabled: boolean
  isTrimEnabled: boolean
  isContextReadoutEnabled: boolean
  isCouncilButtonEnabled: boolean
  isAskToolsEnabled: boolean
  isInlineCodeBanEnabled: boolean
  trimAtPercent: number
  trimTargetPercent: number
  trimKeepTurns: number
}

export const DEFAULT_MODEL = 'claude-haiku-5-5'

const NOTE_LENGTHS: readonly NoteLength[] = ['brief', 'standard', 'detailed']

const booleanOption = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)

const integerOption = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback

const textOption = (value: unknown, fallback = '') => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)

const pickOption = <T extends string>(choices: readonly T[], value: unknown, fallback: T): T =>
  choices.find(choice => choice === value) ?? fallback

// The engine validates options against plugin.json's userConfig and fills in
// defaults; this re-checks so a test or a hand-edited settings file can't
// hand the hooks an out-of-range value.
export function readSettings(options: PluginOptions): SidekickSettings {
  return {
    model: textOption(options.model, DEFAULT_MODEL),
    isReplayEnabled: booleanOption(options.replayEnabled, true),
    isSummaryEnabled: booleanOption(options.summaryEnabled, true),
    isHeadsUpEnabled: booleanOption(options.headsUpEnabled, true),
    noteLength: pickOption(NOTE_LENGTHS, options.noteLength, 'brief'),
    focusTopics: textOption(options.focusTopics),
    ignoreTopics: textOption(options.ignoreTopics),
    isScopeGuardEnabled: booleanOption(options.scopeGuardEnabled, true),
    policyJudge: pickOption(POLICY_JUDGE_MODES, options.policyJudge, 'all'),
    judgeBudgetAgent: integerOption(options.judgeBudgetAgent, 300, 0, 100_000),
    judgeBudgetSession: integerOption(options.judgeBudgetSession, 1000, 0, 100_000),
    judgeMaxSegments: integerOption(options.judgeMaxSegments, 4, 1, 20),
    classifierUsageCap: integerOption(options.classifierUsageCap, 90, 0, 100),
    isResumeWarningEnabled: booleanOption(options.resumeWarningEnabled, true),
    isRuleSuggestionsEnabled: booleanOption(options.ruleSuggestionsEnabled, true),
    isTrimEnabled: booleanOption(options.trimEnabled, true),
    isContextReadoutEnabled: booleanOption(options.contextReadoutEnabled, true),
    isCouncilButtonEnabled: booleanOption(options.councilButtonEnabled, true),
    isAskToolsEnabled: booleanOption(options.askToolsEnabled, true),
    isInlineCodeBanEnabled: booleanOption(options.inlineCodeBanEnabled, true),
    trimAtPercent: integerOption(options.trimAtPercent, 80, 50, 99),
    trimTargetPercent: integerOption(options.trimTargetPercent, 50, 10, 90),
    trimKeepTurns: integerOption(options.trimKeepTurns, 1, 1, 10),
  }
}
