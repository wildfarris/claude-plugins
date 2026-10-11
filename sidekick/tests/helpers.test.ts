import { describe, expect, test } from 'claude-code/testing'

import { MAX_STORED_DIFF_LINES, diffLines, summarizeDiff } from '../hooks/diff'
import { MAX_REMEMBERED_TOPICS, buildReviewPrompt, parseReview, withTopic } from '../hooks/long-answer'
import { relativePath, stepsForEdit } from '../hooks/replay-steps'
import { formatAge, resumeWarningFrom } from '../hooks/resume-warning'
import { readSettings } from '../hooks/settings'
import { biggestGrowth, emptyReadout, readoutLabel, withMeasurement } from '../hooks/context-readout'
import { councilGlimpse, councilStatus, orderFolderFor } from '../hooks/council-glimpse'
import { STUB_PREFIX, isReadOnlyCommand, planTrim, stubFor, trimDecision } from '../hooks/trim'

describe('diff', () => {
  test('marks changed lines and keeps one line of context', () => {
    expect(diffLines('a\nb\nc\nd\ne\n', 'a\nb\nX\nd\ne\n')).toEqual([
      { op: ' ', text: 'b' },
      { op: '-', text: 'c' },
      { op: '+', text: 'X' },
      { op: ' ', text: 'd' },
    ])
  })

  test('counts every change even past the stored cap', () => {
    const after = Array.from({ length: MAX_STORED_DIFF_LINES + 10 }, (_, n) => `line ${n}`).join('\n')
    const summary = summarizeDiff('', after)
    expect(summary.addedCount).toBe(MAX_STORED_DIFF_LINES + 10)
    expect(summary.diff.length).toBe(MAX_STORED_DIFF_LINES)
    expect(summary.hiddenLineCount).toBe(10)
  })
})

