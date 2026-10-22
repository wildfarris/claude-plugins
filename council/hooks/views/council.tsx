// The council chamber: a header with the topic and progress, the herald's
// brief (collapsed to its first sentence), then one row per advisor with a
// short verdict; the exposition and any follow-up open on request.
// Pure: drawn from the surface's element table, plain data and callbacks.
//
// The vocabulary every council view shares: the title in the accent colour
// with a dim status beside it, one quote-bar block per secondary section,
// primary buttons at full strength and secondary ones dim, and theme keys
// only, so it follows the person's light or dark theme.

import type { ElementTable, RenderSurface } from 'claude-code'

import type { AdvisorId, AdvisorReport, Council, Roster, Seat } from '../../types'
import { briefHeadline, concernMeter, seatsOf, type Advisor } from '../council'
import { RASTER_COLUMNS, RASTER_ROWS, animatedSvg, moodFor, rasterCells, spriteFrame } from '../sprites'

// An advisor's portrait: half-block cells the terminal repaints by key, or an
// animated SVG elsewhere (Raster is the terminal's element, Svg the others').
export function portraitFor(table: ElementTable, surface: RenderSurface, seat: Seat, report: AdvisorReport, council: Council, tick: number) {
  const elements = table as unknown as Record<string, ((props: Record<string, unknown>) => unknown) | undefined>
  const mood = moodFor(report, council.phase)
  const { id } = seat
  if (surface === 'terminal' && elements.Raster) {
    return elements.Raster({ key: `sprite-${id}`, columns: RASTER_COLUMNS, rows: RASTER_ROWS, cells: rasterCells(spriteFrame(seat, mood, tick)) })
  }
  return elements.Svg ? elements.Svg({ key: `svg-${id}-${mood}`, source: animatedSvg(seat, mood), alt: `${seat.title}, ${mood}`, width: 80, height: 88, isInteractive: true }) : null
}

export type CouncilViewProps = {
  council: Council
  bodyColumns: number
  // The rows the pane gives its body: compact rows spend what is left on detail.
  bodyRows?: number
  // The terminal: where cards don't fit side by side, each seat is a compact
  // row instead (a desktop's stacked cards scroll, and stay as they are).
  isTerminal?: boolean
  portrait: (seat: Seat, report: AdvisorReport) => unknown
  onToggleBrief: () => unknown
  onToggleAdvisor: (id: AdvisorId) => unknown
  // A compact row pressed: opens that seat's card (portrait and full detail)
  // and closes any other, or closes it when it was open.
  onOpenAdvisor?: (id: AdvisorId) => unknown
  onAsk: (id: AdvisorId) => unknown
  // Puts `/council reconsider ` in front of the prompt box's draft.
  onReconsider: () => unknown
  // The same as a brain trust, and a new brain trust question.
  onReconsiderDeep?: () => unknown
  onAskDeep?: () => unknown
  // Writes a report of the council into the prompt box.
  onReport: () => unknown
  // Opens the members list.
  onMembers: () => unknown
  // Opens the lessons and guidance.
  onLessons?: () => unknown
  // Back to the court (when it has orders).
  onCourt?: () => unknown
  // Keyboard shortcuts (1–5, b): the terminal only. On the desktop a press on
  // a hotkeyed button went unhandled the first time.
  hasHotkeys: boolean
}

// Theme keys, so the chamber follows the person's light or dark theme.
const concernTheme = (report: AdvisorReport) =>
  report.status !== 'done' ? 'inactive' : report.concern >= 4 ? 'error' : report.concern === 3 ? 'warning' : 'success'

const STATUS_LINE: Record<AdvisorReport['status'], string> = {
  waiting: 'awaits the brief',
  deliberating: 'deliberating…',
  done: '',
  abstained: 'abstains',
  failed: 'fell silent',
}

const isFinished = (report: AdvisorReport | undefined) => report !== undefined && ['done', 'abstained', 'failed'].includes(report.status)

const shortTitle = (advisor: Advisor) => advisor.title.replace(/^The /, '')

