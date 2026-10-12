// commons: memory shared across projects, by topic. Each project turns topics
// on in the Memory sidebar (/commons); a conversation's first message carries
// the memories of the topics on, and Claude reads and saves through two tools
// (recall, remember). Saving to a new topic proposes it: other projects see
// it only after the person approves it. Settings: plugin.json's userConfig.
//
// Every function that touches `$` is declared at the top level of this file:
// the engine follows `$` only into functions declared in the hooks module
// itself. Everything else lives beside it as pure code.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { Library, Memory, Sidebar, Topic, TopicView } from '../types'
import {
  RECALL_DESCRIPTION,
  RECALL_SCHEMA,
  REMEMBER_DESCRIPTION,
  REMEMBER_SCHEMA,
  buildLibrary,
  contextText,
  findTopic,
  formatMemory,
  formatProjectSettings,
  formatTopic,
  isSafeId,
  memoryId,
  nextTopicId,
  parseMemory,
  parseNewTopic,
  parseProjectSettings,
  parseTopic,
  paths,
  readRecallInput,
  readRememberInput,
  recallText,
  slugify,
  withTopicSwitched,
  type ProjectSettings,
} from './library'
import { NO_HOME, homeFromEnvironment } from './paths'
import { removeInside, type RemoveHost } from './remove'
import { memoryFolder, readSettings, type CommonsSettings } from './settings'
import { sidebarView } from './views/sidebar'

const SIDEBAR_PANE_ID = 'commons-sidebar'

const libraryAtom = atom({ plugin: 'commons', key: 'library' } as const, null as Library | null)
const sidebarAtom = atom({ plugin: 'commons', key: 'sidebar' } as const, { expandedTopicId: null } as Sidebar)

// Module state: rebuilt on every load.
let settings: CommonsSettings = readSettings({})
let folderCache: string | undefined
// The home folder as read with the memory folder ('' when unknown): never deleted.
let homeCache = ''
// Parsed memories by file path, kept while the file's size and time stand:
// memory files are written once, so a refresh reads only new ones.
const memoryCache = new Map<string, { mtimeMs: number; size: number; memory: Memory | undefined }>()
// Bumped by every refresh: a slower, older load never overwrites a newer one.
let refreshGeneration = 0

// ── The memory folder ─────────────────────────────────────────────────────

async function folder($: EngineInterface): Promise<string> {
  if (folderCache !== undefined) return folderCache
  const [fromHome, fromProfile] = await Promise.all([$.env.get('HOME').catch(() => undefined), $.env.get('USERPROFILE').catch(() => undefined)])
  const home = homeFromEnvironment(fromHome, fromProfile) ?? ''
  if (home === '' && (settings.memoryDir === '' || settings.memoryDir.startsWith('~'))) throw new Error(`${NO_HOME}; set memoryDir to an absolute path`)
  homeCache = home
  folderCache = memoryFolder(settings.memoryDir, home)
  return folderCache
}

const readText = ($: EngineInterface, path: string) =>
  $.fs
    .read(path)
    .then(text => (typeof text === 'string' ? text : undefined))
    .catch(() => undefined)

const listEntries = ($: EngineInterface, path: string) => $.fs.list(path).catch(() => [])

async function readProjectSettings($: EngineInterface, project: string): Promise<ProjectSettings> {
  const where = paths(await folder($))
  // Switches saved under 0.1.0's key are carried over until first written anew.
  const text = (await readText($, where.projectFile(project))) ?? (await readText($, where.legacyProjectFile(project)))
  return parseProjectSettings(project, text)
}

async function writeProjectSettings($: EngineInterface, projectSettings: ProjectSettings): Promise<void> {
  await $.fs.write(paths(await folder($)).projectFile(projectSettings.path), formatProjectSettings(projectSettings))
}

