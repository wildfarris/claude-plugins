import { describe, expect, test } from 'claude-code/testing'

import type { Topic } from '../types'
import {
  buildLibrary,
  contextText,
  emptyProjectSettings,
  formatMemory,
  isTopicOn,
  memoryId,
  parseMemory,
  parseNewTopic,
  parseProjectSettings,
  parseTopic,
  projectKey,
  projectName,
  readRememberInput,
  recallText,
  slugify,
  withTopicSwitched,
} from '../hooks/library'
import { memoryFolder, readSettings } from '../hooks/settings'

const topic = (fields: Partial<Topic>): Topic => ({ id: 'design', name: 'Design', description: '', status: 'active', isGlobal: false, createdBy: '/dev/web', createdAt: '', ...fields })

describe('files', () => {
  test('a topic id is its name, slugged', () => {
    expect(slugify('Design Language!')).toBe('design-language')
    expect(slugify('  ')).toBe('topic')
  })

  test('memory ids sort by time and stay file-safe', () => {
    const id = memoryId(Date.UTC(2026, 9, 8, 12, 30, 5), 0.5)
    expect(id).toBe('20261008-123005-000-80000000')
  })

  test('a memory survives a round trip, and a hand-written one without a header still reads', () => {
    const text = formatMemory({ text: 'Teal accent.', project: '/dev/web', savedAt: '2026-10-08T00:00:00.000Z' })
    expect(parseMemory('m1', text)).toEqual({ id: 'm1', text: 'Teal accent.', project: '/dev/web', savedAt: '2026-10-08T00:00:00.000Z' })
    expect(parseMemory('m2', 'Just a note.\n')).toEqual({ id: 'm2', text: 'Just a note.', project: '', savedAt: '' })
    expect(parseMemory('m3', '')).toBeUndefined()
  })

  test('bad files read as nothing rather than throwing', () => {
    expect(parseTopic('x', 'not json')).toBeUndefined()
    expect(parseProjectSettings('/dev/web', '{oops')).toEqual(emptyProjectSettings('/dev/web'))
  })
})

describe('switches', () => {
  test('a local topic is on only where turned on; a global one everywhere until turned off', () => {
    const local = topic({})
    const global = topic({ id: 'release', isGlobal: true })
    const settings = emptyProjectSettings('/dev/admin')
    expect(isTopicOn(local, settings)).toBe(false)
    expect(isTopicOn(global, settings)).toBe(true)
    expect(isTopicOn(local, withTopicSwitched(settings, local, true))).toBe(true)
    expect(isTopicOn(global, withTopicSwitched(settings, global, false))).toBe(false)
  })

  test('a pending topic is on only where it was turned on, even if marked global', () => {
    const pending = topic({ status: 'pending', isGlobal: true })
    expect(isTopicOn(pending, emptyProjectSettings('/dev/admin'))).toBe(false)
    expect(isTopicOn(pending, withTopicSwitched(emptyProjectSettings('/dev/web'), pending, true))).toBe(true)
  })
})

describe('what Claude reads', () => {
  const memories = Array.from({ length: 40 }, (_, index) => ({
    id: `m${index}`,
    text: `Memory number ${index} with some words to take up room in the block.`,
    project: '/dev/web',
    savedAt: `2026-10-${String(10 + (index % 20)).padStart(2, '0')}T00:00:${String(index).padStart(2, '0')}.000Z`,
  }))
  const settings = withTopicSwitched(emptyProjectSettings('/dev/admin'), topic({}), true)
  const library = buildLibrary('/dev/admin', [{ topic: topic({}), memories }, { topic: topic({ id: 'misc', name: 'Misc' }), memories: [] }], settings)

  test('the first-message block keeps the newest within the limit and points to the rest', () => {
    const text = contextText(library, 1200)!
    expect(text.length).toBeLessThanOrEqual(1400)
    expect(text).toMatch(/\(\d+ older: mcp__commons__recall with topic "design"\)/)
    expect(text).toContain('Other topics, off in this project: Misc.')
  })

  test('recall filters by every word of the query', () => {
    expect(recallText(library, 'design', 'number 7 with')).toContain('Memory number 7 with')
    expect(recallText(library, 'design', 'number 7 with')).not.toContain('number 8')
    expect(recallText(library, 'nope', undefined)).toContain('No topic "nope"')
  })
})

describe('inputs', () => {
  test('remember needs a topic and a memory of reasonable size', () => {
    expect(readRememberInput({ topic: 'a', text: 'b' })).toEqual({ topic: 'a', text: 'b', description: '' })
    expect(readRememberInput({ text: 'b' })).toEqual({ error: 'Name a topic.' })
  })

  test('/commons new takes a name and an optional description', () => {
    expect(parseNewTopic('Release process: how we tag')).toEqual({ name: 'Release process', description: 'how we tag' })
    expect(parseNewTopic('Ideas')).toEqual({ name: 'Ideas', description: '' })
    expect(parseNewTopic('  ')).toBeUndefined()
  })

  test('the memory folder defaults under ~/.claude and expands ~', () => {
    expect(memoryFolder('', '/home/me')).toBe('/home/me/.claude/commons')
    expect(memoryFolder('~/notes/commons/', '/home/me')).toBe('/home/me/notes/commons')
    expect(memoryFolder('/srv/commons', '')).toBe('/srv/commons')
    expect(readSettings({ contextLimit: 5 }).contextLimit).toBe(1000)
  })
})

