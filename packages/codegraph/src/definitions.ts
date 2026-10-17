import { LANGUAGES, NOT_NAMES, languageOf, type Blocks, type DefinitionKind } from './languages'

export interface Definition {
  name: string
  kind: DefinitionKind
  /** 1-based, inclusive. */
  line: number
  endLine: number
  /** The defining line, trimmed: what a peek shows first. */
  signature: string
}

/**
 * Every definition in a file, in order, with where each one ends. Unknown languages have none.
 * Methods are told apart from functions by being inside a class (an enclosing definition).
 */
export function findDefinitions(path: string, text: string): Definition[] {
  const lang = languageOf(path)
  if (!lang) return []
  const spec = LANGUAGES[lang]
  const lines = text.split(/\r?\n/)
  const out: Definition[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const body = raw.trimStart()
    if (!body || isComment(body)) continue
    const indented = body.length !== raw.length
    for (const p of spec.patterns) {
      if (p.topLevel && indented) continue
      const m = p.re.exec(body)
      if (!m?.[1] || (p.guard && NOT_NAMES.has(m[1]))) continue
      out.push({ name: m[1], kind: p.kind, line: i + 1, endLine: endOf(lines, i, spec.blocks), signature: body.trim().slice(0, 200) })
      break
    }
  }
  // A function inside a class is a method.
  for (const d of out) {
    if (d.kind === 'function' && out.some((c) => c !== d && (c.kind === 'class' || c.kind === 'interface') && c.line < d.line && c.endLine >= d.endLine)) d.kind = 'method'
  }
  return out
}

/** The innermost definition containing a line: "which function is this change in?" */
export function enclosingDefinition(defs: Definition[], line: number): Definition | null {
  let best: Definition | null = null
  for (const d of defs) {
    if (d.line <= line && line <= d.endLine && (!best || d.line >= best.line)) best = d
  }
  return best
}

function isComment(s: string): boolean {
  return s.startsWith('//') || s.startsWith('#') && !s.startsWith('#define') && !s.startsWith('# define') || s.startsWith('*') || s.startsWith('/*')
}

/** Where a definition starting at line `start` (0-based) ends, 1-based. */
function endOf(lines: string[], start: number, blocks: Blocks): number {
  if (blocks === 'indent' || blocks === 'end') {
    const indent = indentOf(lines[start]!)
    let last = start
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]!
      if (!l.trim()) continue
      if (indentOf(l) <= indent) {
        // Ruby's `end` at the same indent closes the definition and belongs to it.
        if (blocks === 'end' && /^\s*end\b/.test(l)) last = i
        break
      }
      last = i
    }
    return last + 1
  }
  // Braces: count them from the defining line until they balance. Strings and comments are
  // stripped first, so a "{" inside a string does not count. A line that opens no block ends
  // the definition right there (a type alias, a one-line arrow, a #define), unless it plainly
  // goes on: a signature split over lines ends in "(", ",", "=", "=>", an operator, or "->",
  // or the block opens on the next line.
  let depth = 0
  let opened = false
  for (let i = start; i < lines.length; i++) {
    const l = stripStringsAndComments(lines[i]!)
    for (const ch of l) {
      if (ch === '{') {
        depth++
        opened = true
      } else if (ch === '}') depth--
    }
    if (opened && depth <= 0) return i + 1
    if (!opened && (i - start >= 5 || (!continues(l) && !nextStartsBlock(lines, i)))) return i + 1
  }
  return opened ? lines.length : start + 1
}

/** "{" on a line of its own after the signature (Allman style, common in C and C#). */
function nextStartsBlock(lines: string[], i: number): boolean {
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j]!.trim()
    if (t) return t.startsWith('{')
  }
  return false
}

/** Does this line plainly continue on the next one (an unfinished signature or expression)? */
function continues(line: string): boolean {
  const t = line.trimEnd()
  if (/[(,=:<|&?+\-*/]$|=>$|->$/.test(t)) return true
  let open = 0
  for (const ch of t) {
    if (ch === '(' || ch === '[') open++
    else if (ch === ')' || ch === ']') open--
  }
  return open > 0
}

function stripStringsAndComments(line: string): string {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')
}

function indentOf(line: string): number {
  let n = 0
  for (const ch of line) {
    if (ch === ' ') n++
    else if (ch === '\t') n += 4
    else break
  }
  return n
}
