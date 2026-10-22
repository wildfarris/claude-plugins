// The court: the council in one strip on top, then one row per order, its
// agent walking a road toward the order's folder as its todos get done.
// Pure: drawn from the surface's element table, plain data and callbacks.
// Shares the chamber's vocabulary (views/council.tsx).

import type { ElementTable } from 'claude-code'

import type { AdvisorReport, AdvisorRun, Council, Court, Order, Seat } from '../../types'
import { seatsOf } from '../council'
import { isAdvisorFinished } from '../advisors'
import { currentTodo, isFinished, isFolded, levelLabel, progressOf } from '../court'
import { callsLabel } from '../tally'

export type CourtViewProps = {
  court: Court
  council: Council | null
  // The pane's width, to fit the advisor strip into equal cells.
  bodyColumns: number
  // The road for one order (an Svg or a Text, by surface).
  road: (order: Order) => unknown
  onChamber: () => unknown
  onToggleSession: () => unknown
  onClearFinished: () => unknown
  // The advisor whose verdict is open under the strip.
  openVerdictId: string | null
  onToggleVerdict: (id: string) => unknown
  // A small animated portrait (desktop), or null (terminal: names only).
  portrait: (seat: Seat, report: AdvisorReport) => unknown
  isFinishedShown: boolean
  onToggleFinished: () => unknown
  // The finished order whose full report is open.
  openOrderId: string | null
  onToggleOrder: (id: string) => unknown
}

const ROLE_TITLE = { scout: 'Scout', knight: 'Knight' } as const
const ROLE_GLYPH = { scout: '♟', knight: '♞' } as const

const concernColor = (concern: number) => (concern >= 4 ? 'error' : concern === 3 ? 'warning' : 'success')

// Newest first: by order number (O12 before O3).
const orderNumber = (order: Order) => Number(order.id.replace(/^\D+/, '')) || 0
const newestFirst = (left: Order, right: Order) => orderNumber(right) - orderNumber(left)

// The agent's report as plain text: markdown marks dropped, paragraphs kept.
const reportText = (order: Order) =>
  (order.report.trim() || (order.status === 'done' ? 'Back with no report.' : 'The agent stopped.'))
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')

// An order on the road: who and where, its progress on the right, the road,
// then what it is doing now.
function activeRow(el: ElementTable, order: Order, road: (order: Order) => unknown) {
  const { Box, Text } = el
  const { done, total } = progressOf(order)
  const calls = callsLabel(order.steps)
  const isWaiting = order.status === 'approved'
  const now = isWaiting ? 'approved · waiting to be dispatched' : (currentTodo(order) ?? (done === total ? 'wrapping up' : 'setting out'))
  return (
    <Box key={`order-${order.id}`} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" gap={1} flexShrink={1}>
          <Text bold wrap="truncate-end">{`${ROLE_GLYPH[order.role]} ${ROLE_TITLE[order.role]} · ${order.relFolder}/`}</Text>
          <Text dimColor>{order.id}</Text>
          <Text key={`order-level-${order.id}`} dimColor>{levelLabel(order)}</Text>
          {order.wakes !== undefined && <Text key={`order-woke-${order.id}`} color="warning">{order.wakes > 1 ? `woke ×${order.wakes}` : 'woke'}</Text>}
        </Box>
        <Text color={isWaiting ? 'inactive' : 'claude'}>{`${done}/${total}${order.edits > 0 ? ` · ${order.edits} edit${order.edits === 1 ? '' : 's'}` : ''}${calls === '' ? '' : ` · ${calls}`}`}</Text>
      </Box>
      {road(order)}
      <Text dimColor italic wrap="truncate-end">
        {now}
      </Text>
      {order.forbid && order.forbid.length > 0 && (
        <Text key={`order-forbid-${order.id}`} dimColor wrap="truncate-end">
          {`forbids ${order.forbid.map(rule => (rule.ops.length === 3 ? rule.glob : `${rule.glob} (${rule.ops.join(', ')})`)).join(' · ')}`}
        </Text>
      )}
      {order.warning && (
        <Text key={`order-warning-${order.id}`} color="warning" wrap="wrap">
          {`⚠ ${order.warning}`}
        </Text>
      )}
      {order.policy && order.policy.length > 0 && (
        <Text key={`order-policy-${order.id}`} dimColor wrap="truncate-end">
          {`rules: ${order.policy.join(' · ')}`}
        </Text>
      )}
    </Box>
  )
}

