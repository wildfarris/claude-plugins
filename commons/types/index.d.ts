// The commons mod's $.state contract.

// `pending`: proposed by Claude, on only in the project that proposed it
// until the person approves it in the sidebar.
export type TopicStatus = 'active' | 'pending'

export type Topic = {
  id: string
  name: string
  description: string
  status: TopicStatus
  // On in every project unless a project turns it off.
  isGlobal: boolean
  createdBy: string
  createdAt: string
}

export type Memory = {
  id: string
  text: string
  // The session root of the project that saved it.
  project: string
  savedAt: string
}

export type TopicView = Topic & {
  // On for this session's project.
  isOn: boolean
  // Newest first.
  memories: Memory[]
}

// The shared memory as this session sees it: re-read after every change and
// whenever the sidebar opens or a tool runs.
export type Library = {
  project: string
  topics: TopicView[]
  error: string | null
}

export type Sidebar = {
  expandedTopicId: string | null
}

declare module 'claude-code' {
  interface PluginState {
    commons: {
      library: Library | null
      sidebar: Sidebar
    }
  }
}