async function readTopicMemories($: EngineInterface, topicId: string): Promise<Memory[]> {
  const dir = paths(await folder($)).topic(topicId)
  const files = (await listEntries($, dir)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
  const memories = await Promise.all(
    files.map(async entry => {
      const path = `${dir}/${entry.name}`
      const cached = memoryCache.get(path)
      if (cached !== undefined && cached.mtimeMs === entry.mtimeMs && cached.size === entry.size) return cached.memory
      const text = await readText($, path)
      const memory = text === undefined ? undefined : parseMemory(entry.name.replace(/\.md$/, ''), text)
      memoryCache.set(path, { mtimeMs: entry.mtimeMs, size: entry.size, memory })
      return memory
    }),
  )
  return memories.filter((memory): memory is Memory => memory !== undefined)
}

async function loadLibrary($: EngineInterface): Promise<Library> {
  const project = await $.session.root()
  try {
    const where = paths(await folder($))
    const dirs = (await listEntries($, where.topics)).filter(entry => entry.kind === 'dir' && isSafeId(entry.name))
    const topics = await Promise.all(
      dirs.map(async entry => {
        const text = await readText($, where.topicFile(entry.name))
        const topic = text === undefined ? undefined : parseTopic(entry.name, text)
        return topic === undefined ? undefined : { topic, memories: await readTopicMemories($, entry.name) }
      }),
    )
    const found = topics.filter((entry): entry is { topic: Topic; memories: Memory[] } => entry !== undefined)
    return buildLibrary(project, found, await readProjectSettings($, project))
  } catch (error) {
    return { project, topics: [], error: `Could not read the shared memory: ${error instanceof Error ? error.message : String(error)}` }
  }
}

// Re-reads the folder (another session may have saved since) and redraws the sidebar.
async function refresh($: EngineInterface): Promise<Library> {
  const generation = ++refreshGeneration
  const library = await loadLibrary($)
  if (generation === refreshGeneration) await update($, libraryAtom, () => library)
  return library
}

async function writeTopic($: EngineInterface, topic: Topic): Promise<void> {
  await $.fs.write(paths(await folder($)).topicFile(topic.id), formatTopic(topic))
}

// Changes a topic's fields on disk as they are now (another session or a hand
// edit may have changed it since the sidebar drew).
async function patchTopic($: EngineInterface, topicId: string, patch: Partial<Pick<Topic, 'status' | 'isGlobal'>>): Promise<void> {
  const text = await readText($, paths(await folder($)).topicFile(topicId))
  const topic = text === undefined ? undefined : parseTopic(topicId, text)
  if (topic === undefined) throw new Error('that topic is gone')
  await writeTopic($, { ...topic, ...patch })
}

// A new topic, on in this project; an existing one with that name is returned as is.
async function createTopic($: EngineInterface, library: Library, name: string, description: string, status: Topic['status']): Promise<{ topic: Topic; isNew: boolean }> {
  const existing = findTopic(library.topics, name)
  if (existing !== undefined) return { topic: existing, isNew: false }
  const where = paths(await folder($))
  // Taken: on disk, including other projects' pending topics this one can't see.
  const onDisk = new Set((await listEntries($, where.topics)).map(entry => entry.name))
  const topic: Topic = {
    id: nextTopicId(name, id => onDisk.has(id)),
    name: name.trim(),
    description,
    status,
    isGlobal: false,
    createdBy: library.project,
    createdAt: new Date(await $.clock.now()).toISOString(),
  }
  await writeTopic($, topic)
  await writeProjectSettings($, withTopicSwitched(await readProjectSettings($, library.project), topic, true))
  return { topic, isNew: true }
}

async function saveMemory($: EngineInterface, topic: Topic, text: string, project: string): Promise<void> {
  const now = await $.clock.now()
  const id = memoryId(now, Math.random())
  await $.fs.write(paths(await folder($)).memoryFile(topic.id, id), formatMemory({ text, project, savedAt: new Date(now).toISOString() }))
}

// remove.ts's engine calls, spelled here: the engine follows `$` into no other file.
const removeHost = ($: EngineInterface): RemoveHost => ({
  stat: (path, options) => $.fs.stat(path, options),
  list: path => $.fs.list(path),
  exists: path => $.fs.exists(path),
  run: (argv, init) => $.process.run(argv, init),
})

// Removes a memory file or a whole topic folder, only ever inside the memory
// folder's topics (remove.ts checks it and runs the platform's delete).
// Resolves why it couldn't, or undefined once it's gone.
async function removeTopicPath($: EngineInterface, path: string): Promise<string | undefined> {
  const topicsRoot = paths(await folder($)).topics
  return removeInside(removeHost($), path, topicsRoot, homeCache || undefined)
    .then(() => undefined)
    .catch(error => (error instanceof Error ? error.message : String(error)))
}

// ── Claude's tools ────────────────────────────────────────────────────────

async function recallTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const library = await refresh($)
  if (library.error !== null) return library.error
  const { topic, query } = readRecallInput(input)
  return recallText(library, topic, query)
}

