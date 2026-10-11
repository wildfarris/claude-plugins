// The Memory sidebar: pending topics to approve, then every topic with its
// switch for this project, and one topic's memories open at a time.
// Pure: drawn from the surface's element table, plain data and callbacks.
//
// Drawn in the vocabulary the council and sidekick share: the title in the
// accent colour with a dim count beside it, one quote bar per secondary
// block (never one per row), `● on` / `○ off` switches, dim secondary
// buttons, and theme keys only.

import type { ElementTable } from 'claude-code'

import type { Library, Memory, TopicView } from '../../types'
import { projectName } from '../library'

export type SidebarHandlers = {
  switchTopic: (topic: TopicView) => unknown
  toggleGlobal: (topic: TopicView) => unknown
  toggleOpen: (topic: TopicView) => unknown
  approve: (topic: TopicView) => unknown
  discard: (topic: TopicView) => unknown
  deleteMemory: (topic: TopicView, memory: Memory) => unknown
  newTopic: () => unknown
}

export type SidebarProps = {
  library: Library
  expandedTopicId: string | null
  handlers: SidebarHandlers
}

const date = (memory: Memory) => (memory.savedAt ? memory.savedAt.slice(0, 10) : '')

const countLabel = (count: number) => `${count} ${count === 1 ? 'memory' : 'memories'}`

// A topic's memories: one bar around the list, each memory its text and a dim
// line of where and when it was saved, with its delete beside that.
function memoryRows(el: ElementTable, topic: TopicView, handlers: SidebarHandlers) {
  const { Box, Text, Button } = el
  if (topic.memories.length === 0) {
    return (
      <Text dimColor italic>
        No memories yet.
      </Text>
    )
  }
  return (
    <Box flexDirection="column" borderStyle="quote" borderColor="inactive" paddingLeft={1} rowGap={1}>
      {topic.memories.map(memory => (
        <Box key={`memory-${memory.id}`} flexDirection="column">
          <Text wrap="wrap">{memory.text}</Text>
          <Box flexDirection="row" gap={2}>
            <Text dimColor>{[projectName(memory.project), date(memory)].filter(Boolean).join(' · ')}</Text>
            <Button key={`delete-${topic.id}-${memory.id}`} label="delete" plain dimColor onPress={() => handlers.deleteMemory(topic, memory)} />
          </Box>
        </Box>
      ))}
    </Box>
  )
}

// One topic: its switch and name with the count, its description, and its
// controls on one dim line; the memories beneath while it is open.
function topicRow(el: ElementTable, topic: TopicView, isExpanded: boolean, handlers: SidebarHandlers) {
  const { Box, Text, Button } = el
  return (
    <Box key={`topic-${topic.id}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Button key={`switch-${topic.id}`} label={topic.isOn ? '● on ' : '○ off'} plain dimColor={!topic.isOn} onPress={() => handlers.switchTopic(topic)} />
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={1}>
          <Text bold={topic.isOn} dimColor={!topic.isOn}>
            {topic.name}
          </Text>
          <Text dimColor>{countLabel(topic.memories.length)}</Text>
        </Box>
      </Box>
      {topic.description !== '' && (
        <Box paddingLeft={6}>
          <Text dimColor wrap="wrap">
            {topic.description}
          </Text>
        </Box>
      )}
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} paddingLeft={6}>
        <Button key={`open-${topic.id}`} label={isExpanded ? 'hide' : 'show'} plain dimColor onPress={() => handlers.toggleOpen(topic)} />
        <Button
          key={`global-${topic.id}`}
          label={topic.isGlobal ? '◆ everywhere' : '◇ this project'}
          plain
          dimColor={!topic.isGlobal}
          onPress={() => handlers.toggleGlobal(topic)}
        />
      </Box>
      {isExpanded && <Box paddingLeft={6}>{memoryRows(el, topic, handlers)}</Box>}
    </Box>
  )
}

// A topic Claude proposed: its name, description and origin, then approve or
// discard; the whole pending section sits in one warning bar.
function pendingRow(el: ElementTable, topic: TopicView, isExpanded: boolean, handlers: SidebarHandlers) {
  const { Box, Text, Button } = el
  return (
    <Box key={`pending-${topic.id}`} flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text bold>{topic.name}</Text>
        <Text dimColor>{`${countLabel(topic.memories.length)} · from ${projectName(topic.createdBy)}`}</Text>
      </Box>
      {topic.description !== '' && (
        <Text dimColor wrap="wrap">
          {topic.description}
        </Text>
      )}
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Button key={`approve-${topic.id}`} label="approve" variant="primary" onPress={() => handlers.approve(topic)} />
        <Button key={`open-${topic.id}`} label={isExpanded ? 'hide' : 'show'} plain dimColor onPress={() => handlers.toggleOpen(topic)} />
        <Button key={`discard-${topic.id}`} label="discard" variant="secondary" onPress={() => handlers.discard(topic)} />
      </Box>
      {isExpanded && memoryRows(el, topic, handlers)}
    </Box>
  )
}

export function sidebarView(el: ElementTable, props: SidebarProps) {
  const { Box, Text, Button } = el
  const { library, expandedTopicId, handlers } = props
  const pending = library.topics.filter(topic => topic.status === 'pending')
  const active = library.topics.filter(topic => topic.status === 'active')
  const onCount = active.filter(topic => topic.isOn).length
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text bold color="claude">
          {`❖ Commons · ${projectName(library.project)}`}
        </Text>
        <Text dimColor>{`${onCount} of ${active.length} on`}</Text>
      </Box>
      {library.error !== null && (
        <Text color="error" wrap="wrap">
          {library.error}
        </Text>
      )}
      {pending.length > 0 && (
        <Box flexDirection="column" borderStyle="quote" borderColor="warning" paddingLeft={1} rowGap={1} marginTop={1}>
          <Text bold color="warning">
            Proposed by Claude
          </Text>
          {pending.map(topic => pendingRow(el, topic, expandedTopicId === topic.id, handlers))}
        </Box>
      )}
      {active.length === 0 && pending.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            No topics yet. Add one, or let Claude propose one as it saves something worth sharing.
          </Text>
        </Box>
      )}
      {active.length > 0 && (
        <Box flexDirection="column" rowGap={1} marginTop={1}>
          {active.map(topic => topicRow(el, topic, expandedTopicId === topic.id, handlers))}
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Button key="new-topic" label="+ new topic" variant="secondary" onPress={handlers.newTopic} />
        <Text dimColor wrap="wrap">
          Switches apply to this project's next conversation (or after /clear); Claude's recall and remember see them now.
        </Text>
      </Box>
    </Box>
  )
}
