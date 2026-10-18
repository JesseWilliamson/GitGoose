/**
 * A built-in secret scan, run on everything before it is sent to an AI provider, and on the
 * added lines of a review. Patterns for credentials with a recognisable shape (vendor prefixes,
 * key blocks), plus quoted values assigned to names like "password" that look random enough.
 * It cannot catch everything; it catches the common accidents.
 */

export interface SecretHit {
  kind: string
  /** Where in the text it starts. */
  index: number
  length: number
  /** The match with most of it hidden, safe to show. */
  masked: string
}

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g },
  { kind: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'Stripe key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b|\bsk-proj-[A-Za-z0-9_-]{40,}\b/g },
  { kind: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
]

/** Names whose quoted value is probably a credential. */
const ASSIGNED = /\b([A-Za-z_]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret))\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi

/** Shannon entropy per character: random keys score high, words and placeholders low. */
export function entropy(s: string): number {
  const counts = new Map<string, number>()
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length)
  return h
}

function mask(s: string): string {
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`
}

export function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = []
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(re)) hits.push({ kind, index: m.index!, length: m[0].length, masked: kind === 'private key' ? '-----BEGIN … PRIVATE KEY-----' : mask(m[0]) })
  }
  for (const m of text.matchAll(ASSIGNED)) {
    const value = m[2]!
    // Placeholders ("changeme", "${PASSWORD}", "xxxxxxxx") are fine; random-looking values are not.
    if (/^[x*.]+$|^\$\{|^<.*>$|^(change|replace|your|example|dummy|test|password|secret)/i.test(value) || entropy(value) < 3) continue
    const index = m.index! + m[0].lastIndexOf(value)
    if (hits.some((h) => index >= h.index && index < h.index + h.length)) continue
    hits.push({ kind: `hard-coded ${m[1]!.toLowerCase()}`, index, length: value.length, masked: mask(value) })
  }
  return hits.sort((a, b) => a.index - b.index)
}

/** The text with every secret replaced by a marker that says what was there. */
export function redactSecrets(text: string): { text: string; count: number } {
  const hits = scanSecrets(text)
  let out = ''
  let at = 0
  for (const h of hits) {
    if (h.index < at) continue
    out += text.slice(at, h.index) + `[REDACTED ${h.kind}]`
    at = h.index + h.length
  }
  return { text: out + text.slice(at), count: hits.length }
}

/** Line number (1-based) of an index in a text. */
export function lineAt(text: string, index: number): number {
  let n = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/**
 * Where a hit is, for telling the user. Prompts name files with headers ("=== path (modified) ===",
 * "File: path") and numbered diffs prefix lines with their new line number ("   12+| …"), so the
 * nearest header above the hit gives the file and its own line gives the line, when there are any.
 */
export function locateSecret(text: string, index: number): { file?: string; line?: number; excerpt: string } {
  const start = text.lastIndexOf('\n', index - 1) + 1
  const endAt = text.indexOf('\n', index)
  const lineText = text.slice(start, endAt < 0 ? undefined : endAt)
  const numbered = /^\s*(\d+)[+ ]\| /.exec(lineText)
  let file: string | undefined
  for (let at = start; at > 0; ) {
    const prev = text.lastIndexOf('\n', at - 2) + 1
    const l = text.slice(prev, at - 1)
    const m = /^=== (.+?) \([^)]*\) ===$/.exec(l) ?? /^File: (.+)$/.exec(l)
    if (m) {
      file = m[1]
      break
    }
    at = prev
  }
  const hits = scanSecrets(lineText)
  let excerpt = ''
  let from = 0
  for (const h of hits) {
    excerpt += lineText.slice(from, h.index) + h.masked
    from = h.index + h.length
  }
  excerpt = (excerpt + lineText.slice(from)).replace(/^\s*\d*[+ -]?\| /, '').trim()
  return { file, line: numbered ? Number(numbered[1]) : undefined, excerpt: excerpt.length > 120 ? `${excerpt.slice(0, 117)}…` : excerpt }
}
