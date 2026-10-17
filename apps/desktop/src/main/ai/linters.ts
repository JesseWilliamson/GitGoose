import { lintFindings, parseLintOutput, type AddedLines } from '@gitsquid/git'
import { commandArgv, type LinterInfo, type LinterRun, type ReviewFinding, type Settings } from '@gitsquid/shared'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Linters during an AI review. Which ones: those the repository is set up for, plus the user's
 * own command from Settings. Running a repository's linter runs its config (an eslint.config.js
 * is code), so nothing runs until the user allowed that exact command for that repository; main
 * checks the decision, the renderer only asks.
 */

const LINT_TIMEOUT_MS = 60_000
const MAX_OUTPUT = 2 * 1024 * 1024

interface Spec { name: string; command: string; extensions: string[] | null; source: LinterInfo['source'] }

function onPath(bin: string): boolean {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && exts.some((e) => existsSync(join(dir, bin + e))))
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** What the repository looks set up for. Only tools that are installed: a review should not download anything. */
export function detectLinters(root: string): Spec[] {
  const out: Spec[] = []
  const pkg = readText(join(root, 'package.json'))
  const eslintBin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'eslint.cmd' : 'eslint')
  if (/"eslint"\s*:/.test(pkg) && existsSync(eslintBin)) {
    out.push({ name: 'ESLint', command: `"${eslintBin}" --format json {files}`, extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'], source: 'detected' })
  }
  const pyproject = readText(join(root, 'pyproject.toml'))
  if ((existsSync(join(root, 'ruff.toml')) || existsSync(join(root, '.ruff.toml')) || /^\[tool\.ruff/m.test(pyproject)) && onPath('ruff')) {
    out.push({ name: 'Ruff', command: 'ruff check --output-format concise --no-cache --quiet {files}', extensions: ['.py', '.pyi'], source: 'detected' })
  }
  if (onPath('shellcheck')) out.push({ name: 'ShellCheck', command: 'shellcheck -f gcc {files}', extensions: ['.sh', '.bash'], source: 'detected' })
  return out
}

const RUNNERS = /^(node|nodejs|bun|deno|python3?|py|ruby|npx|pnpx|bunx|uvx|pnpm|yarn|exec|run|uv)$/

/** "npx stylelint …" is stylelint, "node ./tools/lint.mjs" is lint: the first word that is not a runner. */
export function toolName(command: string): string {
  const words = commandArgv(command, {}).map((w) => w.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat)$/i, ''))
  const name = words.find((w) => w && !w.startsWith('-') && w !== '{files}' && !RUNNERS.test(w.toLowerCase())) ?? words[0] ?? 'linter'
  return name.replace(/\.(m?js|cjs|ts|py|rb|sh)$/, '')
}

export const decisionKey = (root: string, command: string) => `${root}\n${command}`

export function linters(root: string, settings: Settings): LinterInfo[] {
  const specs = detectLinters(root)
  const own = settings.reviewLinter.trim()
  if (own) specs.push({ name: toolName(own), command: own, extensions: null, source: 'settings' })
  return specs.map((s) => {
    const d = settings.linterDecisions[decisionKey(root, s.command)]
    return { ...s, decision: d === true ? 'allow' : d === false ? 'deny' : null }
  })
}

/**
 * Run one linter on some files, without a shell: the command is split into arguments and
 * {files} becomes one argument per file, so no file name can turn into shell syntax. A
 * linter's exit code is not trusted to mean failure (most exit 1 when they find something);
 * it failed when it wrote nothing we could read and exited non-zero.
 */
export function runLinter(root: string, command: string, files: string[], timeoutMs = LINT_TIMEOUT_MS): Promise<{ ok: boolean; output: string; note?: string }> {
  const parts = commandArgv(command, {})
  const at = parts.indexOf('{files}')
  const argv = at < 0 ? [...parts, ...files] : [...parts.slice(0, at), ...files, ...parts.slice(at + 1)]
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const done = (r: { ok: boolean; output: string; note?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const child = spawn(argv[0]!, argv.slice(1), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false })
    const take = (b: Buffer) => {
      if (out.length < MAX_OUTPUT) out += b.toString('utf8')
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const timer = setTimeout(() => {
      child.kill()
      done({ ok: false, output: out, note: `stopped after ${Math.round(timeoutMs / 1000)} s` })
    }, timeoutMs)
    child.on('error', (e) => done({ ok: false, output: '', note: (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${argv[0]} was not found` : e.message }))
    child.on('close', (code) => done({ ok: code === 0 || out.trim().length > 0, output: out, note: code === 0 || out.trim() ? undefined : `exited with ${code}` }))
  })
}

/**
 * The review's lint pass: every allowed linter on the reviewed files it takes, keeping reports on
 * changed lines. A file is only linted when its text on disk is the text being reviewed, since
 * otherwise the linter's line numbers are about something else (a branch that is not checked
 * out, staged changes with more edits on top).
 */
export async function lintForReview(
  root: string, settings: Settings, paths: string[], texts: Map<string, string>, lines: AddedLines,
): Promise<{ findings: ReviewFinding[]; runs: LinterRun[]; report: string[] }> {
  const findings: ReviewFinding[] = []
  const runs: LinterRun[] = []
  const report: string[] = []
  const current = paths.filter((p) => texts.has(p) && readText(join(root, p)) === texts.get(p))
  for (const l of linters(root, settings)) {
    const files = current.filter((p) => !l.extensions || l.extensions.some((e) => p.toLowerCase().endsWith(e)))
    if (!files.length) continue
    if (l.decision !== 'allow') {
      runs.push({ name: l.name, command: l.command, status: 'skipped', files: files.length, findings: 0, note: l.decision === 'deny' ? 'you chose not to run it here' : 'not allowed yet' })
      continue
    }
    const res = await runLinter(root, l.command, files)
    const messages = parseLintOutput(res.output, root)
    if (!res.ok || (res.note && !messages.length)) {
      runs.push({ name: l.name, command: l.command, status: 'failed', files: files.length, findings: 0, note: res.note ?? res.output.trim().split('\n')[0]?.slice(0, 200) })
      continue
    }
    const got = lintFindings(messages, lines, l.name)
    findings.push(...got.findings)
    for (const f of got.findings) report.push(`- ${f.path}:${f.startLine} ${f.tool}: ${f.title}`)
    runs.push({ name: l.name, command: l.command, status: 'ran', files: files.length, findings: got.findings.length, note: got.outside ? `${got.outside} more on lines this change did not touch` : undefined })
  }
  const notLinted = paths.length - current.length
  if (notLinted && runs.length) report.push(`(${notLinted} file${notLinted === 1 ? ' was' : 's were'} not linted: the reviewed text is not what is on disk.)`)
  return { findings, runs, report }
}
