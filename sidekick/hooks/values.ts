// Small value helpers shared by the pure modules.

// The strings of a stored list; anything else reads as empty.
export const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])

// About four characters to a token, for code and English alike.
export const estimateTokens = (characters: number) => Math.round(characters / 4)

// 950, 12k, 1.2M; negative with a minus sign.
export function formatTokens(tokens: number): string {
  const size = Math.abs(tokens)
  const text = size >= 1_000_000 ? `${(size / 1_000_000).toFixed(1)}M` : size >= 1000 ? `${Math.round(size / 1000)}k` : String(size)
  return `${tokens < 0 ? '−' : ''}${text}`
}

// A short key for a long text (a cache key): its length and a 32-bit hash.
export function textKey(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index++) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  return `${text.length}:${(hash >>> 0).toString(36)}`
}

// Why a model call came back without an answer, in a few words: the API
// error's kind and status, a timeout or cancel, or an empty reply.
export function modelFailureText(reply: { reason: string; status?: number | null; error?: string }): string {
  if (reply.reason === 'api-error') return `API error: ${reply.error ?? 'unknown'}${reply.status ? ` (${reply.status})` : ', no response'}`
  if (reply.reason === 'aborted') return 'timed out or cancelled'
  if (reply.reason === 'empty-reply') return 'the model replied with no text'
  return reply.reason
}
