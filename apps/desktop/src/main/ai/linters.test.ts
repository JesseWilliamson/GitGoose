import { addedLines, Repo } from '@gitgoose/git'
import { makeFixture, tempDir } from '@gitgoose/fixtures'
import { defaultSettings, type Settings } from '@gitgoose/shared'
import { mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decisionKey, detectLinters, linters, lintForReview, runLinter, toolName } from './linters'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const f of cleanup.splice(0)) f()
})

/** A linter: reports every line that says TODO, in the unix format, and exits 1 like real ones. */
function fakeLinter(): string {
  const script = join(tempDir(), 'todo-lint.mjs')
  writeFileSync(script, [
    "import { readFileSync } from 'node:fs'",
    'let found = 0',
    'for (const f of process.argv.slice(2)) readFileSync(f, "utf8").split("\\n").forEach((l, i) => { if (l.includes("TODO")) { found++; console.log(`${f}:${i + 1}:1: unfinished work [Warning/no-todo]`) } })',
    'process.exit(found ? 1 : 0)',
  ].join('\n'))
  return `"${process.execPath}" "${script}" {files}`
}

async function setup(command: string, allow: boolean | null) {
  const r = makeFixture('linear')
  r.write('a.ts', 'one\n')
  r.git('add', '-A')
  r.git('commit', '-q', '-m', 'a')
  const repo = await Repo.open(r.dir, {})
  cleanup.push(() => repo.dispose())
  const settings: Settings = { ...defaultSettings(), reviewLinter: command, linterDecisions: allow === null ? {} : { [decisionKey(repo.path, command)]: allow } }
  return { r, repo, settings }
}

describe('linters in reviews', () => {
  it('runs an allowed linter on the reviewed files and keeps reports on changed lines', async () => {
    const cmd = fakeLinter()
    const { r, repo, settings } = await setup(cmd, true)
    // Line 1 had a TODO before this change; line 3 is new.
    r.write('a.ts', 'one TODO\n')
    r.git('commit', '-qam', 'old todo')
    r.write('a.ts', 'one TODO\ntwo\nthree TODO\n')
    r.write('weird; name.ts', 'TODO\n')
    const input = await repo.reviewInput({ kind: 'working' })
    const res = await lintForReview(repo.path, settings, input.files.map((f) => f.path), input.texts, addedLines(input.files))
    expect(res.findings.map((f) => [f.path, f.startLine, f.tool, f.source])).toEqual([
      ['a.ts', 3, 'todo-lint no-todo', 'lint'],
      ['weird; name.ts', 1, 'todo-lint no-todo', 'lint'],
    ])
    expect(res.runs).toMatchObject([{ status: 'ran', files: 2, findings: 2, note: '1 more on lines this change did not touch' }])
    expect(res.report.join('\n')).toContain('a.ts:3')
  })

  it('runs nothing the user has not allowed for this repository', async () => {
    const cmd = fakeLinter()
    for (const allow of [null, false]) {
      const { r, repo, settings } = await setup(cmd, allow)
      r.write('a.ts', 'TODO\n')
      const input = await repo.reviewInput({ kind: 'working' })
      const res = await lintForReview(repo.path, settings, ['a.ts'], input.texts, addedLines(input.files))
      expect(res.findings).toEqual([])
      expect(res.runs[0]).toMatchObject({ status: 'skipped', note: allow === null ? 'not allowed yet' : 'you chose not to run it here' })
      expect(linters(repo.path, settings, ['a.ts']).find((l) => l.source === 'settings')!.decision).toBe(allow === null ? null : 'deny')
    }
  })

  it('does not lint a file whose text on disk is not the reviewed text', async () => {
    const { r, repo, settings } = await setup(fakeLinter(), true)
    r.write('a.ts', 'TODO staged\n')
    r.git('add', 'a.ts')
    r.write('a.ts', 'TODO staged\nmore edits\n')
    const input = await repo.reviewInput({ kind: 'staged' })
    const res = await lintForReview(repo.path, settings, ['a.ts'], input.texts, addedLines(input.files))
    expect(res.runs).toEqual([])
    expect(res.findings).toEqual([])
  })

  it('reports a linter that is missing or hangs instead of failing the review', async () => {
    const dir = tempDir()
    expect(await runLinter(dir, 'no-such-linter-xyz {files}', ['a'])).toMatchObject({ ok: false, note: 'no-such-linter-xyz was not found' })
    const hang = join(dir, 'hang.mjs')
    writeFileSync(hang, 'setInterval(() => {}, 1000)')
    expect(await runLinter(dir, `"${process.execPath}" "${hang}"`, [], 300)).toMatchObject({ ok: false, note: 'stopped after 0 s' })
  })

  it('names a command after its tool, not its runner', () => {
    expect(toolName('npx stylelint --formatter unix {files}')).toBe('stylelint')
    expect(toolName('"/usr/bin/node" ./tools/lint.mjs {files}')).toBe('lint')
    expect(toolName('golangci-lint run --out-format line-number')).toBe('golangci-lint')
  })

  it('detects ESLint only when the repository has it installed', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'package.json'), '{"devDependencies": {"eslint": "^9.0.0"}}')
    expect(detectLinters(dir, []).map((l) => l.name)).not.toContain('ESLint')
    mkdirSync(join(dir, 'node_modules', 'eslint', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'eslint', 'bin', 'eslint.js'), 'console.log("[]")\n')
    const eslint = detectLinters(dir, []).find((l) => l.name === 'ESLint')
    expect(eslint).toMatchObject({ command: expect.stringContaining('--format json {files}') })
    expect(toolName(eslint!.command)).toBe('eslint')
  })

  it('offers ShellCheck only where there are shell scripts, not just because it is installed', () => {
    const bin = tempDir()
    writeFileSync(join(bin, process.platform === 'win32' ? 'shellcheck.exe' : 'shellcheck'), '')
    const saved = process.env.PATH
    process.env.PATH = [bin, saved].join(delimiter)
    try {
      const dir = tempDir()
      const names = (files: string[]) => detectLinters(dir, files).map((l) => l.name)
      expect(names(['src/a.ts', 'README.md'])).not.toContain('ShellCheck')
      expect(names(['src/a.ts', 'scripts/build.sh'])).toContain('ShellCheck')
      writeFileSync(join(dir, '.shellcheckrc'), 'disable=SC2086\n')
      expect(names(['src/a.ts'])).toContain('ShellCheck')
    } finally {
      process.env.PATH = saved
    }
  })

  it('runs a detected ESLint without a shell, on every platform', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'package.json'), '{"devDependencies": {"eslint": "^9.0.0"}}')
    mkdirSync(join(dir, 'node_modules', 'eslint', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'eslint', 'bin', 'eslint.js'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
    writeFileSync(join(dir, 'a b.ts'), '')
    const res = await runLinter(dir, detectLinters(dir, []).find((l) => l.name === 'ESLint')!.command, ['a b.ts'])
    expect(res).toMatchObject({ ok: true })
    expect(JSON.parse(res.output)).toEqual(['--format', 'json', 'a b.ts'])
  })
})