// The phase as a mark and a word: a hollow dot while it moves, a full one
// once it has settled, in the colour the court's and the members' marks use.
function phaseMark(council: Council): { text: string; color: string } {
  const seats = seatsOf(council)
  const finished = seats.filter(advisor => isFinished(council.advisors[advisor.id])).length
  if (council.phase === 'briefing') return { text: '◌ briefing', color: 'suggestion' }
  if (council.phase === 'deliberating') return { text: `◌ ${finished}/${seats.length} in`, color: 'suggestion' }
  return council.phase === 'done' ? { text: '● adjourned', color: 'success' } : { text: '● dissolved', color: 'error' }
}

function advisorText(el: ElementTable, advisor: Advisor, report: AdvisorReport, hotkey: string | undefined, onToggle: () => unknown, onAsk: () => unknown) {
  const { Box, Text, Button } = el
  const isDone = report.status === 'done'
  const followUp = report.followUp
  // Abstained: one dim line, nothing to open.
  if (report.status === 'abstained') {
    return (
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <Text bold dimColor>
          {shortTitle(advisor)}
        </Text>
        <Text dimColor italic wrap="wrap">
          {`abstains: ${report.verdict}`}
        </Text>
      </Box>
    )
  }
  const hasMore = isDone && (report.detail !== '' || followUp !== null)
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text bold>{shortTitle(advisor)}</Text>
        {isDone ? (
          <Text color={concernTheme(report)}>{concernMeter(report.concern)}</Text>
        ) : (
          <Text dimColor italic>
            {STATUS_LINE[report.status]}
          </Text>
        )}
        {isDone && typeof report.choice === 'number' && <Text color="suggestion">{report.choice === 0 ? 'picks none' : `picks ${report.choice}`}</Text>}
        {isDone && typeof report.previousConcern === 'number' && (
          <Text dimColor>{report.previousConcern === report.concern ? '(held)' : `(was ${report.previousConcern})`}</Text>
        )}
      </Box>
      {report.verdict !== '' && <Text wrap="wrap">{report.verdict}</Text>}
      {report.isExpanded && report.detail !== '' && (
        <Text dimColor wrap="wrap">
          {report.detail}
        </Text>
      )}
      {report.isExpanded && followUp !== null && (
        <Box flexDirection="column" borderStyle="quote" borderColor="suggestion" paddingLeft={1}>
          <Text italic dimColor wrap="wrap">
            {followUp.question}
          </Text>
          <Text wrap="wrap">{followUp.status === 'asking' ? 'considering…' : followUp.status === 'failed' ? '(no answer)' : followUp.answer}</Text>
        </Box>
      )}
      {isDone && (
        <Box flexDirection="row" gap={2}>
          {hasMore && <Button key={`more-${advisor.id}`} label={report.isExpanded ? 'less' : 'more'} hotkey={hotkey} plain dimColor onPress={onToggle} />}
          {followUp?.status !== 'asking' && <Button key={`ask-${advisor.id}`} label="ask" plain dimColor onPress={onAsk} />}
        </Box>
      )}
    </Box>
  )
}

// ── Compact rows ──────────────────────────────────────────────────────────

// Words wrapped to `width` columns, at most `max` lines; the last line ends
// in an ellipsis when the text runs on. A word longer than a line is cut.
export function wrapLines(text: string, width: number, max: number): string[] {
  if (max <= 0 || width <= 0) return []
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(word => word !== '')
  const lines: string[] = []
  let line = ''
  for (const raw of words) {
    let word = raw
    while (word.length > width) {
      if (line !== '') {
        lines.push(line)
        line = ''
      }
      lines.push(word.slice(0, width))
      word = word.slice(width)
    }
    if (word === '') continue
    if (line === '') line = word
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line !== '') lines.push(line)
  if (lines.length <= max) return lines
  const kept = lines.slice(0, max)
  const last = kept[max - 1]!
  kept[max - 1] = last.length + 1 <= width ? `${last}…` : `${last.slice(0, Math.max(0, width - 1))}…`
  return kept
}

