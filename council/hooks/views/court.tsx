// The court: the council in one strip on top, then one row per order, its
// agent walking a road toward the order's folder as its todos get done.
// Pure: drawn from the surface's element table, plain data and callbacks.
// Shares the chamber's vocabulary (views/council.tsx).

import type { ElementTable } from 'claude-code'

import type { AdvisorReport, Council, Court, Order, Seat } from '../../types'
import { beyondText, seatsOf } from '../council'
import { currentTodo, isFinished, isFolded, isLeavePending, leaveSummary, levelLabel, openTodos, progressOf } from '../court'
import { callsLabel } from '../tally'
import { tokensLabel } from '../usage'
import { touchedFiles } from '../control'

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
  // The person grants or denies an order's pending leave (as /council grant
  // and /council deny-leave). Left out: no buttons, the command only.
  onGrantLeave?: (id: string) => unknown
  onDenyLeave?: (id: string) => unknown
  // Opens a ruling's docket entry. Left out: no button.
  onOpenDocket?: (id: string) => unknown
}

const ROLE_TITLE = { scout: 'Scout', knight: 'Knight' } as const
const ROLE_GLYPH = { scout: '♟', knight: '♞' } as const

const concernColor = (concern: number) => (concern >= 4 ? 'error' : concern === 3 ? 'warning' : 'success')

// Newest first: by order number (O12 before O3).
const orderNumber = (order: Order) => Number(order.id.replace(/^\D+/, '')) || 0
const newestFirst = (left: Order, right: Order) => orderNumber(right) - orderNumber(left)

// The agent's report as plain text: markdown marks dropped, paragraphs kept.
const reportText = (order: Order) =>
  (order.report.trim() || (order.status === 'done' ? 'Back with no report.' : order.status === 'lost' ? 'Its agent is gone; no report.' : 'The agent stopped.'))
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')

const AMENDMENT_WORD = { ruling: 'before the council', approved: 'approved', refused: 'refused' } as const

// What steered an order: its recall, Claude's amendments and the person's
// messages (the last three), one line each.
function steeringLines(el: ElementTable, order: Order) {
  const { Text } = el
  return [
    ...(order.recall
      ? [
          <Text key={`order-recall-${order.id}`} color="warning" wrap="truncate-end">
            {`⏏ recalled by ${order.recall.by === 'person' ? 'you' : 'Claude'}: ${order.recall.reason}`}
          </Text>,
        ]
      : []),
    ...(order.amendments ?? []).map((amendment, index) => (
      <Text key={`order-amendment-${order.id}-${index}`} color={amendment.status === 'refused' ? 'error' : amendment.status === 'approved' ? 'success' : undefined} dimColor={amendment.status === 'ruling'} wrap="truncate-end">
        {`✎ amendment ${AMENDMENT_WORD[amendment.status]}: ${amendment.change}${amendment.status === 'approved' && amendment.isDelivered === false ? ' · not delivered' : ''}`}
      </Text>
    )),
    ...(order.messages ?? []).slice(-3).map((message, index) => (
      <Text key={`order-message-${order.id}-${index}`} dimColor wrap="truncate-end">
        {`✉ you: ${message.text}${message.isDelivered ? '' : ` · not delivered${message.reason ? ` (${message.reason})` : ''}`}`}
      </Text>
    )),
  ]
}

type LeaveButtons = Pick<CourtViewProps, 'onGrantLeave' | 'onDenyLeave'>

// An order's leave and where it stands; while it waits for the person, an
// order not yet dispatched gets grant and deny buttons when the pane has them.
function leaveLines(el: ElementTable, order: Order, buttons: LeaveButtons = {}) {
  const { Box, Text, Button } = el
  const summary = leaveSummary(order)
  if (summary === undefined) return []
  const isPending = isLeavePending(order)
  const canRule = isPending && order.status === 'approved'
  return [
    <Text key={`order-leave-${order.id}`} color={isPending ? 'warning' : undefined} dimColor={!isPending} wrap="wrap">
      {summary}
    </Text>,
    ...(canRule && (buttons.onGrantLeave || buttons.onDenyLeave)
      ? [
          <Box key={`order-leave-buttons-${order.id}`} flexDirection="row" columnGap={2}>
            {buttons.onGrantLeave && <Button key={`order-grant-${order.id}`} label="grant leave" variant="primary" onPress={() => buttons.onGrantLeave!(order.id)} />}
            {buttons.onDenyLeave && <Button key={`order-deny-${order.id}`} label="deny leave" variant="secondary" onPress={() => buttons.onDenyLeave!(order.id)} />}
          </Box>,
        ]
      : []),
  ]
}

