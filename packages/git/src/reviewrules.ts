/**
 * What a review is told about the project, besides the diff: guideline files the repository
 * already has for AI tools, CodeRabbit's path instructions, and learnings saved from dismissed
 * findings. Pure; Repo.reviewContext reads the files.
 */

/** Files people write for AI tools; each applies to its own directory and below. */
export const GUIDELINE_NAMES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules', '.windsurfrules', '.github/copilot-instructions.md']

export interface Guideline {
  path: string
  /** The directory it covers ('' for the whole repository). */
  scope: string
}

/** The guideline files among `allPaths` that cover at least one changed file. */
export function relevantGuidelines(allPaths: string[], changed: string[]): Guideline[] {
  const out: Guideline[] = []
  for (const p of allPaths) {
    const name = GUIDELINE_NAMES.find((n) => p === n || p.endsWith(`/${n}`))
    if (!name) continue
    // .github/copilot-instructions.md covers the repository it is in, not .github/.
    const scope = p.slice(0, p.length - name.length).replace(/\/$/, '')
    if (changed.some((c) => !scope || c.startsWith(`${scope}/`))) out.push({ path: p, scope })
  }
  // Broadest first: the reader goes from the general rules to the specific ones.
  return out.sort((a, b) => a.scope.split('/').filter(Boolean).length - b.scope.split('/').filter(Boolean).length || a.path.localeCompare(b.path))
}

/** A glob as CodeRabbit and .gitignore-style tools write them: ** any directories, * any name part. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        i++
        re += '(?:.*/)?'
      } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  // A pattern without a slash matches the name anywhere, as in .gitignore.
  return new RegExp(glob.includes('/') ? `^${re}$` : `(?:^|/)${re}$`)
}

export interface PathInstruction {
  path: string
  instructions: string
}

/**
 * `reviews.path_instructions` from a .coderabbit.yaml: a list of `- path: <glob>` with
 * `instructions:` as a quoted string, a plain line, or a `|` / `>` block. Only this one section
 * is read, so no YAML library is needed; anything else in the file is ignored.
 */
export function parsePathInstructions(yaml: string): PathInstruction[] {
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((l) => /^\s*path_instructions:\s*$/.test(l))
  if (start < 0) return []
  const baseIndent = lines[start]!.search(/\S/)
  const out: PathInstruction[] = []
  let cur: Partial<PathInstruction> | null = null
  const unquote = (v: string) => v.trim().replace(/^(["'])([\s\S]*)\1$/, '$2')
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() && line.search(/\S/) <= baseIndent) break
    const item = /^\s*-\s+path:\s*(.+)$/.exec(line)
    const key = /^\s*(path|instructions):\s*(.*)$/.exec(line)
    if (item) {
      if (cur?.path && cur.instructions) out.push(cur as PathInstruction)
      cur = { path: unquote(item[1]!) }
    } else if (key && cur) {
      if (key[1] === 'path') cur.path = unquote(key[2]!)
      else if (/^[|>][-+]?\s*$/.test(key[2]!)) {
        // A block: the following lines indented deeper than this key.
        const indent = line.search(/\S/)
        const block: string[] = []
        while (i + 1 < lines.length && (!lines[i + 1]!.trim() || lines[i + 1]!.search(/\S/) > indent)) block.push(lines[++i]!.trim())
        cur.instructions = (key[2]!.startsWith('>') ? block.join(' ') : block.join('\n')).trim()
      } else cur.instructions = unquote(key[2]!)
    }
  }
  if (cur?.path && cur.instructions) out.push(cur as PathInstruction)
  return out
}

/**
 * `reviews.pre_merge_checks.custom_checks` from a .coderabbit.yaml: `- name:` items with
 * `instructions:` (quoted, plain, or a | / > block) and `mode:` (warning, error, off). CodeRabbit
 * runs these before a merge; here they run before a push. error blocks, warning warns, off is
 * left out. Like path_instructions, only this section is read.
 */
export function parseCustomChecks(yaml: string): { name: string; instructions: string; mode: 'warn' | 'block' }[] {
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((l) => /^\s*custom_checks:\s*$/.test(l))
  if (start < 0) return []
  const baseIndent = lines[start]!.search(/\S/)
  const out: { name: string; instructions: string; mode: 'warn' | 'block' }[] = []
  let cur: { name?: string; instructions?: string; mode?: string } | null = null
  const unquote = (v: string) => v.trim().replace(/^(["'])([\s\S]*)\1$/, '$2')
  const flush = () => {
    if (cur?.name && cur.instructions && cur.mode !== 'off') out.push({ name: cur.name, instructions: cur.instructions, mode: cur.mode === 'error' ? 'block' : 'warn' })
  }
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() && line.search(/\S/) <= baseIndent) break
    const item = /^\s*-\s+(name|instructions|mode):\s*(.*)$/.exec(line)
    const key = item ?? /^\s*(name|instructions|mode):\s*(.*)$/.exec(line)
    if (item) {
      flush()
      cur = {}
    }
    if (!key || !cur) continue
    const value = key[2]!
    if (key[1] === 'instructions' && /^[|>][-+]?\s*$/.test(value)) {
      const indent = line.search(/\S/) + (item ? 2 : 0)
      const block: string[] = []
      while (i + 1 < lines.length && (!lines[i + 1]!.trim() || lines[i + 1]!.search(/\S/) > indent)) block.push(lines[++i]!.trim())
      cur.instructions = (value.startsWith('>') ? block.join(' ') : block.join('\n')).trim()
    } else if (key[1] === 'mode') cur.mode = unquote(value).toLowerCase()
    else cur[key[1] as 'name' | 'instructions'] = unquote(value)
  }
  flush()
  return out
}
