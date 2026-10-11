// What the bar shows: one item per feature, and the open item's panel. Pure:
// built from the session's state, the settings and a handlers object (the
// hooks module's closures over `$`). A new feature adds an item here.

import type { Bar, BarItemId, Brief, ContextReadout, HeadsUpNote, PendingBrief, Replay, ResumeWarning, RuleSuggestion, TrimOffer } from '../../types'
import { repoLine } from '../brief'
import { SPAN_LABELS } from '../ledger'
import { biggestGrowth, percentOf, readoutLabel } from '../context-readout'
import { councilStatus, type CouncilGlimpse } from '../council-glimpse'
import { estimateTokens, formatTokens } from '../values'
import { resumeWarningLines } from '../resume-warning'
import type { SidekickSettings } from '../settings'
import type { BarAction, BarItem, BarLine, BarModel, BarPanel, Handler } from './bar'

export type BarState = {
  bar: Bar
  replay: Replay
  warning: ResumeWarning | null
  note: HeadsUpNote | null
  brief: Brief | null
  pendingBrief: PendingBrief | null
  suggestion: RuleSuggestion | null
  trimOffer: TrimOffer | null
  context: ContextReadout
  // The council mod's state, as sidekick reads it; undefined when the council
  // mod isn't installed.
  council: CouncilGlimpse | null | undefined
}

export type BarHandlers = {
  toggle: (id: BarItemId) => unknown
  close: Handler
  summary: Handler
  toggleBriefDetail: Handler
  writeRepoHandoffs: Handler
  handoff: Handler
  handoffFromResume: Handler
  runPendingBrief: Handler
  cancelPendingBrief: Handler
  headsUp: Handler
  rule: Handler
  replay: Handler
  sendHeld: Handler
  editHeld: Handler
  releaseHeld: Handler
  askAboutNote: Handler
  knewNote: Handler
  dismissNote: Handler
  addRule: Handler
  laterRule: Handler
  neverRule: Handler
  clearBlocks: Handler
  fillTrim: Handler
  openContext: Handler
  askCouncil: Handler
  askBrainTrust: Handler
  reconsiderCouncil: Handler
  openChamber: Handler
}

type BarSettings = Pick<SidekickSettings, 'isSummaryEnabled' | 'isHeadsUpEnabled' | 'isRuleSuggestionsEnabled' | 'isReplayEnabled' | 'isContextReadoutEnabled' | 'isCouncilButtonEnabled'>

export function barModel(state: BarState, handlers: BarHandlers, settings: BarSettings): BarModel {
  const { bar, replay, warning, brief, pendingBrief, suggestion, trimOffer, context, council } = state
  const isResumeHeld = warning !== null && !warning.isAcknowledged
  const isBusy = (id: BarItemId) => bar.busy.includes(id)
  const items: BarItem[] = []

  if (isResumeHeld) items.push({ id: 'resume', label: 'Cold cache', hasDot: true, onPress: () => handlers.toggle('resume') })
  if (settings.isSummaryEnabled) {
    // A dot when the claims check found something, or a long brief waits for its go-ahead.
    const hasDot = (brief?.findings.length ?? 0) > 0 || pendingBrief !== null
    items.push({ id: 'tldr', label: 'TL;DR', isBusy: isBusy('tldr'), hasDot, onPress: handlers.summary })
  }
  if (settings.isHeadsUpEnabled) items.push({ id: 'headsUp', label: 'Heads up', isBusy: isBusy('headsUp'), onPress: handlers.headsUp })
  if (settings.isRuleSuggestionsEnabled && (bar.blockedCalls.length > 0 || suggestion !== null)) {
    items.push({ id: 'rule', label: `Rule? (${bar.blockedCalls.length} blocked)`, isBusy: isBusy('rule'), hasDot: suggestion !== null, onPress: handlers.rule })
  }
  if (settings.isReplayEnabled && replay.steps.length > 0) {
    const added = replay.steps.reduce((sum, step) => sum + step.addedCount, 0)
    const removed = replay.steps.reduce((sum, step) => sum + step.removedCount, 0)
    const count = replay.steps.length
    items.push({ id: 'replay', label: `▶ ${count} edit${count === 1 ? '' : 's'} +${added} −${removed}`, hasDot: !replay.isSeen, onPress: handlers.replay })
  }
  const contextLabel = settings.isContextReadoutEnabled ? readoutLabel(context) : null
  if (contextLabel !== null) items.push({ id: 'context', label: contextLabel, onPress: handlers.openContext })
  if (trimOffer !== null) items.push({ id: 'trim', label: `Trim → ~${trimOffer.projectedPercent}%`, hasDot: true, onPress: () => handlers.toggle('trim') })
  if (settings.isCouncilButtonEnabled && council !== undefined) {
    const isWorking = council?.phase === 'briefing' || council?.phase === 'deliberating'
    items.push({ id: 'council', label: '⚜ Council', isBusy: isWorking, onPress: () => handlers.toggle('council') })
  }

  // The resume warning has to be answered before the held prompt sends.
  const openId: BarItemId | null = isResumeHeld && warning.heldPrompt !== null ? 'resume' : bar.open
  return { items, openId, panel: openId === null ? undefined : barPanel(openId, state, handlers) }
}