// An order on the road: who and where, its progress on the right, the road,
// then what it is doing now.
function activeRow(el: ElementTable, order: Order, road: (order: Order) => unknown, buttons: LeaveButtons = {}) {
  const { Box, Text } = el
  const { done, total } = progressOf(order)
  const calls = [callsLabel(order.steps), tokensLabel(order.usage)].filter(Boolean).join(' · ')
  const isWaiting = order.status === 'approved'
  const now = isWaiting
    ? isLeavePending(order)
      ? 'approved · its leave waits for you'
      : 'approved · waiting to be dispatched'
    : order.recall
      ? 'recalled · winding down'
      : (currentTodo(order) ?? (done === total ? 'wrapping up' : 'setting out'))
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
      {order.policy && order.policy.length > 0 && (
        <Text key={`order-policy-${order.id}`} dimColor wrap="truncate-end">
          {`rules: ${order.policy.join(' · ')}`}
        </Text>
      )}
      {leaveLines(el, order, buttons)}
      {steeringLines(el, order)}
    </Box>
  )
}

// An order its agent left with todos open (unsettled), or one settled as
// waiting for a wake: one line, then the open todos or the note; pressed, its
// report so far. It still holds its place.
function pausedRow(el: ElementTable, order: Order, isOpen: boolean, onToggle: (id: string) => unknown) {
  const { Box, Text, Button } = el
  const open = openTodos(order)
  const isUnsettled = order.status === 'unsettled'
  const detail = isUnsettled ? `open: ${open.map(todo => todo.content).join(' · ')}` : (order.note ?? 'waiting for its agent to wake')
  return (
    <Box key={`order-${order.id}`} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" gap={1} flexShrink={1}>
          <Text color="warning">{isUnsettled ? '◐' : '◷'}</Text>
          <Button key={`order-toggle-${order.id}`} label={`${isOpen ? '▾' : '▸'} ${ROLE_TITLE[order.role]} · ${order.relFolder}/`} plain onPress={() => onToggle(order.id)} />
          <Text dimColor>{order.id}</Text>
          <Text key={`order-level-${order.id}`} dimColor>{levelLabel(order)}</Text>
        </Box>
        <Text color="warning">{isUnsettled ? `unsettled · ${open.length} of ${order.todos.length} open` : 'waiting'}</Text>
      </Box>
      <Text key={`order-paused-${order.id}`} dimColor italic wrap="truncate-end">
        {detail}
      </Text>
      {leaveLines(el, order)}
      {steeringLines(el, order)}
      {isOpen && (
        <Box flexDirection="column" paddingLeft={2} borderStyle="quote" borderColor="warning">
          <Text wrap="wrap">{reportText(order)}</Text>
        </Box>
      )}
    </Box>
  )
}