// The rows a text takes at `width` (each of its lines wraps on its own).
const rowsOf = (text: string, width: number) => text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(1, width))), 0)

const blankReport = (): AdvisorReport => ({ status: 'waiting', concern: 0, verdict: '', detail: '', isExpanded: false, followUp: null, previousConcern: null })

type HeadPart = { text: string; color?: string; bold?: boolean; dim?: boolean; italic?: boolean }

// A seat's first line, before its verdict: the mark in the member's color,
// the title, the concern as pips (or the status), and how it moved or what
// it picked.
function rowHead(advisor: Advisor, report: AdvisorReport): HeadPart[] {
  const head: HeadPart[] = [
    { text: '■', color: advisor.color },
    { text: ` ${shortTitle(advisor)}`, bold: report.status !== 'abstained', dim: report.status === 'abstained' },
  ]
  if (report.status === 'done') {
    head.push({ text: ` ${concernMeter(report.concern)}`, color: concernTheme(report) })
    if (typeof report.previousConcern === 'number') head.push({ text: report.previousConcern === report.concern ? ' (held)' : ` (was ${report.previousConcern})`, dim: true })
    if (typeof report.choice === 'number') head.push({ text: report.choice === 0 ? ' picks none' : ` picks ${report.choice}`, color: 'suggestion' })
  } else if (report.status !== 'failed' || report.verdict === '') {
    // A silent member's own line ("Fell silent.", "Interrupted.") says it.
    head.push({ text: ` ${STATUS_LINE[report.status]}${report.status === 'abstained' ? ':' : ''}`, dim: true, italic: true })
  }
  return head
}

const verdictOf = (report: AdvisorReport) => (report.status === 'done' || report.status === 'failed' || report.status === 'abstained' ? report.verdict : '')
const headLength = (head: readonly HeadPart[]) => head.reduce((sum, part) => sum + part.text.length, 0)

// One seat on one row (two when its verdict needs a line of its own), then
// up to `detailLines` of its detail, so all of MAX_SEATS fit a 30-row pane.
// A press opens the seat's card: its portrait and the full detail.
function compactRow(el: ElementTable, advisor: Advisor, report: AdvisorReport, width: number, detailLines: number, hotkey: string | undefined, onOpen: () => unknown) {
  const { Box, Text, Button } = el
  const head = rowHead(advisor, report)
  const verdict = verdictOf(report)
  const isVerdictInline = verdict === '' || headLength(head) + 1 + verdict.length <= width
  const detail = report.status === 'done' ? wrapLines(report.detail, width - 2, detailLines) : []
  return (
    <Box key={`row-box-${advisor.id}`} flexDirection="column">
      <Button key={`row-${advisor.id}`} plain hotkey={hotkey} onPress={onOpen}>
        {head.map((part, index) => (
          <Text key={`head-${advisor.id}-${index}`} color={part.color} bold={part.bold} dimColor={part.dim} italic={part.italic}>
            {part.text}
          </Text>
        ))}
        {verdict !== '' && isVerdictInline && (
          <Text dimColor={report.status !== 'done'} italic={report.status === 'abstained'}>
            {` ${verdict}`}
          </Text>
        )}
      </Button>
      {verdict !== '' && !isVerdictInline && (
        <Box paddingLeft={2}>
          <Text wrap="truncate-end" dimColor={report.status !== 'done'} italic={report.status === 'abstained'}>
            {verdict}
          </Text>
        </Box>
      )}
      {detail.length > 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>{detail.join('\n')}</Text>
        </Box>
      )}
    </Box>
  )
}

// The footer's buttons, as the terminal draws them (`[ label ]`, two apart).
const FOOTER_LABELS = ['reconsider with more context', 'reconsider as a brain trust', 'ask the brain trust', 'report to Claude', 'members', 'lessons', 'court']