describe('replay steps', () => {
  test('shortens paths under the working directory', () => {
    expect(relativePath('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(relativePath('/repo', '/elsewhere/a.ts')).toBe('/elsewhere/a.ts')
  })

  test('labels a Write over a missing file as new', () => {
    const [step] = stepsForEdit('Write', { file_path: '/repo/new.ts', content: 'x\n' }, '/repo', undefined)
    expect(step?.note).toBe('new file')
    expect(step?.addedCount).toBe(1)
  })

  test('splits a MultiEdit into one step per edit', () => {
    const steps = stepsForEdit(
      'MultiEdit',
      { file_path: '/repo/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] },
      '/repo',
    )
    expect(steps.map(step => step.note)).toEqual(['edit 1 of 2', 'edit 2 of 2'])
  })
})

describe('long-answer review', () => {
  test('reads a summary with no note', () => {
    expect(parseReview('SUMMARY: Renamed greet to welcome in three files.\nHEADLINE: NONE')).toEqual({
      summary: 'Renamed greet to welcome in three files.',
      note: null,
      rule: null,
    })
  })

  test('reads a rule suggestion without swallowing it into the detail', () => {
    const review = parseReview('HEADLINE: A sibling repo was edited.\nDETAIL: sed ran from the root.\nRULE: fence vendor | third-party code, never edited')
    expect(review.note?.detail).toBe('sed ran from the root.')
    expect(review.rule).toEqual({ spec: 'fence vendor', reason: 'third-party code, never edited' })
    expect(parseReview('RULE: NONE').rule).toBeNull()
  })

  test('reads a summary and a note', () => {
    const review = parseReview('SUMMARY: Added a migration.\nHEADLINE: The migration drops a column.\nDETAIL: Existing rows lose data.')
    expect(review.summary).toBe('Added a migration.')
    expect(review.note).toEqual({ headline: 'The migration drops a column.', detail: 'Existing rows lose data.', isExpanded: false })
  })

  test('asks only for what is wanted, with focus and known topics', () => {
    const settings = readSettings({ focusTopics: 'security', ignoreTopics: 'formatting' })
    const request = {
      userPrompt: 'do it',
      answer: 'done',
      changedFiles: ['a.ts'],
      knownTopics: ['Tests are skipped'],
      shownTopics: [],
      wantsRule: false,
      blockedCalls: [],
      topLevelFolders: [],
      existingRules: [],
      declinedRules: [],
    }
    const both = buildReviewPrompt(settings, { ...request, wantsSummary: true, wantsHeadsUp: true })
    expect(both).toContain('SUMMARY:')
    expect(both).toContain('Weigh these areas first: security.')
    expect(both).toContain('- Tests are skipped')
    const summaryOnly = buildReviewPrompt(settings, { ...request, wantsSummary: true, wantsHeadsUp: false })
    expect(summaryOnly).not.toContain('HEADLINE:')
  })

  test('remembers a topic once, keeping the newest', () => {
    const full = Array.from({ length: MAX_REMEMBERED_TOPICS }, (_, n) => `topic ${n}`)
    expect(withTopic(full, 'TOPIC 3')).toBe(full)
    const grown = withTopic(full, 'fresh')
    expect(grown.length).toBe(MAX_REMEMBERED_TOPICS)
    expect(grown[grown.length - 1]).toBe('fresh')
  })
})

describe('settings', () => {
  test('defaults to Haiku 5.5 and clamps out-of-range values', () => {
    const settings = readSettings({ classifierUsageCap: 150, noteLength: 'novel' })
    expect(settings.model).toBe('claude-haiku-5-5')
    expect(settings.classifierUsageCap).toBe(100)
    expect(settings.noteLength).toBe('brief')
  })
})

describe('resume warning', () => {
  test('applies only to a resume whose cache likely expired', () => {
    expect(resumeWarningFrom({ source: 'startup', prompt_cache_likely_expired: true })).toBeUndefined()
    expect(resumeWarningFrom({ source: 'resume', prompt_cache_likely_expired: false })).toBeUndefined()
    expect(resumeWarningFrom({ source: 'resume', prompt_cache_likely_expired: true, seconds_since_last_response: 7200, context_tokens: 90000 })?.contextTokens).toBe(90000)
  })

  test('formats ages', () => {
    expect(formatAge(45)).toBe('45 seconds')
    expect(formatAge(7200)).toBe('2 hours')
    expect(formatAge(3 * 86400)).toBe('3 days')
  })
})


describe('trim', () => {
  const read = (id: string, path: string) => ({ tool_use_id: id, tool: 'Read', input: { file_path: path } })
  const result = (id: string, text: string) => ({ tool_use_id: id, text, isError: false })
  const big = 'line\n'.repeat(4000)
  const transcript = [
    { role: 'user' as const, text: 'look at the api', toolUses: [], handle: 'h0' },
    { role: 'assistant' as const, text: '', toolUses: [read('t1', '/r/api.ts')], handle: 'h1' },
    { role: 'user' as const, text: '', toolUses: [], toolResults: [result('t1', big)], handle: 'h2' },
    { role: 'assistant' as const, text: 'It charges cards.', toolUses: [], handle: 'h3' },
    { role: 'user' as const, text: 'now the tests', toolUses: [], handle: 'h4' },
    { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 't2', tool: 'Bash', input: { command: 'cd /r && grep -rn charge src | head -50' } }], handle: 'h5' },
    { role: 'user' as const, text: '', toolUses: [], toolResults: [result('t2', big)], handle: 'h6' },
    { role: 'assistant' as const, text: 'Two tests cover it.', toolUses: [], handle: 'h7' },
  ]

  test('only reads, searches and listings count, not commands that change things', () => {
    expect(isReadOnlyCommand('cd /r && grep -rn charge src | head -50')).toBe(true)
    expect(isReadOnlyCommand("sed -n '1,40p' a.ts")).toBe(true)
    expect(isReadOnlyCommand("sed -i 's/a/b/' a.ts")).toBe(false)
    expect(isReadOnlyCommand('cat a.ts > b.ts')).toBe(false)
    expect(isReadOnlyCommand('find . -name x -delete')).toBe(false)
    expect(isReadOnlyCommand('npm test')).toBe(false)
  })

  test('stubs finished turns, keeps the newest whole, and drops reasoning only from the first stub on', () => {
    const plan = planTrim(transcript, 1)
    expect(plan.droppedCount).toBe(1)
    // Before the stub: the engine's own messages, handles and all.
    expect(plan.messages.slice(0, 2).every(message => message.handle !== undefined)).toBe(true)
    expect(plan.messages[2]!.toolResults![0]!.text.startsWith(`${STUB_PREFIX} Read /r/api.ts returned 4001 lines`)).toBe(true)
    // From the stub on: rebuilt (no handle, so no thinking), text and tool calls intact.
    expect(plan.messages.slice(2).every(message => message.handle === undefined)).toBe(true)
    expect(plan.messages[6]!.toolResults![0]!.text).toBe(big)
    expect(plan.messages[7]!.text).toBe('Two tests cover it.')
    expect(planTrim(transcript, 2)).toEqual({ messages: transcript, droppedCount: 0, savedCharacters: 0 })
  })

  test('trims only past the threshold and only when it gets low enough', () => {
    const settings = { atPercent: 80, targetPercent: 50, keepTurns: 1 }
    expect(trimDecision(170_000, 200_000, 4 * 80_000, settings)).toMatchObject({ isWorth: true, currentPercent: 85, projectedPercent: 45 })
    expect(trimDecision(170_000, 200_000, 4 * 30_000, settings).isWorth).toBe(false)
    expect(trimDecision(150_000, 200_000, 4 * 100_000, settings).isWorth).toBe(false)
  })
})

describe('context readout', () => {
  test('credits each turn its growth, shows the last one, and resets on a compaction', () => {
    let readout = withMeasurement(emptyReadout(), 100_000, 1_000_000, 'start')
    expect(readoutLabel(readout)).toBe('ctx 10%')
    readout = withMeasurement(readout, 160_000, 1_000_000, 'read the whole api folder')
    readout = withMeasurement(readout, 172_000, 1_000_000, 'small fix')
    expect(readoutLabel(readout)).toBe('ctx 17% · +12k')
    expect(biggestGrowth(readout, 1)).toEqual([{ prompt: 'read the whole api folder', delta: 60_000 }])
    readout = withMeasurement(readout, 40_000, 1_000_000, '')
    expect(readoutLabel(readout)).toBe('ctx 4% · −132k')
    expect(readout.history.length).toBe(2)
  })

  test("credits a turn with its own answer, which the engine's figure only holds a turn later", () => {
    let readout = withMeasurement(emptyReadout(), 100_000, 1_000_000, 'start', 0)
    // A short prompt and a 40k-character answer: about +10k, this turn.
    readout = withMeasurement(readout, 100_050, 1_000_000, 'explain everything', 40_000)
    expect(readout.lastDelta).toBe(10_050)
    // Next turn the engine's figure holds that answer (10k); only the new prompt is new.
    readout = withMeasurement(readout, 110_100, 1_000_000, 'thanks', 0)
    expect(readout.lastDelta).toBe(50)
    expect(biggestGrowth(readout, 1)[0]!.prompt).toBe('explain everything')
  })

  test("reads the council mod's state by shape, and ignores anything else", () => {
    const advisors = { castellan: { status: 'done', concern: 4 }, treasurer: { status: 'done', concern: 2 }, jester: { status: 'deliberating', concern: 0 } }
    const glimpse = councilGlimpse({ topic: 'Ship it?', phase: 'deliberating', advisors })
    expect(glimpse).toEqual({ topic: 'Ship it?', phase: 'deliberating', finished: 2, total: 3, gravest: 4 })
    expect(councilStatus(glimpse!)).toBe('2/3 advisors in')
    expect(councilStatus({ ...glimpse!, phase: 'done' })).toBe('adjourned · gravest concern 4/5')
    expect(councilGlimpse(null)).toBeNull()
    expect(councilGlimpse({ topic: 1, phase: 'done', advisors })).toBeNull()
  })
})

describe('trim keeps only the records', () => {
  const result = (id: string, text: string, isError = false) => ({ tool_use_id: id, text, isError })
  const big = 'out\n'.repeat(3000)
  const call = (id: string, tool: string, input: Record<string, unknown>) => ({ tool_use_id: id, tool, input })
  const turn = (index: number, uses: Array<ReturnType<typeof call>>, results: Array<ReturnType<typeof result>>) => [
    { role: 'user' as const, text: `prompt ${index}`, toolUses: [] },
    { role: 'assistant' as const, text: '', toolUses: uses },
    { role: 'user' as const, text: '', toolUses: [], toolResults: results },
    { role: 'assistant' as const, text: `answer ${index}`, toolUses: [] },
  ]
  const transcript = [
    ...turn(1, [call('a', 'Bash', { command: 'npm test' }), call('b', 'AskUserQuestion', { questions: [] }), call('c', 'Agent', { prompt: 'audit' }), call('d', 'Bash', { command: 'npm run build' }), call('e', 'WebFetch', { url: 'https://x.dev/docs' })], [
      result('a', big),
      result('b', 'Your questions have been answered: ' + 'x'.repeat(5000)),
      result('c', 'Findings: ' + 'y'.repeat(5000)),
      result('d', big, true),
      result('e', big),
    ]),
    ...turn(2, [], []),
  ]

  test('drops every output but answers, subagent reports and errors', () => {
    const plan = planTrim(transcript, 1)
    const texts = plan.messages[2]!.toolResults!.map(entry => entry.text)
    expect(plan.droppedCount).toBe(2)
    expect(texts[0]).toBe(`${STUB_PREFIX} Bash \`npm test\` returned 3001 lines; output dropped]`)
    expect(texts[1]!.startsWith('Your questions have been answered')).toBe(true)
    expect(texts[2]!.startsWith('Findings:')).toBe(true)
    expect(texts[3]).toBe(big)
    expect(texts[4]).toBe(`${STUB_PREFIX} WebFetch https://x.dev/docs returned 3001 lines; output dropped]`)
  })

  test("only a read's stub suggests reading it again", () => {
    expect(stubFor({ tool: 'Read', input: { file_path: '/r/a.ts' } }, 'x\ny')).toContain("read it again if it's needed")
    expect(stubFor({ tool: 'Bash', input: { command: 'git push' } }, 'x')).toContain('returned 1 line; output dropped')
  })
})

describe('council orders', () => {
  test("finds a dispatched agent's folder in the council's court, and nothing else", () => {
    const court = { orders: [{ agentId: 'a1', status: 'dispatched', folder: '/w/api' }, { agentId: 'a2', status: 'done', folder: '/w/web' }] }
    expect(orderFolderFor(court, 'a1')).toBe('/w/api')
    expect(orderFolderFor(court, 'a2')).toBeUndefined()
    expect(orderFolderFor(null, 'a1')).toBeUndefined()
  })
})
