// The docket view: this project's recorded sittings, newest first, one line
// each, filtered by kind; an entry opens to every member's vote. Pure: drawn
// from the surface's element table, plain data and callbacks. Shares the
// chamber's vocabulary (views/council.tsx).

import type { ElementTable } from 'claude-code'

import type { DocketEntry, DocketFilter, DocketView, DocketVote } from '../../types'
import { DOCKET_FILTERS, DOCKET_LIMITS, KIND_GLYPH, KIND_LABEL, entryTime, entryTitle, gravestVote, outcomeColor } from '../docket'
import { concernMeter } from '../council'

export type DocketViewProps = {
  view: DocketView
  onFilter: (filter: DocketFilter) => unknown
  onToggle: (id: string) => unknown
  // Older entries, and back toward the newest.
  onMore: () => unknown
  onLess: () => unknown
  onClose: () => unknown
}

const projectName = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path

const concernTheme = (concern: number) => (concern >= 4 ? 'error' : concern === 3 ? 'warning' : 'success')

const shortTitle = (title: string) => title.replace(/^The /, '')

// One member's vote: its title, concern and verdict, then its detail, pick,
// level ratings and check.
function voteLines(el: ElementTable, entry: DocketEntry, vote: DocketVote) {
  const { Box, Text } = el
  const key = `docket-vote-${entry.id}-${vote.id}`
  const head =
    vote.status === 'done'
      ? `${shortTitle(vote.title)} ${concernMeter(vote.concern)} ${vote.verdict}`
      : vote.status === 'abstained'
        ? `${shortTitle(vote.title)} abstains: ${vote.verdict}`
        : `${shortTitle(vote.title)} gave no verdict${vote.verdict ? ` (${vote.verdict})` : ''}`
  const extras = [
    ...(typeof vote.choice === 'number' ? [vote.choice === 0 ? 'picks none' : `picks ${vote.choice}`] : []),
    ...(vote.levels && vote.levels.length > 0 ? [`levels ${vote.levels.map(level => level ?? '–').join(', ')}`] : []),
  ]
  return (
    <Box key={key} flexDirection="column">
      <Text color={vote.status === 'done' ? concernTheme(vote.concern) : undefined} dimColor={vote.status !== 'done'} wrap="wrap">
        {head}
      </Text>
      {vote.detail !== '' && (
        <Box paddingLeft={2}>
          <Text dimColor wrap="wrap">
            {vote.detail}
          </Text>
        </Box>
      )}
      {extras.length > 0 && (
        <Box paddingLeft={2}>
          <Text color="suggestion">{extras.join(' · ')}</Text>
        </Box>
      )}
      {vote.check !== undefined && (
        <Box paddingLeft={2}>
          <Text dimColor italic wrap="wrap">
            {`check: ${vote.check}`}
          </Text>
        </Box>
      )}
    </Box>
  )
}