// How many lines of detail each compact row gets: what the body has left
// once everything else is drawn, shared among the seats with a detail, 0 to 2.
export function compactDetailLines(council: Council, bodyColumns: number, bodyRows: number): number {
  const width = Math.max(10, bodyColumns - 2)
  const seats = seatsOf(council)
  const topic = Math.min(2, rowsOf(council.topic, width))
  const options = council.options?.length ?? 0
  const herald = 2 + council.context.length
  const notice = council.notice ? rowsOf(council.notice, width) : 0
  const footerWidth = FOOTER_LABELS.reduce((sum, label) => sum + label.length + 6, 0)
  const footer = council.phase === 'done' ? 2 + Math.ceil(footerWidth / width) : 0
  const fixed = 1 + topic + options + herald + notice + 1 + footer
  let rows = 0
  let withDetail = 0
  for (const advisor of seats) {
    const report = council.advisors[advisor.id] ?? blankReport()
    const verdict = verdictOf(report)
    rows += verdict !== '' && headLength(rowHead(advisor, report)) + 1 + verdict.length > width ? 2 : 1
    if (report.status === 'done' && report.detail !== '') withDetail++
  }
  if (withDetail === 0) return 0
  return Math.max(0, Math.min(2, Math.floor((bodyRows - fixed - rows) / withDetail)))
}

