// Redaction for text sidekick keeps on disk (the turn ledger) or sends to a
// model: known secret shapes become «redacted». Best effort by pattern, so it
// errs toward redacting. Pure.

export const REDACTED = '«redacted»'

// Each pattern's whole match is replaced, except where a group 1 keeps a
// prefix (the `key=` before an assigned secret).
const SECRET_PATTERNS: readonly RegExp[] = [
  // Private key blocks, whole.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Provider token shapes.
  /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,})\b/g,
  // JSON web tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Credentials in a URL: scheme://user:password@host.
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi,
  // Authorization headers.
  /(\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic|token)?\s*)[^\s'"]+/gi,
  /(\bbearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  // Assignments to secret-named keys: API_KEY=…, "token": "…", --password …
  /((?:\b|_|-)(?:api[_-]?key|apikey|secret|token|passwd|password|pwd|private[_-]?key|access[_-]?key|client[_-]?secret|auth)\w*["']?\s*(?:[:=]|\s(?=["']))\s*["']?)[^\s"',;&|]{6,}/gi,
  /(--(?:password|token|secret|api-key)[= ]\s*)[^\s"']+/gi,
]

export function redactSecrets(text: string): string {
  let redacted = text
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix: unknown) => (typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED))
  }
  return redacted
}
