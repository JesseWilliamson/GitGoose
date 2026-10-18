import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Language, Parser, Query } from 'web-tree-sitter'
import registry from '../grammars.json'

/**
 * The tree-sitter grammars we parse with: each is the official grammar package's prebuilt
 * WASM, with that package's own tags query (so grammar and query never drift apart).
 *
 * Tags queries name definitions (`@definition.function`, `@definition.class`, …) and
 * references (`@reference.call`, `@reference.type`, …) with a `@name` capture for the
 * identifier. They are the same queries GitHub's code navigation runs.
 */
export type GrammarId = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'rust' | 'java' | 'kotlin' | 'c_sharp' | 'c' | 'cpp' | 'ruby' | 'php'

interface GrammarSpec {
  /** `<package>/<file>` of the WASM parser. */
  wasm: string
  /** `<package>/<file>` of each query to stack, in order. */
  queries: string[]
}

/** A file inside a package: what the locator turns into a path on disk. */
export interface PackageFile {
  pkg: string
  file: string
}

/**
 * The registry lives in grammars.json so the packaging script (plain Node, no TypeScript) can
 * read the same list. TypeScript's query only adds what TypeScript adds to JavaScript, so it
 * stacks on the JavaScript one. The Kotlin package ships no query; ours is in this package.
 */
export const GRAMMARS: Record<GrammarId, GrammarSpec> = registry as Record<GrammarId, GrammarSpec>

/**
 * What the tags queries leave out. Imports: an import is a reference too (Impact lists the
 * files that import a changed symbol), in languages that import by name (Go and C import files
 * or packages). TypeScript's query also skips type arguments (`Promise<Cart>`).
 */
const EXTRAS: Partial<Record<GrammarId, string>> = {
  javascript: '(import_specifier name: (identifier) @name) @reference.import\n(import_clause (identifier) @name) @reference.import',
  python: '(import_from_statement name: (dotted_name (identifier) @name)) @reference.import\n(aliased_import name: (dotted_name (identifier) @name)) @reference.import',
  // Rust's query tags `f()` and `x.f()` as calls but not `T::f()`.
  rust: '(use_declaration argument: (scoped_identifier name: (identifier) @name)) @reference.import\n(use_list (identifier) @name) @reference.import\n(call_expression function: (scoped_identifier name: (identifier) @name)) @reference.call',
  java: '(import_declaration (scoped_identifier name: (identifier) @name)) @reference.import',
  kotlin: '(import (qualified_identifier (identifier) @name .)) @reference.import\n(import (identifier) @name) @reference.import',
  php: [
    '(namespace_use_clause (qualified_name (name) @name)) @reference.import',
    '(namespace_use_clause (name) @name) @reference.import',
    '(function_call_expression function: (name) @name) @reference.call',
    '(member_call_expression name: (name) @name) @reference.call',
    '(scoped_call_expression name: (name) @name) @reference.call',
    '(object_creation_expression (name) @name) @reference.class',
  ].join('\n'),
  // The C, C++ and C# queries tag definitions only.
  c: '(call_expression function: (identifier) @name) @reference.call',
  cpp: [
    '(call_expression function: (identifier) @name) @reference.call',
    '(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call',
    '(call_expression function: (qualified_identifier name: (identifier) @name)) @reference.call',
  ].join('\n'),
  c_sharp: [
    '(invocation_expression function: (identifier) @name) @reference.call',
    '(invocation_expression function: (member_access_expression name: (identifier) @name)) @reference.call',
    '(object_creation_expression type: (identifier) @name) @reference.class',
  ].join('\n'),
}
EXTRAS.typescript = EXTRAS.javascript + '\n(type_arguments (type_identifier) @name) @reference.type'
EXTRAS.tsx = EXTRAS.typescript

const EXT: Record<string, GrammarId> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx', jsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  cs: 'c_sharp',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  rb: 'ruby',
  php: 'php',
}

/** Which grammar parses a file, by extension; null for a file we do not parse. */
export function grammarOf(path: string): GrammarId | null {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? null : (EXT[path.slice(dot + 1).toLowerCase()] ?? null)
}

/** Every file the grammars need, for copying into an app's resources. */
export function grammarFiles(): PackageFile[] {
  const out = new Map<string, PackageFile>()
  for (const g of Object.values(GRAMMARS)) {
    for (const f of [g.wasm, ...g.queries]) out.set(f, splitPackageFile(f))
  }
  return [...out.values()]
}

function splitPackageFile(spec: string): PackageFile {
  // "@scope/name/file" or "name/path/file".
  const parts = spec.split('/')
  const n = spec.startsWith('@') ? 2 : 1
  return { pkg: parts.slice(0, n).join('/'), file: parts.slice(n).join('/') }
}

/** Where a package's file is on disk. */
export type Locator = (f: PackageFile) => string

/** This package's name, for the files (queries) it holds itself. */
export const OWN_PACKAGE = '@gitgoose/codegraph'

/** Resolve through Node's module resolution from here: development and tests. */
export function nodeLocator(from: string = import.meta.url): Locator {
  const require = createRequire(from)
  // Our own files resolve relative to this source, not by package name: a package without an
  // "exports" map cannot refer to itself by name from inside.
  return (f) => (f.pkg === OWN_PACKAGE ? fileURLToPath(new URL(`../${f.file}`, import.meta.url)) : require.resolve(`${f.pkg}/${f.file}`))
}

/** Files copied under one directory, keeping `<package>/<file>`: the packaged app. */
export function directoryLocator(dir: string): Locator {
  return (f) => join(dir, f.pkg, f.file)
}

export interface LoadedGrammar {
  id: GrammarId
  language: Language
  query: Query
}

/**
 * Loads grammars on first use and keeps them: a language's WASM costs 5-40 ms to compile and is
 * shared by every file in it. `Parser.init` (the tree-sitter runtime itself) runs once.
 */
export class Grammars {
  private inited: Promise<void> | null = null
  private loaded = new Map<GrammarId, Promise<LoadedGrammar>>()

  constructor(private locate: Locator = nodeLocator()) {}

  get(id: GrammarId): Promise<LoadedGrammar> {
    let p = this.loaded.get(id)
    if (!p) {
      p = this.load(id)
      p.catch(() => this.loaded.delete(id))
      this.loaded.set(id, p)
    }
    return p
  }

  private async load(id: GrammarId): Promise<LoadedGrammar> {
    this.inited ??= Parser.init()
    await this.inited
    const spec = GRAMMARS[id]
    const language = await Language.load(this.locate(splitPackageFile(spec.wasm)))
    const text = spec.queries.map((q) => readFileSync(this.locate(splitPackageFile(q)), 'utf8')).join('\n')
    const query = new Query(language, text + '\n' + (EXTRAS[id] ?? ''))
    return { id, language, query }
  }
}