async function rememberTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const request = readRememberInput(input)
  if ('error' in request) return request.error
  const library = await refresh($)
  if (library.error !== null) return library.error
  const { topic, isNew } = await createTopic($, library, request.topic, request.description, 'pending')
  await saveMemory($, topic, request.text, library.project)
  await refresh($).catch(() => undefined)
  if (isNew) {
    $.ui.toast(`Commons: Claude proposed the topic "${topic.name}". Approve it in /commons.`)
    return `Saved. "${topic.name}" is a new topic, pending: it's on in this project, and other projects can turn it on once the person approves it in the Memory sidebar.`
  }
  const view = findTopic(library.topics, topic.id)
  return `Saved to "${topic.name}".${view !== undefined && !view.isOn ? ' (That topic is off in this project; the person can turn it on in the Memory sidebar.)' : ''}`
}

// ── The sidebar ───────────────────────────────────────────────────────────

async function openSidebar($: EngineInterface): Promise<void> {
  await refresh($)
  await $.ui.open({ id: SIDEBAR_PANE_ID, title: 'Memory' })
}

// Turns a topic on or off here (an explicit value, so a stale sidebar can't
// flip it the wrong way).
async function setTopicOn($: EngineInterface, topic: Topic, isOn: boolean): Promise<void> {
  const project = await $.session.root()
  await writeProjectSettings($, withTopicSwitched(await readProjectSettings($, project), topic, isOn))
  await refresh($)
}

async function setGlobal($: EngineInterface, topic: Topic, isGlobal: boolean): Promise<void> {
  await patchTopic($, topic.id, { isGlobal })
  await refresh($)
}

async function approveTopic($: EngineInterface, topic: Topic): Promise<void> {
  await patchTopic($, topic.id, { status: 'active' })
  await refresh($)
}

async function discardTopic($: EngineInterface, topic: TopicView): Promise<void> {
  const failure = await removeTopicPath($, paths(await folder($)).topic(topic.id))
  if (failure !== undefined) $.ui.toast(`Commons: could not remove "${topic.name}" (${failure}).`)
  await refresh($)
}

async function deleteMemory($: EngineInterface, topic: TopicView, memory: Memory): Promise<void> {
  const failure = await removeTopicPath($, paths(await folder($)).memoryFile(topic.id, memory.id))
  if (failure !== undefined) $.ui.toast(`Commons: could not delete that memory (${failure}).`)
  await refresh($)
}