export function councilView(el: ElementTable, props: CouncilViewProps) {
  const { Box, Text, Button } = el
  const { council } = props
  const seats = seatsOf(council)
  // Cards side by side only where each gets a readable column. Elsewhere the
  // terminal draws a compact row per seat (its card opens on a press), and
  // other surfaces stack the cards, the portrait beside the verdict.
  const isWide = props.bodyColumns >= seats.length * 22
  const isCompact = props.isTerminal === true && !isWide
  const width = Math.max(10, props.bodyColumns - 2)
  const detailLines = isCompact ? compactDetailLines(council, props.bodyColumns, props.bodyRows ?? 28) : 0

  const heraldText =
    council.phase === 'briefing'
      ? 'gathering the facts…'
      : council.brief === ''
        ? 'could not prepare a brief.'
        : council.isBriefExpanded
          ? council.brief
          : briefHeadline(council.brief)

  const cards = seats.map((advisor, position) => {
    const report = council.advisors[advisor.id] ?? blankReport()
    const hotkey = props.hasHotkeys ? String(position + 1) : undefined
    // A compact row stays a row until it is opened; an open one is the card.
    if (isCompact && !report.isExpanded) {
      return compactRow(el, advisor, report, width, detailLines, hotkey, () => (props.onOpenAdvisor ?? props.onToggleAdvisor)(advisor.id))
    }
    const text = advisorText(el, advisor, report, hotkey, () => props.onToggleAdvisor(advisor.id), () => props.onAsk(advisor.id))
    return isWide ? (
      <Box key={advisor.id} flexDirection="column" width={`${Math.floor(100 / seats.length)}%`} borderStyle="round" borderColor={concernTheme(report)} paddingX={1}>
        {props.portrait(advisor, report)}
        {text}
      </Box>
    ) : (
      <Box key={advisor.id} flexDirection="row" gap={1} borderStyle="quote" borderColor={concernTheme(report)} paddingLeft={1}>
        {props.portrait(advisor, report)}
        {text}
      </Box>
    )
  })

  const finished = seats.flatMap(advisor => {
    const report = council.advisors[advisor.id]
    return report?.status === 'done' ? [{ advisor, report }] : []
  })
  const gravest = [...finished].sort((left, right) => right.report.concern - left.report.concern)[0]
  const phase = phaseMark(council)

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text bold color="claude">
          {council.isDeep ? '⚜ The Brain Trust' : '⚜ The Council'}
        </Text>
        <Text color={phase.color}>{phase.text}</Text>
      </Box>
      <Text wrap="wrap">{isCompact ? wrapLines(council.topic, width, 2).join('\n') : council.topic}</Text>
      {council.options && council.options.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {council.options.map((option, index) => (
            <Text key={`option-${index}`} dimColor wrap={isCompact ? 'truncate-end' : 'wrap'}>
              {`${index + 1}. ${option}`}
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" borderStyle="quote" borderColor="inactive" paddingLeft={1} marginTop={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold dimColor>
            Herald
          </Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap={isCompact && !council.isBriefExpanded ? 'truncate-end' : 'wrap'}>
              {heraldText}
            </Text>
          </Box>
          {council.brief !== '' && (
            <Button key="toggle-brief" label={council.isBriefExpanded ? 'less' : 'brief'} hotkey={props.hasHotkeys ? 'b' : undefined} plain dimColor onPress={props.onToggleBrief} />
          )}
        </Box>
        {council.context.map((text, index) => (
          <Text key={`context-${index}`} italic color="suggestion" wrap={isCompact ? 'truncate-end' : 'wrap'}>
            {`+ ${text}`}
          </Text>
        ))}
      </Box>
      {council.notice && (
        <Text color="warning" italic wrap="wrap">
          {council.notice}
        </Text>
      )}
      <Box flexDirection={isWide ? 'row' : 'column'} rowGap={isWide || isCompact ? 0 : 1} marginTop={1}>
        {cards}
      </Box>
      {council.phase === 'done' && (
        <Box flexDirection="column" marginTop={1}>
          {gravest ? (
            <Text bold color={concernTheme(gravest.report)}>
              {`Gravest: ${shortTitle(gravest.advisor)} ${gravest.report.concern}/5`}
            </Text>
          ) : (
            <Text dimColor>Every advisor abstained.</Text>
          )}
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Button key="reconsider" label="reconsider with more context" variant="secondary" onPress={props.onReconsider} />
            {props.onReconsiderDeep && <Button key="reconsider-deep" label="reconsider as a brain trust" variant="secondary" onPress={props.onReconsiderDeep} />}
            {props.onAskDeep && <Button key="ask-deep" label="ask the brain trust" variant="secondary" onPress={props.onAskDeep} />}
            <Button key="report" label="report to Claude" variant="primary" onPress={props.onReport} />
            <Button key="members" label="members" variant="secondary" onPress={props.onMembers} />
            {props.onLessons && <Button key="lessons" label="lessons" variant="secondary" onPress={props.onLessons} />}
            {props.onCourt && <Button key="to-court" label="court" variant="secondary" onPress={props.onCourt} />}
          </Box>
        </Box>
      )}
    </Box>
  )
}

// ── The members list ──────────────────────────────────────────────────────

export type RosterViewProps = {
  roster: Roster
  onToggle: (id: AdvisorId) => unknown
  onClose: () => unknown
}

const SOURCE_LABEL = { 'built-in': 'built in', user: 'your member file', project: "this project's member file" } as const

// Who sits on this project's council: a switch per member (the same `● on` /
// `○ off` the commons sidebar uses), its concern, and where it comes from.
export function rosterView(el: ElementTable, props: RosterViewProps) {
  const { Box, Text, Button } = el
  const { roster } = props
  const seated = roster.entries.filter(entry => entry.isSeated).length
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text bold color="claude">
          ⚜ Members
        </Text>
        <Text dimColor>{`${seated} of ${roster.entries.length} seated`}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {roster.entries.map(entry => (
          <Box key={`member-${entry.id}`} flexDirection="row" gap={1}>
            <Button key={`seat-${entry.id}`} label={entry.isSeated ? '● on ' : '○ off'} plain dimColor={!entry.isSeated} onPress={() => props.onToggle(entry.id)} />
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={1}>
              <Text bold={entry.isSeated} dimColor={!entry.isSeated}>
                {entry.title}
              </Text>
              <Text dimColor>{`${entry.concern} · ${SOURCE_LABEL[entry.source]}`}</Text>
            </Box>
          </Box>
        ))}
      </Box>
      {roster.problems.map((problem, index) => (
        <Text key={`problem-${index}`} color="warning" wrap="wrap">
          {problem}
        </Text>
      ))}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor wrap="wrap">
          Seats apply to this project's next council. Add members as markdown files in ~/.claude/council/members/ or this project's .claude/council/members/.
        </Text>
        <Button key="close-members" label="done" variant="secondary" onPress={props.onClose} />
      </Box>
    </Box>
  )
}