describe('audit fixes', () => {
  test('project keys never collide for different paths', () => {
    expect(projectKey('/dev/my-app')).not.toBe(projectKey('/dev/my_app'))
  })

  test('recall cuts a large topic by line instead of returning nothing', () => {
    const memories = Array.from({ length: 400 }, (_, index) => ({ id: `m${index}`, text: `note ${index} ${'x'.repeat(60)}`, project: '/dev/web', savedAt: '2026-10-01T00:00:00.000Z' }))
    const library = buildLibrary('/dev/web', [{ topic: topic({}), memories }], withTopicSwitched(emptyProjectSettings('/dev/web'), topic({}), true))
    const text = recallText(library, 'design', undefined)
    expect(text).toContain('note 0 ')
    expect(text).toMatch(/\(\d+ more; narrow it with a query\)/)
    expect(text.length).toBeLessThan(13_000)
  })

  test('the first-message block stays within the limit, headings included, newest first across topics', () => {
    const make = (topicId: string, count: number, day: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `${topicId}${index}`, text: `${topicId} memory ${index} ${'y'.repeat(80)}`, project: '/dev/web', savedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:${String(index % 60).padStart(2, '0')}.000Z` }))
    const topics = [topic({ id: 'a', name: 'A', isGlobal: true }), topic({ id: 'b', name: 'B', isGlobal: true })]
    const library = buildLibrary('/dev/web', [{ topic: topics[0]!, memories: make('a', 50, 1) }, { topic: topics[1]!, memories: make('b', 50, 9) }], emptyProjectSettings('/dev/web'))
    const text = contextText(library, 2000)!
    expect(text.length).toBeLessThanOrEqual(2000)
    expect(text).toContain('b memory')
  })

  test('memoryDir must be absolute and plain', () => {
    expect(() => memoryFolder('commons', '/home/me')).toThrow('absolute')
    expect(() => memoryFolder('/srv/../etc', '/home/me')).toThrow('..')
  })
})

describe('Windows', () => {
  test('the memory folder takes drive, UNC and ~\\ paths, in their own spelling', () => {
    expect(memoryFolder('', 'C:\\Users\\me')).toBe('C:\\Users\\me\\.claude\\commons')
    expect(memoryFolder('', 'C:/Users/me')).toBe('C:\\Users\\me\\.claude\\commons')
    expect(memoryFolder('~\\notes\\commons\\', 'C:\\Users\\me')).toBe('C:\\Users\\me\\notes\\commons')
    expect(memoryFolder('~/notes', 'C:\\Users\\me')).toBe('C:\\Users\\me\\notes')
    expect(memoryFolder('D:\\shared\\commons', '')).toBe('D:\\shared\\commons')
    expect(memoryFolder('d:/shared//commons/', 'C:\\Users\\me')).toBe('D:\\shared\\commons')
    expect(memoryFolder('\\\\nas\\team\\commons', 'C:\\Users\\me')).toBe('\\\\nas\\team\\commons')
    for (const setting of ['commons', 'D:commons', '\\commons', 'C:\\shared\\..\\Windows', 'C:\\shared\\.\\commons', '~\\..\\x']) {
      expect(() => memoryFolder(setting, 'C:\\Users\\me')).toThrow()
    }
    // On POSIX ~\ is not a home path, and backslashes are ordinary characters.
    expect(() => memoryFolder('~\\notes', '/home/me')).toThrow('absolute')
    expect(memoryFolder('/srv/a\\b', '/home/me')).toBe('/srv/a\\b')
  })

  test('files a Windows editor saved with a byte-order mark still read', () => {
    const bom = '\uFEFF'
    expect(parseTopic('t', `${bom}{"name":"T","status":"active","isGlobal":false,"createdBy":"/p","createdAt":"x"}`)?.name).toBe('T')
    expect(parseProjectSettings('/p', `${bom}{"path":"/p","on":["t"],"off":[]}`).on).toEqual(['t'])
    expect(parseMemory('m', `${bom}<!-- commons {"project":"/p","savedAt":"x"} -->\nA note.\n`)).toMatchObject({ text: 'A note.', project: '/p' })
  })

  test('topic ids never take a name Windows reserves for a device', () => {
    expect(slugify('CON')).toBe('con-topic')
    expect(slugify('nul')).toBe('nul-topic')
    expect(slugify('Com1')).toBe('com1-topic')
    expect(slugify('LPT9')).toBe('lpt9-topic')
    expect(slugify('Console')).toBe('console')
    expect(slugify('com10')).toBe('com10')
  })

  test('a project is named by its last folder, whichever separator', () => {
    expect(projectName('C:\\claude\\workspace\\web')).toBe('web')
    expect(projectName('/dev/web/')).toBe('web')
  })
})
