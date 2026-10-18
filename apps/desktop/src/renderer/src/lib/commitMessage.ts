/**
 * Commit message helpers for the commit box. Pure, so they are unit-tested.
 *
 * Templates (commit.template): git's own editor flow strips "#" lines, but GitGoose commits with
 * `-F -`, where git keeps them. So comment lines never go into the fields: they become the
 * description's placeholder, which is what they are for (guidance), and the rest is prefilled.
 */
export function splitTemplate(text: string): { summary: string; body: string; hint: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const kept = lines.filter((l) => !l.startsWith('#'))
  const hint = lines.filter((l) => l.startsWith('#')).map((l) => l.replace(/^#\s?/, '')).join('\n').trim()
  const [summary = '', ...rest] = kept
  return { summary: summary.trimEnd(), body: rest.join('\n').trim(), hint }
}

/** A message equal to the template's prefill has not been written yet. */
export function isUntouched(summary: string, body: string, template: { summary: string; body: string } | null): boolean {
  if (!summary.trim() && !body.trim()) return true
  return !!template && summary.trim() === template.summary.trim() && body.trim() === template.body.trim()
}

/**
 * Add a trailer such as "Co-authored-by: Name <email>" at the end of the description. Trailers
 * form the last paragraph, so a blank line separates them from prose; an existing trailer block
 * is extended, and a trailer that is already there is not added twice.
 */
export function addTrailer(body: string, trailer: string): string {
  const text = body.replace(/\s+$/, '')
  if (text.split('\n').some((l) => l.trim().toLowerCase() === trailer.toLowerCase())) return text
  if (!text) return trailer
  const paragraphs = text.split(/\n\s*\n/)
  const last = paragraphs[paragraphs.length - 1]!
  const isTrailers = last.split('\n').every((l) => /^[A-Za-z][\w-]*: .+/.test(l))
  return isTrailers ? `${text}\n${trailer}` : `${text}\n\n${trailer}`
}