// An order that is back: one line with how it ended; pressed, its whole report.
// A withdrawn order has no report: its reason shows under it.
function finishedRow(el: ElementTable, order: Order, isOpen: boolean, onToggle: (id: string) => unknown) {
  const { Box, Text, Button } = el
  // Withdrawn before it was dispatched: greyed, with why instead of a report.
  if (order.status === 'withdrawn') {
    return (
      <Box key={`order-${order.id}`} flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text dimColor>⊘</Text>
          <Text dimColor wrap="truncate-end">{`${ROLE_TITLE[order.role]} · ${order.relFolder}/`}</Text>
          <Text dimColor>{order.id}</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text dimColor italic wrap="wrap">{`withdrawn · ${order.withdrawnReason ?? 'no reason given'}`}</Text>
        </Box>
      </Box>
    )
  }
  const isDone = order.status === 'done'
  const calls = callsLabel(order.steps)
  return (
    <Box key={`order-${order.id}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={isDone ? 'success' : 'error'}>{isDone ? '✓' : '✕'}</Text>
        <Button key={`order-toggle-${order.id}`} label={`${isOpen ? '▾' : '▸'} ${ROLE_TITLE[order.role]} · ${order.relFolder}/`} plain onPress={() => onToggle(order.id)} />
        <Text dimColor>{order.id}</Text>
        <Text key={`order-level-${order.id}`} dimColor>{levelLabel(order)}</Text>
        {order.wakes !== undefined && <Text key={`order-woke-${order.id}`} color="warning">woke</Text>}
        {calls !== '' && <Text dimColor>{calls}</Text>}
      </Box>
      {isOpen && (
        <Box flexDirection="column" paddingLeft={2} borderStyle="quote" borderColor={isDone ? 'success' : 'error'}>
          <Text wrap="wrap">{reportText(order)}</Text>
        </Box>
      )}
    </Box>
  )
}

const ADVISOR_STATUS: Record<AdvisorRun['status'], string> = { running: 'reading…', done: 'reported', failed: 'failed', 'timed-out': 'timed out' }

// An advisor agent: a bishop, where it reads, who sent it and what it was
// asked; once back, pressed, its whole report.
function advisorRow(el: ElementTable, run: AdvisorRun, isOpen: boolean, onToggle: (id: string) => unknown) {
  const { Box, Text, Button } = el
  const isBack = isAdvisorFinished(run)
  const color = run.status === 'running' ? 'claude' : run.status === 'done' ? 'success' : 'error'
  const where = `Advisor · ${run.relFolders.map(folder => `${folder}/`).join(', ')}`
  const sentBy = run.origin === 'owner' ? `sent by you${run.isDeep ? ' · deep' : ''}` : `summoned by ${[...new Set(run.questions.flatMap(entry => entry.askedBy))].join(', ')}`
  return (
    <Box key={`advisor-${run.id}`} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" gap={1} flexShrink={1}>
          <Text color={color}>♝</Text>
          {isBack ? (
            <Button key={`advisor-toggle-${run.id}`} label={`${isOpen ? '▾' : '▸'} ${where}`} plain onPress={() => onToggle(run.id)} />
          ) : (
            <Text bold wrap="truncate-end">
              {where}
            </Text>
          )}
          <Text dimColor>{run.id}</Text>
        </Box>
        <Text color={color}>{ADVISOR_STATUS[run.status]}</Text>
      </Box>
      <Text dimColor italic wrap="truncate-end">{`${sentBy} · ${run.model}, ${run.effort} effort`}</Text>
      {run.questions.map((entry, index) => (
        <Text key={`advisor-question-${run.id}-${index}`} dimColor wrap="wrap">
          {`${run.questions.length > 1 ? `${index + 1}. ` : '? '}${entry.question}`}
        </Text>
      ))}
      {isOpen && isBack && (
        <Box flexDirection="column" paddingLeft={2} borderStyle="quote" borderColor={color}>
          <Text wrap="wrap">{(run.report.trim() || (run.status === 'done' ? 'Back with no report.' : 'No report.')).replace(/\*\*|__|`/g, '').replace(/^#+\s*/gm, '')}</Text>
        </Box>
      )}
    </Box>
  )
}

function section(el: ElementTable, key: string, title: string, rows: unknown[]) {
  const { Box, Text } = el
  return (
    <Box key={key} flexDirection="column" rowGap={1} marginTop={1}>
      <Text bold dimColor>
        {title}
      </Text>
      {rows}
    </Box>
  )
}

