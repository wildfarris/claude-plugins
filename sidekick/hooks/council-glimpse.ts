// The council mod, as sidekick's bar sees it. Pure.
//
// Contract: sidekick reads the council mod's own state ({ plugin: 'council',
// key: 'council' }) and relies on its `topic`, `phase`, and each advisor's
// `status` and `concern`. Checked by shape, never trusted; a rename there
// shows up here as no council.

// What sidekick reads of the council mod's state (any plugin may read any
// value, so this is checked by shape rather than trusted).
export type CouncilGlimpse = { topic: string; phase: 'briefing' | 'deliberating' | 'done' | 'failed'; finished: number; total: number; gravest: number | null }

const PHASES = ['briefing', 'deliberating', 'done', 'failed'] as const

export function councilGlimpse(value: unknown): CouncilGlimpse | null {
  if (typeof value !== 'object' || value === null) return null
  const council = value as { topic?: unknown; phase?: unknown; advisors?: unknown }
  const phase = PHASES.find(name => name === council.phase)
  if (typeof council.topic !== 'string' || phase === undefined || typeof council.advisors !== 'object' || council.advisors === null) return null
  const reports = Object.values(council.advisors as Record<string, { status?: unknown; concern?: unknown }>)
  // An advisor that abstained has finished too (council 0.2's member files allow it).
  const finished = reports.filter(report => report.status === 'done' || report.status === 'abstained' || report.status === 'failed')
  const concerns = reports.filter(report => report.status === 'done' && typeof report.concern === 'number').map(report => report.concern as number)
  return { topic: council.topic, phase, finished: finished.length, total: reports.length, gravest: concerns.length === 0 ? null : Math.max(...concerns) }
}

export function councilStatus(glimpse: CouncilGlimpse): string {
  if (glimpse.phase === 'briefing') return 'the herald is briefing'
  if (glimpse.phase === 'deliberating') return `${glimpse.finished}/${glimpse.total} advisors in`
  if (glimpse.phase === 'failed') return 'dissolved'
  return glimpse.gravest === null ? 'adjourned' : `adjourned · gravest concern ${glimpse.gravest}/5`
}

// The folder a subagent's council order scopes it to, from the council mod's
// `court` value: its orders' `agentId`, `status` and `folder`.
export function orderFolderFor(court: unknown, agentId: string): string | undefined {
  if (typeof court !== 'object' || court === null) return undefined
  const orders = (court as { orders?: unknown }).orders
  if (!Array.isArray(orders)) return undefined
  const order = orders.find(
    (entry): entry is { folder: string } =>
      typeof entry === 'object' && entry !== null && (entry as { agentId?: unknown }).agentId === agentId && (entry as { status?: unknown }).status === 'dispatched' && typeof (entry as { folder?: unknown }).folder === 'string',
  )
  return order?.folder
}
