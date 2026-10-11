// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Edit-to-step conversion, adapted from Anthropic's replay-theater sample mod
// (anthropics/claude-code-playground, claude-code/mods/replay-theater).
// Modified for sidekick: pure (the caller reads the cwd and a Write's
// previous contents), typed, and summarized through ./diff.

import type { ReplayStep } from '../types'
import { summarizeDiff } from './diff'
import { relativeTo } from './scope-guard'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

export const isEditTool = (tool: string) => EDIT_TOOLS.has(tool)

export const textField = (value: unknown) => (typeof value === 'string' ? value : undefined)

export function relativePath(cwd: string, path: unknown): string {
  if (typeof path !== 'string' || path === '') return '(unknown file)'
  return cwd ? relativeTo(cwd, path) : path
}

// `input` is the tool call's arguments; `previousContents` is the file as it
// stood before a Write (undefined when it did not exist or was unreadable).
export function stepsForEdit(tool: string, input: Record<string, unknown>, cwd: string, previousContents?: string): ReplayStep[] {
  const file = relativePath(cwd, input.file_path)
  if (tool === 'Edit') {
    return [
      {
        tool,
        file,
        note: input.replace_all === true ? 'replace all' : '',
        ...summarizeDiff(textField(input.old_string), textField(input.new_string)),
      },
    ]
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    const edits = input.edits as Array<Record<string, unknown>>
    return edits.map((edit, position) => ({
      tool,
      file,
      note: `edit ${position + 1} of ${edits.length}`,
      ...summarizeDiff(textField(edit.old_string), textField(edit.new_string)),
    }))
  }
  if (tool === 'Write') {
    const isNewFile = previousContents === undefined
    return [
      {
        tool,
        file,
        note: isNewFile ? 'new file' : 'rewrite',
        ...summarizeDiff(previousContents ?? '', textField(input.content)),
      },
    ]
  }
  return []
}