export function courtView(el: ElementTable, props: CourtViewProps) {
  const { Box, Text, Button } = el
  const { court, council } = props
  const lastRuling = court.rulings[court.rulings.length - 1]
  // On the road (working, then waiting), back home, and the archive: each newest first.
  const active = court.orders.filter(order => !isFinished(order)).sort((left, right) => (left.status === right.status ? newestFirst(left, right) : left.status === 'dispatched' ? -1 : 1))
  const home = court.orders.filter(order => isFinished(order) && !isFolded(order)).sort(newestFirst)
  const archived = court.orders.filter(order => isFolded(order)).sort(newestFirst)
  // Advisors not yet folded away, newest first.
  const advisors = (court.advisors ?? []).filter(run => run.isFolded !== true).reverse()
  const hasFinished = home.length + archived.length > 0 || advisors.some(isAdvisorFinished)
  const seats = council ? seatsOf(council) : []
  const openSeat = seats.find(seat => seat.id === props.openVerdictId)
  const openReport = openSeat && council ? council.advisors[openSeat.id] : undefined
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text bold color="claude">
          ⚜ The Court
        </Text>
        <Text color={court.isInSession ? 'success' : undefined} dimColor={!court.isInSession}>
          {court.isInSession ? '● in session' : '○ court mode off'}
        </Text>
      </Box>
      {court.isInSession && <Text dimColor>prompts go to the council first</Text>}
      {council !== null && (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" flexWrap="wrap" rowGap={1}>
            {seats.map(seat => {
              const report = council.advisors[seat.id]
              const name = seat.title.replace(/^The /, '').split(' ').pop()
              const mark = report?.status === 'done' ? String(report.concern) : report?.status === 'abstained' ? '–' : '…'
              const isOpen = props.openVerdictId === seat.id
              // Equal cells, as many to a row as fit: the strip lines up in a grid.
              const perRow = Math.max(1, Math.min(seats.length, Math.floor(props.bodyColumns / 14)))
              return (
                <Box key={`seat-${seat.id}`} flexDirection="column" alignItems="center" width={`${Math.floor(100 / perRow)}%`}>
                  {report ? props.portrait(seat, report) : null}
                  <Button key={`verdict-${seat.id}`} label={`${name} ${mark}`} variant={isOpen ? 'primary' : 'secondary'} onPress={() => props.onToggleVerdict(seat.id)} />
                </Box>
              )
            })}
          </Box>
          {openSeat && openReport && (
            <Box flexDirection="column" borderStyle="quote" borderColor={openReport.status === 'done' ? concernColor(openReport.concern) : 'inactive'} paddingLeft={1}>
              <Text bold wrap="wrap">
                {openReport.status === 'done' ? `${openSeat.title} · ${openReport.concern}/5 · ${openReport.verdict}` : openReport.status === 'abstained' ? `${openSeat.title} abstains: ${openReport.verdict}` : `${openSeat.title}: no verdict yet`}
              </Text>
              {openReport.detail !== '' && (
                <Text dimColor wrap="wrap">
                  {openReport.detail}
                </Text>
              )}
            </Box>
          )}
        </Box>
      )}
      {(court.heldPrompt !== null || lastRuling) && (
        <Box flexDirection="column" marginTop={1}>
          {court.heldPrompt !== null && (
            <Text italic dimColor wrap="wrap">
              {`petition before the council: ${court.heldPrompt.replace(/\s+/g, ' ').slice(0, 120)}`}
            </Text>
          )}
          {lastRuling && (
            <Text color={lastRuling.isApproved ? 'success' : 'error'} wrap="wrap">
              {lastRuling.isApproved ? `Approved: ${lastRuling.plan}` : `Refused: ${lastRuling.plan}`}
            </Text>
          )}
          {lastRuling?.notes?.map((note, index) => (
            <Text key={`ruling-note-${index}`} dimColor wrap="wrap">
              {`· ${note}`}
            </Text>
          ))}
        </Box>
      )}
      {court.orders.length === 0 && advisors.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            No orders yet. Claude proposes dispatches with the council's propose_orders tool; approved ones appear here as roads.
          </Text>
        </Box>
      )}
      {advisors.length > 0 && section(el, 'section-advisors', `Advisors · ${advisors.length}`, advisors.map(run => advisorRow(el, run, props.openOrderId === run.id, props.onToggleOrder)))}
      {active.length > 0 && section(el, 'section-active', `On the road · ${active.length}`, active.map(order => activeRow(el, order, props.road)))}
      {home.length > 0 && section(el, 'section-home', `Back home · ${home.length}`, home.map(order => finishedRow(el, order, props.openOrderId === order.id, props.onToggleOrder)))}
      {archived.length > 0 && (
        <Box flexDirection="column" rowGap={1} marginTop={1}>
          <Button
            key="court-finished"
            label={`${props.isFinishedShown ? '▾' : '▸'} Archived · ${archived.length}`}
            plain
            dimColor
            onPress={props.onToggleFinished}
          />
          {props.isFinishedShown && archived.map(order => finishedRow(el, order, props.openOrderId === order.id, props.onToggleOrder))}
        </Box>
      )}
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
        <Button key="court-chamber" label="chamber" variant="primary" onPress={props.onChamber} />
        <Button key="court-session" label={court.isInSession ? 'end court mode' : 'court mode'} variant="secondary" onPress={props.onToggleSession} />
        {hasFinished && <Button key="court-clear" label="clear finished" variant="secondary" onPress={props.onClearFinished} />}
      </Box>
    </Box>
  )
}
