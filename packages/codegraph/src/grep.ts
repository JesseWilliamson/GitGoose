/** One line `git grep` found. */
export interface GrepHit {
  path: string
  line: number
  /** 1-based column of the match. */
  column: number
  text: string
}

/**
 * Parse `git grep -n -z --column [rev] …`: "[rev:]path\0line\0column\0text\n" per hit. With a
 * revision, git prefixes each path with "rev:"; pass it to strip it.
 */
export function parseGrep(out: string, rev?: string): GrepHit[] {
  const prefix = rev ? `${rev}:` : ''
  const hits: GrepHit[] = []
  for (const rec of out.split('\n')) {
    if (!rec) continue
    const [path = '', line = '0', column = '0', ...rest] = rec.split('\0')
    hits.push({ path: path.startsWith(prefix) ? path.slice(prefix.length) : path, line: Number(line), column: Number(column), text: rest.join('\0') })
  }
  return hits
}

/** The identifier under a character position, if any (for Ctrl/Cmd+click in a diff). */
export function identifierAt(text: string, offset: number): string | null {
  const isWord = (c: string | undefined) => !!c && /[\w$]/.test(c)
  if (!isWord(text[offset]) && isWord(text[offset - 1])) offset--
  if (!isWord(text[offset])) return null
  let a = offset
  let b = offset
  while (isWord(text[a - 1])) a--
  while (isWord(text[b + 1])) b++
  const word = text.slice(a, b + 1)
  return /^[A-Za-z_$]/.test(word) ? word : null
}