// A sidebar press that fails says so instead of doing nothing.
async function guarded($: EngineInterface, action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch (error) {
    $.ui.toast(`Commons: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Puts a /commons command in front of the prompt box's draft: the rest is
// typed at full width and sent with Enter.
async function fillCommand($: EngineInterface, command: string): Promise<void> {
  const draft = (await $.prompt.read()).text.replace(/^\/commons new\s*/, '')
  await $.prompt.fill({ text: `${command}${draft}`, mode: 'replace' })
}

async function drawSidebar($: EngineInterface, e: RenderInput<'Pane'>) {
  const table = $.ui.resolve(e)
  const [library, sidebar] = await Promise.all([read($, libraryAtom), read($, sidebarAtom)])
  if (library === null) {
    // Opened some way other than /commons (e.g. restored): read it now.
    void refresh($).catch(() => undefined)
    return <table.Text dimColor>Reading the shared memory…</table.Text>
  }
  return sidebarView(table, {
    library,
    expandedTopicId: sidebar.expandedTopicId,
    handlers: {
      switchTopic: topic => guarded($, () => setTopicOn($, topic, !topic.isOn)),
      toggleGlobal: topic => guarded($, () => setGlobal($, topic, !topic.isGlobal)),
      toggleOpen: topic => update($, sidebarAtom, current => ({ expandedTopicId: current.expandedTopicId === topic.id ? null : topic.id })),
      approve: topic => guarded($, () => approveTopic($, topic)),
      discard: topic => guarded($, () => discardTopic($, topic)),
      deleteMemory: (topic, memory) => guarded($, () => deleteMemory($, topic, memory)),
      newTopic: () => guarded($, () => fillCommand($, '/commons new ')),
    },
  })
}

// ── The command ───────────────────────────────────────────────────────────

async function commonsCommand($: EngineInterface, args: string): Promise<string> {
  const [action = '', ...words] = args.trim().split(/\s+/)
  const rest = words.join(' ')
  if (action === '' || action === 'show') {
    await openSidebar($)
    return 'The Memory sidebar is open.'
  }
  const library = await refresh($)
  if (library.error !== null) return library.error
  if (action === 'new') {
    const request = parseNewTopic(rest)
    if (request === undefined) return 'Usage: /commons new <name>[: description]'
    const { topic, isNew } = await createTopic($, library, request.name, request.description, 'active')
    if (!isNew && topic.status === 'pending') {
      await approveTopic($, topic)
      return `Approved the topic "${topic.name}" Claude proposed.`
    }
    await refresh($)
    return isNew ? `Added the topic "${topic.name}", on in this project.` : `"${topic.name}" already exists.`
  }
  if (action === 'on' || action === 'off') {
    const topic = findTopic(library.topics, rest)
    if (topic === undefined) return `No topic "${rest}". Topics: ${library.topics.map(entry => entry.id).join(', ') || '(none yet)'}.`
    if (topic.isOn !== (action === 'on')) await setTopicOn($, topic, action === 'on')
    return `"${topic.name}" is ${action} in this project from its next conversation.`
  }
  return 'Usage: /commons [show | new <name>[: description] | on <topic> | off <topic>]'
}

// ── Hooks ─────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'commons', description: 'Open the shared Memory sidebar, add a topic, or turn one on or off here', argumentHint: '[show|new <name>[: description]|on <topic>|off <topic>]' })
    await $.tool.register({ name: 'recall', description: RECALL_DESCRIPTION, inputSchema: RECALL_SCHEMA, isDeferred: false })
    await $.tool.register({ name: 'remember', description: REMEMBER_DESCRIPTION, inputSchema: REMEMBER_SCHEMA, isDeferred: false })
    // So a sidebar restored with the session has something to draw.
    void refresh($).catch(() => undefined)
    return result
  })

  on('command.run', { command: 'commons' }, async ($, e) => ({ text: await commonsCommand($, e.args) }))

  // Both tools only read and write the memory folder. (Matchers are literal
  // so the engine can read them off the source: TOOL_NAMES spells the same.)
  on('tool.check', { tool: 'mcp__commons__recall' }, () => ({ decision: 'allow' as const }))
  on('tool.check', { tool: 'mcp__commons__remember' }, () => ({ decision: 'allow' as const }))

  on('tool.call', { tool: 'mcp__commons__recall' }, async ($, e) => ({ result: await recallTool($, e as unknown as Record<string, unknown>) })).catch(() => ({
    deny: 'The shared memory could not be read.',
  }))
  on('tool.call', { tool: 'mcp__commons__remember' }, async ($, e) => ({ result: await rememberTool($, e as unknown as Record<string, unknown>) })).catch(() => ({
    deny: 'Something failed while saving to the shared memory; the memory may or may not have been saved. Check with recall before saving it again.',
  }))

  // Once per conversation (again after compaction or /clear): the topics on
  // here ride with the first message, so the prompt cache is never disturbed.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const library = await refresh($)
    const text = library.error === null ? contextText(library, settings.contextLimit) : null
    return text === null ? result : { ...result, blocks: [...result.blocks, { name: 'commons', text }] }
  })

  on('ui.render', { component: 'Pane', requestId: SIDEBAR_PANE_ID }, ($, e) => drawSidebar($, e))
}