const working = (text: string): BarLine[] => [{ text, isDim: true, isItalic: true }]

function barPanel(id: BarItemId, state: BarState, handlers: BarHandlers): BarPanel | undefined {
  const { bar, warning, note, suggestion, trimOffer, context, council } = state
  const notice = bar.notices[id]
  const close: BarAction = { key: `close-${id}`, label: '✕', onPress: handlers.close }

  switch (id) {
    case 'resume': {
      if (warning === null || warning.isAcknowledged) return undefined
      const { headline, detail } = resumeWarningLines(warning)
      const held = warning.heldPrompt
      return {
        accent: 'warning',
        title: 'Cold cache',
        lines: [{ text: headline }, { text: detail, isDim: true }, ...(held === null ? [] : [{ text: `held › ${held.replace(/\s+/g, ' ')}`, isDim: true, isItalic: true }])],
        actions: [
          ...(held === null
            ? []
            : [
                { key: 'send-held', label: 'send', isPrimary: true, onPress: handlers.sendHeld },
                { key: 'edit-held', label: 'edit', onPress: handlers.editHeld },
              ]),
          { key: 'dismiss-resume', label: "don't hold", onPress: handlers.releaseHeld },
          { key: 'handoff-resume', label: 'handoff to a new session', onPress: handlers.handoffFromResume },
        ],
      }
    }
    case 'tldr':
      return briefPanel(state, handlers, close)
    case 'headsUp':
      return {
        accent: 'claude',
        title: 'Heads up',
        lines: bar.busy.includes('headsUp')
          ? working('reviewing the last answer…')
          : note === null
            ? [{ text: notice ?? 'Nothing flagged yet.', isDim: true }]
            : [{ text: note.headline, isBold: true }, ...(note.detail ? [{ text: note.detail, isDim: true }] : [])],
        actions:
          note === null
            ? [close]
            : [
                { key: 'ask', label: 'ask Claude', onPress: handlers.askAboutNote },
                { key: 'known', label: 'knew it', onPress: handlers.knewNote },
                { key: 'dismiss', label: 'dismiss', onPress: handlers.dismissNote },
              ],
      }
    case 'context': {
      const percent = percentOf(context)
      if (percent === null || context.tokens === null) return undefined
      const grew = biggestGrowth(context, 3)
      return {
        accent: percent >= 80 ? 'warning' : 'suggestion',
        title: `Context ${percent}% full`,
        lines: [
          { text: `${formatTokens(context.tokens)} of ${formatTokens(context.window)}${context.lastDelta === null ? '' : ` · last turn ${context.lastDelta >= 0 ? '+' : ''}${formatTokens(context.lastDelta)}`}` },
          ...(context.breakdown === null
            ? [{ text: notice ?? 'reading the breakdown…', isDim: true, isItalic: true }]
            : context.breakdown.slice(0, 6).map(row => ({ text: `${formatTokens(row.tokens).padStart(6)}  ${row.name}`, isDim: true }))),
          ...(grew.length === 0 ? [] : [{ text: 'Grew it most:', isBold: true }, ...grew.map(entry => ({ text: `+${formatTokens(entry.delta)} · ${entry.prompt}`, isDim: true }))]),
        ],
        actions: [close],
      }
    }
    case 'council':
      if (council === undefined) return undefined
      return {
        accent: 'claude',
        title: '⚜ The Council',
        lines:
          council === null
            ? [{ text: 'Ask the council about this session, or review a repo: /council review <ref>.', isDim: true }]
            : [{ text: council.topic, isBold: true }, { text: councilStatus(council), isDim: true }],
        actions: [
          { key: 'ask-council', label: council === null ? 'ask the council' : 'ask anew', isPrimary: council === null, onPress: handlers.askCouncil },
          { key: 'ask-brain-trust', label: 'deep', onPress: handlers.askBrainTrust },
          ...(council?.phase === 'done' ? [{ key: 'reconsider-council', label: 'reconsider', isPrimary: true, onPress: handlers.reconsiderCouncil }] : []),
          ...(council === null ? [] : [{ key: 'open-chamber', label: 'open chamber', onPress: handlers.openChamber }]),
          close,
        ],
      }
    case 'trim':
      if (trimOffer === null) return undefined
      return {
        accent: 'warning',
        title: `Context ${trimOffer.currentPercent}% full`,
        lines: [
          { text: `A trim would bring it to about ${trimOffer.projectedPercent}% or less, with no summary.` },
          { text: `It replaces ${trimOffer.droppedCount} old tool outputs with one-line stubs (your answers, subagent reports and errors stay) and drops the reasoning from that point on; prompts, answers and the newest turn stay.`, isDim: true },
        ],
        actions: [
          { key: 'fill-trim', label: 'put /compact trim in the prompt', isPrimary: true, onPress: handlers.fillTrim },
          close,
        ],
      }
    case 'rule':
      if (bar.busy.includes('rule')) return { accent: 'permission', title: 'Rule?', lines: working('looking for a rule worth keeping…'), actions: [close] }
      if (suggestion !== null) {
        return {
          accent: 'permission',
          title: 'Rule?',
          lines: [{ text: suggestion.description, isBold: true }, ...(suggestion.reason ? [{ text: suggestion.reason, isDim: true }] : [])],
          actions: [
            { key: 'add-rule', label: 'add', isPrimary: true, onPress: handlers.addRule },
            { key: 'later-rule', label: 'not now', onPress: handlers.laterRule },
            { key: 'never-rule', label: 'never', onPress: handlers.neverRule },
          ],
        }
      }
      return {
        accent: 'permission',
        title: 'Rule?',
        lines: [...(notice ? [{ text: notice }] : []), ...bar.blockedCalls.map(call => ({ text: `blocked · ${call}`, isDim: true }))],
        actions: [
          { key: 'suggest-rule', label: 'suggest a rule', isPrimary: true, onPress: handlers.rule },
          { key: 'clear-blocks', label: 'clear', onPress: handlers.clearBlocks },
        ],
      }
    case 'replay':
      return undefined
  }
}

