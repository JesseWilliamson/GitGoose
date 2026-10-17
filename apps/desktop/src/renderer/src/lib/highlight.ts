import type { HighlighterCore, ThemedToken } from 'shiki/core'

/**
 * Syntax highlighting, loaded only when a diff is first shown.
 *
 * We use Shiki's core build with the JavaScript regex engine (no WebAssembly, so the page's
 * strict Content-Security-Policy stays intact), and import each language grammar on demand:
 * opening a TypeScript diff loads only the TypeScript grammar.
 */

const LANGS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
}

const EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript',
  cjs: 'javascript', jsx: 'jsx', json: 'json', css: 'css', scss: 'css', html: 'html', htm: 'html',
  md: 'markdown', py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  sql: 'sql', vue: 'vue', svelte: 'svelte',
}

export function languageFor(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return EXT[ext] ?? null
}

let highlighter: Promise<HighlighterCore> | null = null
const loaded = new Set<string>()

async function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, dark, light] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/themes/github-dark-default.mjs'),
      import('shiki/themes/github-light-default.mjs'),
    ])
    return createHighlighterCore({
      themes: [dark.default, light.default],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })
  })()
  return highlighter
}

export type Tokens = ThemedToken[][]

/** Tokenize `code` (lines joined by \n). Returns null if the language is unknown or the input too big. */
export async function tokenize(code: string, path: string, dark: boolean, maxChars = 400_000): Promise<Tokens | null> {
  const lang = languageFor(path)
  if (!lang || code.length > maxChars) return null
  const h = await getHighlighter()
  if (!loaded.has(lang)) {
    const mod = (await LANGS[lang]!()) as { default: Parameters<HighlighterCore['loadLanguage']>[0] }
    await h.loadLanguage(mod.default)
    loaded.add(lang)
  }
  return h.codeToTokensBase(code, { lang, theme: dark ? 'github-dark-default' : 'github-light-default' })
}
