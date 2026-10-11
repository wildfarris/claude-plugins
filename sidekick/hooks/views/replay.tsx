// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// The replay view, adapted from Anthropic's replay-theater sample mod
// (anthropics/claude-code-playground, claude-code/mods/replay-theater).
// Modified for sidekick: a pure view over plain data and callbacks, theme
// colors, and kept/hidden line counts from the stored summary.
//
// Drawn without a frame of its own: the pane already has one, so the view is
// a title line, the step strip, the file line, the diff and the controls.

import type { ElementTable } from 'claude-code'

import type { Replay } from '../../types'

export const MAX_VIEW_DIFF_LINES = 12

export type ReplayViewProps = {
  replay: Replay
  maxDiffLines: number
  width: number
  onGoTo: (index: number) => unknown
  onClose: () => unknown
}

export function replayView(el: ElementTable, props: ReplayViewProps) {
  const { Box, Text, Button } = el
  const { replay, maxDiffLines, width } = props
  const total = replay.steps.length
  if (total === 0) return <Text dimColor>No edits to replay.</Text>

  const index = Math.max(0, Math.min(replay.index, total - 1))
  const step = replay.steps[index]!
  const shownLines = step.diff.slice(0, maxDiffLines)
  const moreLineCount = step.diff.length - shownLines.length + step.hiddenLineCount

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text bold color="merged">
          ▶ Replay
        </Text>
        <Text dimColor>{`step ${index + 1} of ${total}`}</Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap">
        {replay.steps.map((_, position) => (
          <Text key={`s${position}`} inverse={position === index} color={position === index ? 'merged' : undefined} dimColor={position !== index}>
            {` ${position + 1} `}
          </Text>
        ))}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
        <Text bold wrap="truncate-start">
          {step.file}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text color="diffAdded">{`+${step.addedCount}`}</Text>
          <Text color="diffRemoved">{`-${step.removedCount}`}</Text>
          <Text dimColor>{step.note ? `${step.tool} · ${step.note}` : step.tool}</Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        {shownLines.length === 0 && <Text dimColor>{'  (no line changes)'}</Text>}
        {shownLines.map((line, position) => (
          <Text
            key={`d${position}`}
            color={line.op === '+' ? 'diffAdded' : line.op === '-' ? 'diffRemoved' : undefined}
            dimColor={line.op === ' ' || line.op === '~'}
            wrap="truncate-end"
          >
            {`${line.op === '~' ? ' ' : line.op} ${line.text}`.slice(0, width)}
          </Text>
        ))}
        {moreLineCount > 0 && <Text dimColor>{`  … ${moreLineCount} more lines`}</Text>}
      </Box>
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Button key="prev" label="Prev" hotkey="p" plain dimColor onPress={() => props.onGoTo(index - 1)} />
        <Button key="next" label="Next" hotkey="n" plain autoFocus onPress={() => props.onGoTo(index + 1)} />
        <Button key="close" label="Close" hotkey="c" plain dimColor role="dismiss" onPress={props.onClose} />
      </Box>
    </Box>
  )
}
