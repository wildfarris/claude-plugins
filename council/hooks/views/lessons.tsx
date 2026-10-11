// The lessons view: what the council has learned in this project, the
// guidance that applies here, and a drafted summary waiting for approval.
// Pure: drawn from the surface's element table, plain data and callbacks.
// Shares the chamber's vocabulary (views/council.tsx).

import type { ElementTable } from 'claude-code'

import type { LearningView } from '../../types'
import { EVERYWHERE, LEARNING_LIMITS } from '../learning'

export type LessonsViewProps = {
  view: LearningView
  onForget: (id: string) => unknown
  onDraft: () => unknown
  onApprove: () => unknown
  onReject: () => unknown
  onClose: () => unknown
}

const projectName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

// ◆ applies everywhere, ◇ in this project only.
const scopeMark = (isEverywhere: boolean) => (isEverywhere ? '◆' : '◇')

export function lessonsView(el: ElementTable, props: LessonsViewProps) {
  const { Box, Text, Button } = el
  const { view } = props
  const guidanceItems = view.guidance.flatMap(section => section.items.map(item => ({ item, isEverywhere: section.scope === EVERYWHERE })))
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text bold color="claude">
          {`⚜ Lessons · ${projectName(view.project)}`}
        </Text>
        <Text dimColor>{`${view.lessons.length} lesson${view.lessons.length === 1 ? '' : 's'} · summary at ${LEARNING_LIMITS.summaryAt}`}</Text>
      </Box>
      {view.error !== null && (
        <Text color="error" wrap="wrap">
          {view.error}
        </Text>
      )}
      {view.proposal !== null && (
        <Box flexDirection="column" borderStyle="quote" borderColor="warning" paddingLeft={1} marginTop={1}>
          <Text bold color="warning">
            A summary is waiting for you
          </Text>
          {view.proposal.flatMap(section =>
            section.items.map((item, index) => (
              <Text key={`proposed-${section.scope}-${index}`} wrap="wrap">
                {`${scopeMark(section.scope === EVERYWHERE)} ${item}`}
              </Text>
            )),
          )}
          <Text dimColor wrap="wrap">
            {`Edit ${view.proposalPath} first if you like. Approved, it joins the guidance and replaces the lessons it covers; rejected, they stay.`}
          </Text>
          <Box flexDirection="row" gap={2}>
            <Button key="approve-summary" label="approve" variant="primary" onPress={props.onApprove} />
            <Button key="reject-summary" label="reject" variant="secondary" onPress={props.onReject} />
          </Box>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" gap={2}>
          <Text bold>Guidance here</Text>
          <Text dimColor>◆ everywhere · ◇ this project</Text>
        </Box>
        {guidanceItems.length === 0 ? (
          <Text dimColor>None yet.</Text>
        ) : (
          guidanceItems.map((entry, index) => (
            <Text key={`guidance-${index}`} wrap="wrap">
              {`${scopeMark(entry.isEverywhere)} ${entry.item}`}
            </Text>
          ))
        )}
        <Text dimColor wrap="wrap">
          {`Edit or delete in ${view.guidancePath}.`}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Lessons from reconsiders</Text>
        {view.lessons.length === 0 ? (
          <Text dimColor wrap="wrap">
            None yet. Each time you reconsider a council here, what you added becomes a lesson every advisor sees in this project.
          </Text>
        ) : (
          <Box flexDirection="column" borderStyle="quote" borderColor="inactive" paddingLeft={1} rowGap={1}>
            {view.lessons.map(lesson => (
              <Box key={`lesson-${lesson.id}`} flexDirection="column">
                <Text wrap="wrap">{`"${lesson.added}"`}</Text>
                <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                  <Text dimColor wrap="truncate-end">
                    {[lesson.topic, lesson.moves.join(' · ') || 'no verdicts moved'].filter(Boolean).join(' · ')}
                  </Text>
                  <Button key={`forget-${lesson.id}`} label="forget" plain dimColor onPress={() => props.onForget(lesson.id)} />
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
        {view.proposal === null && view.lessons.length >= 2 && <Button key="draft-summary" label="draft a summary now" variant="secondary" onPress={props.onDraft} />}
        <Button key="close-lessons" label="done" variant="secondary" onPress={props.onClose} />
      </Box>
    </Box>
  )
}