// The TL;DR: working, waiting for a go-ahead, the one-line TL;DR of a short
// turn, or the brief (done, stuck, needs you, the claims check; more shows
// the figures, phases and repos).
function briefPanel(state: BarState, handlers: BarHandlers, close: BarAction): BarPanel {
  const { bar, brief, pendingBrief } = state
  const notice = bar.notices.tldr
  if (bar.busy.includes('tldr')) return { accent: 'suggestion', title: 'TL;DR', lines: working('reading the record…'), actions: [close] }
  if (pendingBrief !== null) {
    return {
      accent: 'suggestion',
      title: `TL;DR · ${SPAN_LABELS[pendingBrief.span]}`,
      lines: [
        { text: `This needs ${pendingBrief.calls} Haiku calls over about ${formatTokens(estimateTokens(pendingBrief.characters))} tokens of the condensed record.` },
        ...(notice ? [{ text: notice, isDim: true }] : []),
      ],
      actions: [
        { key: 'run-brief', label: `run (${pendingBrief.calls} calls)`, isPrimary: true, onPress: handlers.runPendingBrief },
        { key: 'cancel-brief', label: 'cancel', onPress: handlers.cancelPendingBrief },
      ],
    }
  }
  const handoff: BarAction = { key: 'handoff', label: 'handoff', onPress: handlers.handoff }
  const noticeLines: BarLine[] = notice ? [{ text: notice, isDim: true }] : []
  if (brief === null) return { accent: 'suggestion', title: 'TL;DR', lines: [{ text: notice ?? 'No TL;DR yet.', isDim: true }], actions: [handoff, close] }
  if (brief.line !== null) return { accent: 'suggestion', title: 'TL;DR', lines: [{ text: brief.line }, ...noticeLines], actions: [handoff, close] }
  const labeled = (label: string, text: string | null): BarLine[] => (text === null ? [] : [{ text: `${label}: ${text}` }])
  const details: BarLine[] = brief.isExpanded
    ? [
        ...brief.stats.map(text => ({ text, isDim: true })),
        ...(brief.phases.length > 0 ? [{ text: 'Phases:', isBold: true }, ...brief.phases.map(text => ({ text: `  ${text}`, isDim: true }))] : []),
        ...(brief.repos.length > 0 ? [{ text: 'Repos:', isBold: true }, ...brief.repos.map(repo => ({ text: `  ${repoLine(repo)}`, isDim: true }))] : []),
        ...(brief.skippedNote ? [{ text: brief.skippedNote, isDim: true, isItalic: true }] : []),
      ]
    : []
  return {
    accent: brief.findings.length > 0 ? 'warning' : 'suggestion',
    title: `TL;DR · ${brief.label}`,
    lines: [
      ...labeled('Done', brief.done ?? '(not stated)'),
      ...labeled('Stuck', brief.stuck),
      ...labeled('Needs you', brief.needsYou),
      ...brief.findings.map(text => ({ text: `⚠ ${text}`, isBold: true })),
      ...details,
      ...noticeLines,
    ],
    actions: [
      { key: 'brief-detail', label: brief.isExpanded ? 'less' : 'more', onPress: handlers.toggleBriefDetail },
      handoff,
      ...(brief.repos.length > 0 ? [{ key: 'write-handoff', label: 'HANDOFF.md per repo', onPress: handlers.writeRepoHandoffs }] : []),
      close,
    ],
  }
}