// An entry opened in full: what was asked, every vote, and how it ended.
function entryDetail(el: ElementTable, entry: DocketEntry) {
  const { Box, Text } = el
  const line = (key: string, text: string, props: Record<string, unknown> = { dimColor: true }) => (
    <Text key={`docket-${key}-${entry.id}`} wrap="wrap" {...props}>
      {text}
    </Text>
  )
  const outcomeLine = [
    `${KIND_LABEL[entry.kind]} · ${entry.outcome}`,
    ...(entry.tally ? [`gravest ${entry.tally.gravest}/5`] : []),
    ...(entry.threshold !== undefined ? [`conditions from ${entry.threshold}`] : []),
    ...(entry.strictness ? [`strictness ${entry.strictness > 0 ? '+' : ''}${entry.strictness}`] : []),
    ...(entry.isDeep ? ['brain trust'] : []),
    ...(entry.by ? [`by ${entry.by === 'person' ? 'you' : 'Claude'}`] : []),
  ].join(' · ')
  return (
    <Box key={`docket-detail-${entry.id}`} flexDirection="column" borderStyle="quote" borderColor={outcomeColor(entry.outcome) ?? 'inactive'} paddingLeft={1} rowGap={0}>
      {line('outcome', outcomeLine, { bold: true, color: outcomeColor(entry.outcome) })}
      {entry.question !== undefined && line('question', entry.question, {})}
      {entry.plan !== undefined && line('plan', entry.plan, {})}
      {(entry.options ?? []).map((option, index) => line(`option-${index}`, `${index + 1}. ${option}${entry.tally?.picks ? ` (${entry.tally.picks[index] ?? 0})` : ''}`))}
      {(entry.dispatches ?? []).map((dispatch, index) =>
        line(`dispatch-${index}`, `${index + 1}. ${dispatch.role} in ${dispatch.folder}/${dispatch.leave && dispatch.leave.length > 0 ? ` · leave: ${dispatch.leave.join(' · ')}` : ''}`),
      )}
      {(entry.folders ?? []).length > 0 && line('folders', `read ${entry.folders!.map(folder => `${folder}/`).join(', ')}`)}
      {(entry.votes ?? []).length > 0 && (
        <Box key={`docket-votes-${entry.id}`} flexDirection="column" marginTop={1}>
          {entry.votes!.map(vote => voteLines(el, entry, vote))}
        </Box>
      )}
      {entry.reason !== undefined && entry.reason !== '' && line('reason', `why: ${entry.reason}`, { color: 'error', dimColor: false })}
      {(entry.conditions ?? []).length > 0 && (
        <Box key={`docket-conditions-${entry.id}`} flexDirection="column" marginTop={1}>
          <Text bold dimColor>
            Conditions
          </Text>
          {entry.conditions!.map((condition, index) => line(`condition-${index}`, `· ${condition}`, {}))}
        </Box>
      )}
      {(entry.notes ?? []).length > 0 && (
        <Box key={`docket-notes-${entry.id}`} flexDirection="column" marginTop={1}>
          <Text bold dimColor>
            The arbiter
          </Text>
          {entry.notes!.map((note, index) => line(`note-${index}`, `· ${note}`))}
        </Box>
      )}
      {entry.findings !== undefined && (
        <Box key={`docket-findings-${entry.id}`} flexDirection="column" marginTop={1}>
          <Text bold dimColor>
            {`The advisor${entry.runId ? ` (${entry.runId})` : ''}`}
          </Text>
          {line('findings', entry.findings || 'No findings.')}
        </Box>
      )}
      {(entry.orderIds ?? []).length > 0 && line('orders', `orders: ${entry.orderIds!.join(', ')}`)}
      {entry.follows !== undefined && line('follows', `second round of ${entry.follows}`)}
      {line('id', `${entry.id} · ${entry.time}`)}
    </Box>
  )
}

// One entry's line: time, kind, what it was about, the outcome and the gravest concern.
function entryRow(el: ElementTable, entry: DocketEntry, isOpen: boolean, onToggle: (id: string) => unknown) {
  const { Box, Text, Button } = el
  const gravest = gravestVote(entry)
  return (
    <Box key={`docket-row-${entry.id}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{entryTime(entry)}</Text>
        <Text color="claude">{KIND_GLYPH[entry.kind]}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Button key={`docket-entry-${entry.id}`} label={`${isOpen ? '▾' : '▸'} ${entryTitle(entry)}`} plain onPress={() => onToggle(entry.id)} />
        </Box>
        <Text color={outcomeColor(entry.outcome)}>{entry.outcome}</Text>
        {gravest && <Text color={concernTheme(gravest.concern)}>{`${shortTitle(gravest.title).split(' ').pop()} ${gravest.concern}`}</Text>}
      </Box>
      {isOpen && entryDetail(el, entry)}
    </Box>
  )
}

export function docketView(el: ElementTable, props: DocketViewProps) {
  const { Box, Text, Button } = el
  const { view } = props
  const first = view.total === 0 ? 0 : view.offset + 1
  const last = Math.min(view.total, view.offset + view.entries.length)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text bold color="claude">
          {`⚜ Docket · ${projectName(view.project)}`}
        </Text>
        <Text dimColor>{view.total === 0 ? 'no sittings' : `${first}–${last} of ${view.total}`}</Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {DOCKET_FILTERS.map(filter => (
          <Button key={`docket-filter-${filter}`} label={filter} variant={view.filter === filter ? 'primary' : 'secondary'} onPress={() => props.onFilter(filter)} />
        ))}
      </Box>
      {view.error !== null && (
        <Text color="error" wrap="wrap">
          {view.error}
        </Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        {view.entries.length === 0 ? (
          <Text dimColor wrap="wrap">
            {view.filter === 'all' ? 'No sittings recorded in this project yet. Every consult, ruling and council you convene is kept here.' : `No ${view.filter} recorded in this project yet.`}
          </Text>
        ) : (
          view.entries.map(entry => entryRow(el, entry, view.openId === entry.id, props.onToggle))
        )}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
        {view.offset > 0 && <Button key="docket-less" label="less" variant="secondary" onPress={props.onLess} />}
        {view.offset + DOCKET_LIMITS.page < view.total && <Button key="docket-more" label="more" variant="secondary" onPress={props.onMore} />}
        <Button key="docket-close" label="done" variant="secondary" onPress={props.onClose} />
      </Box>
      <Text dimColor wrap="wrap">
        Kept on this machine, unencrypted, under ~/.claude/council/docket/: the last 2,000 sittings or 180 days.
      </Text>
    </Box>
  )
}
