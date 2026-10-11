// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Line diff from Anthropic's replay-theater sample mod
// (anthropics/claude-code-playground, claude-code/mods/replay-theater).
// Modified for sidekick: typed, counts computed before the kept lines are
// capped, and the capped tail reported as `hiddenLineCount`.

import type { DiffLine } from '../types'

// Above this many lines per side the O(n*m) LCS is skipped and the diff is
// all-removed then all-added.
export const MAX_LCS_LINES = 400
// Lines kept per step in session state; the view shows fewer.
export const MAX_STORED_DIFF_LINES = 60

export type DiffSummary = {
  diff: DiffLine[]
  addedCount: number
  removedCount: number
  hiddenLineCount: number
}

export function splitLines(text: string | undefined | null): string[] {
  if (text === undefined || text === null || text === '') return []
  const lines = String(text).split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// Keeps one line of context around each change, so a long file's Write shows
// the changed lines rather than the whole file.
export function trimContext(lines: DiffLine[]): DiffLine[] {
  if (!lines.some(line => line.op !== ' ')) return lines
  const isChange = (index: number) => {
    const line = lines[index]
    return line !== undefined && line.op !== ' '
  }
  const trimmed: DiffLine[] = []
  let isSkipping = false
  lines.forEach((line, index) => {
    const isKept = isChange(index) || isChange(index - 1) || isChange(index + 1)
    if (!isKept) {
      isSkipping = true
      return
    }
    if (isSkipping && trimmed.length > 0) trimmed.push({ op: '~', text: '⋯' })
    trimmed.push(line)
    isSkipping = false
  })
  return trimmed
}

export function diffLines(oldText: string | undefined, newText: string | undefined): DiffLine[] {
  const before = splitLines(oldText)
  const after = splitLines(newText)
  if (before.length > MAX_LCS_LINES || after.length > MAX_LCS_LINES) {
    return [
      ...before.map(text => ({ op: '-' as const, text })),
      ...after.map(text => ({ op: '+' as const, text })),
    ]
  }
  const beforeCount = before.length
  const afterCount = after.length
  // commonLength[i][j]: length of the longest common subsequence of
  // before[i..] and after[j..].
  const commonLength = Array.from({ length: beforeCount + 1 }, () => new Array<number>(afterCount + 1).fill(0))
  const lengthAt = (i: number, j: number) => commonLength[i]?.[j] ?? 0
  for (let i = beforeCount - 1; i >= 0; i--) {
    const row = commonLength[i]!
    for (let j = afterCount - 1; j >= 0; j--) {
      row[j] = before[i] === after[j] ? lengthAt(i + 1, j + 1) + 1 : Math.max(lengthAt(i + 1, j), lengthAt(i, j + 1))
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < beforeCount && j < afterCount) {
    if (before[i] === after[j]) {
      lines.push({ op: ' ', text: before[i]! })
      i++
      j++
    } else if (lengthAt(i + 1, j) >= lengthAt(i, j + 1)) {
      lines.push({ op: '-', text: before[i++]! })
    } else {
      lines.push({ op: '+', text: after[j++]! })
    }
  }
  while (i < beforeCount) lines.push({ op: '-', text: before[i++]! })
  while (j < afterCount) lines.push({ op: '+', text: after[j++]! })
  return trimContext(lines)
}

export function summarizeDiff(oldText: string | undefined, newText: string | undefined): DiffSummary {
  const diff = diffLines(oldText, newText)
  let addedCount = 0
  let removedCount = 0
  for (const line of diff) {
    if (line.op === '+') addedCount++
    else if (line.op === '-') removedCount++
  }
  return {
    diff: diff.slice(0, MAX_STORED_DIFF_LINES),
    addedCount,
    removedCount,
    hiddenLineCount: Math.max(0, diff.length - MAX_STORED_DIFF_LINES),
  }
}