// How a finished order ended: its mark, color and, beside done and failed, a word.
const ENDED: Record<string, { mark: string; color: string; word?: string }> = {
  done: { mark: '✓', color: 'success' },
  'stopped-early': { mark: '◑', color: 'warning', word: 'stopped early' },
  failed: { mark: '✕', color: 'error' },
  lost: { mark: '?', color: 'warning', word: 'lost' },
  recalled: { mark: '⏏', color: 'warning', word: 'recalled' },
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
  const ended = ENDED[order.status] ?? ENDED.failed!
  const calls = [callsLabel(order.steps), tokensLabel(order.usage)].filter(Boolean).join(' · ')
  return (
    <Box key={`order-${order.id}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={ended.color}>{ended.mark}</Text>
        <Button key={`order-toggle-${order.id}`} label={`${isOpen ? '▾' : '▸'} ${ROLE_TITLE[order.role]} · ${order.relFolder}/`} plain onPress={() => onToggle(order.id)} />
        <Text dimColor>{order.id}</Text>
        <Text key={`order-level-${order.id}`} dimColor>{levelLabel(order)}</Text>
        {ended.word && <Text key={`order-ended-${order.id}`} color={ended.color}>{ended.word}</Text>}
        {order.wakes !== undefined && <Text key={`order-woke-${order.id}`} color="warning">woke</Text>}
        {calls !== '' && <Text dimColor>{calls}</Text>}
      </Box>
      {order.note && (
        <Box paddingLeft={2}>
          <Text key={`order-note-${order.id}`} dimColor italic wrap="truncate-end">{order.note}</Text>
        </Box>
      )}
      {(order.recall || (order.amendments ?? []).length > 0 || (order.messages ?? []).length > 0) && (
        <Box flexDirection="column" paddingLeft={2}>
          {steeringLines(el, order)}
          {order.status === 'recalled' && (
            <Text key={`order-touched-${order.id}`} dimColor wrap="truncate-end">
              {`touched: ${touchedFiles(order).join(', ') || 'no files through its file tools'} · shell changes not tracked`}
            </Text>
          )}
        </Box>
      )}
      {isOpen && (
        <Box flexDirection="column" paddingLeft={2} borderStyle="quote" borderColor={ended.color}>
          <Text wrap="wrap">{reportText(order)}</Text>
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
  // On the road (working, then waiting), paused (unsettled or waiting to
  // wake), back home, and the archive: each newest first.
  const isPaused = (order: Order) => order.status === 'unsettled' || order.status === 'waiting'
  const active = court.orders.filter(order => !isFinished(order) && !isPaused(order)).sort((left, right) => (left.status === right.status ? newestFirst(left, right) : left.status === 'dispatched' ? -1 : 1))
  const paused = court.orders.filter(isPaused).sort((left, right) => (left.status === right.status ? newestFirst(left, right) : left.status === 'unsettled' ? -1 : 1))
  const home = court.orders.filter(order => isFinished(order) && !isFolded(order)).sort(newestFirst)
  const archived = court.orders.filter(order => isFolded(order)).sort(newestFirst)
  const hasFinished = home.length + archived.length > 0
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
              {openReport.status === 'done' && openReport.beyond && (
                <Text key={`verdict-beyond-${openSeat.id}`} color="warning" wrap="wrap">
                  {`beyond your request: ${openReport.beyond}`}
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
            <Box flexDirection="row" gap={1}>
              <Box flexGrow={1} flexShrink={1}>
                <Text color={lastRuling.isApproved ? 'success' : 'error'} wrap="wrap">
                  {lastRuling.isApproved ? `Approved: ${lastRuling.plan}` : `Refused: ${lastRuling.plan}`}
                </Text>
              </Box>
              {lastRuling.docketId !== undefined && props.onOpenDocket && (
                <Button key="ruling-docket" label="docket" plain dimColor onPress={() => props.onOpenDocket!(lastRuling.docketId!)} />
              )}
            </Box>
          )}
          {lastRuling?.notes?.map((note, index) => (
            <Text key={`ruling-note-${index}`} dimColor wrap="wrap">
              {`· ${note}`}
            </Text>
          ))}
          {lastRuling?.beyond?.map((entry, index) => (
            <Text key={`ruling-beyond-${index}`} color="warning" wrap="wrap">
              {`· ${beyondText(entry)}`}
            </Text>
          ))}
        </Box>
      )}
      {court.orders.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            No orders yet. Claude proposes dispatches with the council's propose_orders tool; approved ones appear here as roads.
          </Text>
        </Box>
      )}
      {active.length > 0 && section(el, 'section-active', `On the road · ${active.length}`, active.map(order => activeRow(el, order, props.road, props)))}
      {paused.length > 0 && section(el, 'section-paused', `Paused · ${paused.length}`, paused.map(order => pausedRow(el, order, props.openOrderId === order.id, props.onToggleOrder)))}
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
