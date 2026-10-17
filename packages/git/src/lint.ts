import type { FileDiff, FindingSeverity, ReviewFinding } from '@gitsquid/shared'
import { scanSecrets } from './secrets'

/**
 * Findings that come from tools rather than the model: linters run on the changed files, and the
 * built-in secret scan run on the added lines. They are facts about the code, so they skip the
 * checks the model's findings get (and the review profile: a linter the user chose to run is
 * shown whatever the profile), but they are still kept to lines the change touched.
 */

export interface LintMessage {
  /** Relative to the repository root, with forward slashes. */
  path: string
  line: number
  endLine?: number
  severity: 'error' | 'warning'
  message: string
  rule?: string
}

function relative(path: string, root: string): string {
  const p = path.replace(/\\/g, '/')
  const r = root.replace(/\\/g, '/').replace(/\/$/, '')
  const rel = p.startsWith(`${r}/`) ? p.slice(r.length + 1) : p
  return rel.replace(/^\.\//, '')
}

/**
 * A linter's output. Two shapes: ESLint's JSON (`--format json`: an array of files with messages),
 * and the one-line format almost every other linter can write (gcc / unix / concise):
 *   path:line:col: message
 *   path:line:col: warning: message [rule]
 *   path:line: message
 * Lines that do not look like either are ignored (summaries, banners).
 */
export function parseLintOutput(text: string, root: string): LintMessage[] {
  const t = text.trim()
  if (t.startsWith('[')) {
    try {
      const files = JSON.parse(t) as { filePath?: unknown; messages?: unknown }[]
      if (Array.isArray(files)) {
        return files.flatMap((f) => {
          if (typeof f?.filePath !== 'string' || !Array.isArray(f.messages)) return []
          return (f.messages as Record<string, unknown>[]).flatMap((m) => typeof m.line !== 'number' || typeof m.message !== 'string' ? [] : [{
            path: relative(f.filePath as string, root),
            line: m.line,
            endLine: typeof m.endLine === 'number' && m.endLine >= m.line ? m.endLine : undefined,
            severity: m.severity === 2 ? 'error' as const : 'warning' as const,
            message: m.message.trim(),
            rule: typeof m.ruleId === 'string' ? m.ruleId : undefined,
          }])
        })
      }
    } catch {
      // Not JSON after all; try lines.
    }
  }
  const out: LintMessage[] = []
  for (const raw of text.split('\n')) {
    const m = /^(.+?):(\d+)(?::\d+)?:\s*(.+)$/.exec(raw.trim())
    if (!m || /^\d+$/.test(m[1]!)) continue
    let rest = m[3]!.trim()
    let severity: LintMessage['severity'] = 'warning'
    const level = /^(error|fatal|warning|warn|note|info|style)\s*:\s*/i.exec(rest)
    if (level) {
      if (/^(error|fatal)$/i.test(level[1]!)) severity = 'error'
      rest = rest.slice(level[0].length)
    }
    // A trailing [rule] (ESLint unix, ShellCheck gcc) or a leading code (Ruff "F401 …", flake8).
    let rule: string | undefined
    const tail = /\s*\[([\w@/.-]+)\]$/.exec(rest)
    if (tail) {
      rule = tail[1]
      rest = rest.slice(0, tail.index)
      if (/^error$/i.test(rule!)) { severity = 'error'; rule = undefined }
      else if (/^warning$/i.test(rule!)) rule = undefined
      else {
        const inner = /^(Error|Warning)\/(.+)$/.exec(rule!)
        if (inner) { severity = inner[1] === 'Error' ? 'error' : 'warning'; rule = inner[2] }
      }
    } else {
      const code = /^([A-Z]{1,4}\d{2,5})\s+/.exec(rest)
      if (code) {
        rule = code[1]
        rest = rest.slice(code[0].length).replace(/^\[\*\]\s*/, '') // Ruff's "[*]": fixable
      }
    }
    if (!rest) continue
    out.push({ path: relative(m[1]!, root), line: Number(m[2]), severity, message: rest, rule })
  }
  return out
}

/** New-side numbers of the lines a change adds, per file. Stricter than the hunks: no context lines. */
export type AddedLines = Map<string, Set<number>>

export function addedLines(files: FileDiff[]): AddedLines {
  const m: AddedLines = new Map()
  for (const f of files) {
    const set = new Set<number>()
    for (const h of f.hunks) for (const l of h.lines) if (l.kind === '+' && l.newNo !== undefined) set.add(l.newNo)
    if (set.size) m.set(f.path, set)
  }
  return m
}

function touches(lines: AddedLines, path: string, start: number, end: number): boolean {
  const set = lines.get(path)
  if (!set) return false
  for (let n = start; n <= end; n++) if (set.has(n)) return true
  return false
}

/**
 * A linter's messages on lines the change added, as findings. Reports about other lines are left
 * out, context lines included: they were there before this change and are not what it is about.
 */
export function lintFindings(messages: LintMessage[], lines: AddedLines, tool: string): { findings: ReviewFinding[]; outside: number } {
  const seen = new Set<string>()
  const findings: ReviewFinding[] = []
  let outside = 0
  for (const m of messages) {
    const end = m.endLine ?? m.line
    if (!touches(lines, m.path, m.line, end)) {
      outside++
      continue
    }
    const key = `${m.path}:${m.line}:${m.rule ?? ''}:${m.message}`
    if (seen.has(key)) continue
    seen.add(key)
    const severity: FindingSeverity = m.severity === 'error' ? 'major' : 'minor'
    findings.push({
      id: '', path: m.path, startLine: m.line, endLine: end,
      type: m.severity === 'error' ? 'bug' : 'maintainability', severity,
      title: m.message.split('\n')[0]!.slice(0, 120),
      message: m.rule ? `${m.message} (${tool}: ${m.rule})` : `${m.message} (${tool})`,
      source: 'lint', tool: m.rule ? `${tool} ${m.rule}` : tool,
    })
  }
  return { findings, outside }
}

/** Secrets on added lines. Removed lines are not flagged: deleting a secret is the fix, not the leak. */
export function secretFindings(files: FileDiff[]): ReviewFinding[] {
  const out: ReviewFinding[] = []
  for (const f of files) {
    if (f.binary) continue
    for (const h of f.hunks) {
      const added = h.lines.filter((l) => l.kind === '+' && l.newNo !== undefined)
      if (!added.length) continue
      // Scan the added lines together, so a key block spread over several lines is one hit.
      const text = added.map((l) => l.text).join('\n')
      const starts: number[] = []
      for (let i = 0, at = 0; i < added.length; at += added[i]!.text.length + 1, i++) starts.push(at)
      const lineOf = (index: number) => {
        let i = 0
        while (i + 1 < starts.length && starts[i + 1]! <= index) i++
        return added[i]!.newNo!
      }
      for (const hit of scanSecrets(text)) {
        out.push({
          id: '', path: f.path, startLine: lineOf(hit.index), endLine: lineOf(hit.index + hit.length - 1),
          type: 'security', severity: 'critical',
          title: `Possible ${hit.kind} in the code`,
          message: `This adds what looks like a ${hit.kind} (${hit.masked}). Anyone who can read the repository can use it, and it stays in the history after it is deleted. Load it from the environment or a secret store instead, and revoke this one if it is real.`,
          source: 'scan', tool: 'secret scan',
        })
      }
    }
  }
  return out
}
