import { Parser, type Node, type QueryMatch } from 'web-tree-sitter'
import { Grammars, grammarOf, type GrammarId, type LoadedGrammar } from './grammars'
import type { DefinitionKind } from './languages'

/** Something a file defines, as the graph stores it. */
export interface Symbol {
  name: string
  kind: DefinitionKind
  /** 1-based, inclusive. */
  line: number
  endLine: number
  /** The defining line, trimmed: what a peek shows first. */
  signature: string
  /** The class (or module) this is defined inside, if any. */
  parent?: string
}

export type ReferenceKind = 'call' | 'type' | 'class' | 'implementation' | 'import' | 'send'

/** A use of a name: a call, a type annotation, a constructor call, an import. */
export interface Reference {
  name: string
  kind: ReferenceKind
  /** 1-based. */
  line: number
  column: number
  /** The definition this use sits inside ("called from `function checkout`"). */
  within?: string
}

export interface Extracted {
  symbols: Symbol[]
  refs: Reference[]
}

/** Files above this are data, not code; parsing them would only cost time. */
const MAX_BYTES = 1_000_000

/** How the tags queries' capture names map onto our kinds. Unknown ones are skipped. */
const DEFINITION_KINDS: Record<string, DefinitionKind> = {
  function: 'function', method: 'method', class: 'class', interface: 'interface', type: 'type',
  module: 'module', constant: 'const', macro: 'function', enum: 'enum', field: 'const', struct: 'class', union: 'class',
}
const REFERENCE_KINDS: Record<string, ReferenceKind> = {
  call: 'call', type: 'type', class: 'class', implementation: 'implementation', import: 'import', send: 'send', interface: 'type',
}

/**
 * The symbols and references one tags-query match set describes. Pure given the matches, so the
 * mapping from capture names to kinds can be tested without a parser.
 */
export function fromMatches(matches: QueryMatch[], lines: string[]): Extracted {
  const symbols: Symbol[] = []
  const refs: Reference[] = []
  // Two patterns can match one definition (Rust tags a `fn` in an impl as both a function and a
  // method): one symbol per name and line, the more specific kind winning.
  const seenSym = new Map<string, Symbol>()
  const seenRef = new Set<string>()
  for (const m of matches) {
    const tag = m.captures.find((c) => c.name.startsWith('definition.') || c.name.startsWith('reference.'))
    const name = m.captures.find((c) => c.name === 'name')
    if (!tag || !name) continue
    const [what, sub] = tag.name.split('.') as ['definition' | 'reference', string]
    const text = name.node.text
    if (!text) continue
    if (what === 'definition') {
      const kind = DEFINITION_KINDS[sub!]
      if (!kind) continue
      const line = tag.node.startPosition.row + 1
      const endLine = tag.node.endPosition.row + 1
      const key = `${text}\0${line}`
      const seen = seenSym.get(key)
      if (seen) {
        if (seen.kind === 'function' && kind === 'method') seen.kind = 'method'
        continue
      }
      const sym: Symbol = { name: text, kind, line, endLine, signature: (lines[line - 1] ?? '').trim().slice(0, 200) }
      seenSym.set(key, sym)
      symbols.push(sym)
    } else {
      const kind = REFERENCE_KINDS[sub!]
      if (!kind) continue
      const line = name.node.startPosition.row + 1
      const column = name.node.startPosition.column + 1
      const key = `${text}\0${line}\0${column}`
      if (seenRef.has(key)) continue
      seenRef.add(key)
      refs.push({ name: text, kind, line, column })
    }
  }
  symbols.sort((a, b) => a.line - b.line || b.endLine - a.endLine)
  // A function inside a class is a method; everything remembers its enclosing definition.
  for (const s of symbols) {
    const p = innermost(symbols, s.line, s)
    if (p) {
      s.parent = p.name
      if (s.kind === 'function' && (p.kind === 'class' || p.kind === 'interface')) s.kind = 'method'
    }
  }
  for (const r of refs) {
    const w = innermost(symbols, r.line)
    if (w) r.within = `${w.kind} ${w.name}`
  }
  refs.sort((a, b) => a.line - b.line || a.column - b.column)
  return { symbols, refs }
}

/** The innermost symbol whose range covers `line` (other than `self`). */
function innermost(symbols: Symbol[], line: number, self?: Symbol): Symbol | null {
  let best: Symbol | null = null
  for (const s of symbols) {
    if (s === self || s.line > line) break
    if (line <= s.endLine && (!best || s.line >= best.line) && !(self && s.line === self.line && s.endLine === self.endLine)) best = s
  }
  return best
}

/**
 * Parses files with tree-sitter and runs the tags query over them. One parser per grammar,
 * reused: creating one is cheap but not free, and parsing is where the time goes.
 */
export class CodeParser {
  private parsers = new Map<GrammarId, Parser>()

  constructor(private grammars: Grammars = new Grammars()) {}

  /** Can this file be parsed (by its name)? */
  supports(path: string): boolean {
    return grammarOf(path) !== null
  }

  /** The symbols and references in a file, or null when no grammar parses it or it is too big. */
  async parse(path: string, text: string): Promise<Extracted | null> {
    const id = grammarOf(path)
    if (!id || text.length > MAX_BYTES) return null
    const g = await this.grammars.get(id)
    const parser = this.parserFor(g)
    const tree = parser.parse(text)
    if (!tree) return null
    try {
      return fromMatches(g.query.matches(tree.rootNode), text.split(/\r?\n/))
    } finally {
      tree.delete()
    }
  }

  private parserFor(g: LoadedGrammar): Parser {
    let p = this.parsers.get(g.id)
    if (!p) {
      p = new Parser()
      p.setLanguage(g.language)
      this.parsers.set(g.id, p)
    }
    return p
  }
}

/** Type re-export so callers need not import web-tree-sitter for node positions. */
export type { Node as SyntaxNode }
