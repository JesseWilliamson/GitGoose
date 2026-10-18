/**
 * Which language a file is, by extension, and how its definitions look.
 *
 * This is the part of codegraph to grow: each language is a list of line patterns. A pattern
 * matches from the first non-blank character of a line, and its first capture group is the name.
 * Regexes cannot parse code, and do not try to: they find the lines where things are *defined*,
 * which are written in a few stable shapes in every language. That is enough for "where is this
 * defined?" and "what function is this line in?", it costs nothing to run, and it works the same
 * on every language without installing a parser per language.
 */

export type Language = 'ts' | 'python' | 'go' | 'rust' | 'java' | 'kotlin' | 'csharp' | 'c' | 'ruby' | 'php' | 'swift'

export type DefinitionKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'module'

/** How a language marks where a definition ends: braces, indentation, or Ruby's `end`. */
export type Blocks = 'braces' | 'indent' | 'end'

interface Pattern {
  re: RegExp
  kind: DefinitionKind
  /** Only on lines that are not indented (top level). */
  topLevel?: boolean
  /**
   * A loose shape ("name(…) {") that keywords also fit (if, while, catch, new): reject names in
   * NOT_NAMES. Explicit shapes (fn x, def x) never need it: `fn new` is a fine name in Rust.
   */
  guard?: boolean
}

export interface LanguageSpec {
  blocks: Blocks
  patterns: Pattern[]
}

const EXT: Record<string, Language> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts',
  py: 'python', pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  cs: 'csharp',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', m: 'c', mm: 'c',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
}

export function languageOf(path: string): Language | null {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? null : (EXT[path.slice(dot + 1).toLowerCase()] ?? null)
}

/** Words that look like a call followed by a block but are not definitions (for guarded patterns). */
export const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'new', 'await', 'typeof', 'sizeof', 'elif', 'when', 'match', 'using', 'lock', 'foreach', 'super', 'this'])

const JAVA_MODS = '(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|override|virtual|sealed|async|internal|extern|unsafe|partial|readonly|new)\\s+)'

export const LANGUAGES: Record<Language, LanguageSpec> = {
  ts: {
    blocks: 'braces',
    patterns: [
      { re: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
      { re: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
      { re: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
      { re: /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, kind: 'type' },
      { re: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
      // const f = (…) => / async (…) => / function (…)
      { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>)/, kind: 'function' },
      { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'const', topLevel: true },
      // Methods: name(…) { inside a class body (indented).
      { re: /^(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\([^)]*\)?\s*(?::\s*[^={]+)?\{\s*$/, kind: 'method', guard: true },
    ],
  },
  python: {
    blocks: 'indent',
    patterns: [
      { re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function' },
      { re: /^class\s+([A-Za-z_]\w*)/, kind: 'class' },
      { re: /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/, kind: 'const', topLevel: true },
    ],
  },
  go: {
    blocks: 'braces',
    patterns: [
      { re: /^func\s+\([^)]*\)\s*([A-Za-z_]\w*)/, kind: 'method' },
      { re: /^func\s+([A-Za-z_]\w*)/, kind: 'function' },
      { re: /^type\s+([A-Za-z_]\w*)\s+interface\b/, kind: 'interface' },
      { re: /^type\s+([A-Za-z_]\w*)\s+struct\b/, kind: 'class' },
      { re: /^type\s+([A-Za-z_]\w*)/, kind: 'type' },
      { re: /^(?:var|const)\s+([A-Za-z_]\w*)/, kind: 'const', topLevel: true },
    ],
  },
  rust: {
    blocks: 'braces',
    patterns: [
      { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
      { re: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'class' },
      { re: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum' },
      { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'interface' },
      { re: /^(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, kind: 'type' },
      { re: /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, kind: 'module' },
      { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)/, kind: 'const' },
    ],
  },
  java: {
    blocks: 'braces',
    patterns: [
      { re: new RegExp(`^${JAVA_MODS}*(?:class|interface|enum|record|@interface)\\s+([A-Za-z_]\\w*)`), kind: 'class' },
      { re: new RegExp(`^${JAVA_MODS}+(?:<[^>]+>\\s+)?[\\w<>\\[\\],.?\\s]+?\\s+([A-Za-z_]\\w*)\\s*\\(`), kind: 'method', guard: true },
    ],
  },
  kotlin: {
    blocks: 'braces',
    patterns: [
      { re: /^(?:(?:public|private|protected|internal|open|override|suspend|inline|operator|abstract)\s+)*fun\s+(?:<[^>]+>\s+)?(?:[\w.]+\.)?([A-Za-z_]\w*)/, kind: 'function' },
      { re: /^(?:(?:public|private|protected|internal|open|abstract|sealed|data|enum|inner|annotation)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/, kind: 'class' },
      { re: /^(?:(?:public|private|protected|internal|const)\s+)*(?:val|var)\s+([A-Za-z_]\w*)/, kind: 'const', topLevel: true },
    ],
  },
  csharp: {
    blocks: 'braces',
    patterns: [
      { re: new RegExp(`^${JAVA_MODS}*(?:class|interface|enum|struct|record)\\s+([A-Za-z_]\\w*)`), kind: 'class' },
      { re: new RegExp(`^${JAVA_MODS}+[\\w<>\\[\\],.?\\s]+?\\s+([A-Za-z_]\\w*)\\s*(?:<[^>]+>)?\\s*\\(`), kind: 'method', guard: true },
    ],
  },
  c: {
    blocks: 'braces',
    patterns: [
      { re: /^#\s*define\s+([A-Za-z_]\w*)/, kind: 'const' },
      { re: /^(?:typedef\s+)?(?:struct|class|union)\s+([A-Za-z_]\w*)\s*(?:[:{]|$)/, kind: 'class' },
      { re: /^(?:typedef\s+)?enum\s+(?:class\s+)?([A-Za-z_]\w*)/, kind: 'enum' },
      // A top-level line "type name(args)" not ending in ";": a function definition.
      { re: /^(?!return\b|else\b)[\w*&:<>,\s]*?[\w*&>]\s+\**&?(?:[\w]+::)*~?([A-Za-z_]\w*)\s*\([^;]*$/, kind: 'function', topLevel: true, guard: true },
    ],
  },
  ruby: {
    blocks: 'end',
    patterns: [
      { re: /^def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, kind: 'function' },
      { re: /^class\s+([A-Z]\w*)/, kind: 'class' },
      { re: /^module\s+([A-Z]\w*)/, kind: 'module' },
    ],
  },
  php: {
    blocks: 'braces',
    patterns: [
      { re: /^(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?([A-Za-z_]\w*)/, kind: 'function' },
      { re: /^(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, kind: 'class' },
    ],
  },
  swift: {
    blocks: 'braces',
    patterns: [
      { re: /^(?:(?:public|private|fileprivate|internal|open|static|class|override|final|mutating|@\w+)\s+)*func\s+([A-Za-z_]\w*)/, kind: 'function' },
      { re: /^(?:(?:public|private|fileprivate|internal|open|final)\s+)*(?:class|struct|enum|protocol|actor|extension)\s+([A-Za-z_]\w*)/, kind: 'class' },
    ],
  },
}
