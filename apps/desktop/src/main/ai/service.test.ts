import { Repo } from '@gitsquid/git'
import { fakeAnthropic, makeFixture, tempDir, type FakeAnthropic } from '@gitsquid/fixtures'
import { defaultSettings, type GitSquidEvent, type Settings } from '@gitsquid/shared'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretFile } from './keyStore'
import { buildPrompt, cleanCommitMessage, MAX_DIFF_CHARS } from './prompts'
import { AiService } from './service'

const FAKE = join(import.meta.dirname, '../../../e2e/fake-agent.mjs')
const memoryKeychain = { secure: () => true, encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() }

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f()
})

async function setup(patch: Partial<Settings> = {}, anthropic?: FakeAnthropic) {
  let settings: Settings = {
    ...defaultSettings(),
    aiProvider: 'agent',
    aiAgent: 'custom',
    aiAgentCommand: `"${process.execPath}" "${FAKE}"`,
    ...patch,
  }
  const r = makeFixture('linear')
  r.write('widgets.ts', 'export const widgets = new Map()\n')
  r.git('add', 'widgets.ts')
  const repo = await Repo.open(r.dir, {})
  const events: GitSquidEvent[] = []
  const ai = new AiService({
    settings: () => settings,
    setSettings: (p) => (settings = { ...settings, ...p }),
    repo: () => repo,
    apiKey: new SecretFile(join(tempDir(), 'key.bin'), memoryKeychain),
    emit: (e) => {
      events.push(e)
      // Answer permission questions like a user who allows everything.
      if (e.type === 'ai-permission') queueMicrotask(() => ai.respondPermission(e.request.permissionId, e.request.options[0]!.optionId))
    },
    anthropicBaseURL: anthropic?.url,
  })
  cleanup.push(() => ai.stop(), () => repo.dispose())
  return { ai, events, repo, r, get settings() { return settings } }
}

describe('AI service', () => {
  it('starts nothing and sends nothing before the user agrees', async () => {
    const { ai } = await setup()
    expect(ai.status()).toMatchObject({ provider: 'agent', ready: true, consented: false })
    await expect(ai.run('r1', 'x', { kind: 'commit-message' })).rejects.toMatchObject({ code: 'ai-consent' })
    expect(ai.agent.starts).toBe(0)
    expect(ai.consent().consented).toBe(true)
  })

  it('asks again for a different agent command', async () => {
    const t = await setup()
    t.ai.consent()
    t.ai['deps'].setSettings({ aiAgentCommand: 'other-agent --acp' })
    expect(t.ai.status().consented).toBe(false)
  })

  it('writes a commit message from the staged diff, streaming as it goes', async () => {
    const { ai, events } = await setup()
    ai.consent()
    const res = await ai.run('r1', 'x', { kind: 'commit-message' })
    expect(res.text).toBe('feat: add the widget registry\n\nRegisters widgets by name so plugins can add their own.')
    const texts = events.filter((e) => e.type === 'ai-text' && e.requestId === 'r1')
    expect(texts.length).toBe(3)
  })

  it('routes tool permissions to the user and returns a conflict resolution as a proposal', async () => {
    const t = await setup()
    t.ai.consent()
    writeFileSync(join(t.r.dir, 'story.txt'), 'one\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n')
    const res = await t.ai.run('r2', 'x', { kind: 'resolve-conflict', path: 'story.txt' })
    expect(t.events.some((e) => e.type === 'ai-permission' && e.request.kind === 'edit')).toBe(true)
    expect(res.proposal).toEqual({ path: 'story.txt', content: 'one\nours\ntheirs\n' })
  })

  it('uses the Anthropic API with a key, and refuses the conflict task there', async () => {
    const api = await fakeAnthropic(['The push was rejected ', 'because the remote has new commits.'])
    cleanup.push(() => api.close())
    const { ai, events } = await setup({ aiProvider: 'anthropic', anthropicModel: 'claude-opus-5-5' }, api)
    expect(ai.status()).toMatchObject({ ready: false, label: 'Anthropic API' })
    ai.setApiKey('sk-ant-test')
    ai.consent()
    const res = await ai.run('r3', 'x', { kind: 'explain-error', title: 'Push main', detail: '! [rejected] main -> main (fetch first)' })
    expect(res.text).toBe('The push was rejected because the remote has new commits.')
    expect(api.requests[0]).toMatchObject({ model: 'claude-opus-5-5' })
    expect(api.requests[0]!.headers['x-api-key']).toBe('sk-ant-test')
    expect(api.requests[0]!.messages[0]!.content).toContain('! [rejected] main -> main')
    expect(events.filter((e) => e.type === 'ai-text').length).toBeGreaterThan(0)
    await expect(ai.run('r4', 'x', { kind: 'resolve-conflict', path: 'a.txt' })).rejects.toMatchObject({ code: 'ai-unsupported' })
    expect(ai.agent.starts).toBe(0)
  })
})

describe('secret scan before sending', () => {
  // Built by concatenation so this file does not trip secret scanners itself.
  const TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'

  it('sends nothing that looks like a credential, and sends it redacted when asked', async () => {
    const api = await fakeAnthropic(['Use a credential helper.'])
    cleanup.push(() => api.close())
    const { ai } = await setup({ aiProvider: 'anthropic' }, api)
    ai.setApiKey('sk-ant-test')
    ai.consent()
    const task = { kind: 'explain-error' as const, title: 'Push main', detail: `remote: https://${TOKEN}@github.com/o/r rejected` }
    const err = await ai.run('s1', 'x', task).catch((e: unknown) => e as { code: string; message: string })
    expect(err).toMatchObject({ code: 'ai-secrets' })
    expect(err.message).toContain('GitHub token ghp_…R8 (40 chars)')
    expect(err.message).not.toContain(TOKEN)
    expect(api.requests).toHaveLength(0)

    await ai.run('s2', 'x', task, { redact: true })
    const sent = JSON.stringify(api.requests[0])
    expect(sent).toContain('[REDACTED GitHub token]')
    expect(sent).not.toContain(TOKEN)
  })

  it('says which file and line a secret in a review diff is on', async () => {
    const { ai, r } = await setup()
    ai.consent()
    r.write('config.ts', `export const a = 1\nexport const token = "${TOKEN}"\n`)
    r.git('add', 'config.ts')
    await expect(ai.run('s3', 'x', { kind: 'review', scope: { kind: 'staged' } })).rejects.toMatchObject({
      code: 'ai-secrets',
      message: expect.stringContaining('in config.ts:2'),
    })
    expect(ai.agent.starts).toBe(0)
  })

  it('merges the scan, an allowed linter and the model into one review', async () => {
    const script = join(tempDir(), 'todo-lint.mjs')
    writeFileSync(script, 'import { readFileSync } from "node:fs"\nfor (const f of process.argv.slice(2)) readFileSync(f, "utf8").split("\\n").forEach((l, i) => { if (l.includes("TODO")) console.log(`${f}:${i + 1}:1: unfinished [Warning/no-todo]`) })\n')
    const linter = `"${process.execPath}" "${script}" {files}`
    const t = await setup({ reviewLinter: linter })
    t.ai.consent()
    t.ai['deps'].setSettings({ linterDecisions: { [`${t.repo.path}\n${linter}`]: true } })
    t.r.git('commit', '-qm', 'widgets')
    t.r.write('config.ts', `export const a = 1 // TODO\nexport const token = "${TOKEN}"\n`)
    const res = await t.ai.run('s4', 'x', { kind: 'review', scope: { kind: 'working' }, profile: 'quiet' }, { redact: true })
    const findings = res.review!.findings
    // The model's own "hard-coded credential" on the scanned line is dropped as a repeat; the
    // linter's minor finding stays although the quiet profile would drop a minor from the model.
    expect(findings.map((f) => [f.id, f.source ?? 'ai', f.startLine, f.severity])).toEqual([
      ['F1', 'scan', 2, 'critical'],
      ['F2', 'lint', 1, 'minor'],
      ['F3', 'ai', 1, 'major'],
    ])
    expect(res.review!.context.linters).toMatchObject([{ name: 'todo-lint', status: 'ran', findings: 1 }])
    // A re-review with nothing changed keeps the tools' findings open, not "addressed".
    const again = await t.ai.run('s5', 'x', { kind: 'review', scope: { kind: 'working' }, profile: 'quiet', previous: { findings, hunkKeys: res.review!.hunkKeys, contextKey: res.review!.contextKey } })
    expect(again.review!.findings.map((f) => [f.source ?? 'ai', f.status])).toEqual([['scan', 'open'], ['lint', 'open'], ['ai', 'open']])
  })

  it('tells the model what the tools already reported', async () => {
    const r = makeFixture('linear')
    r.write('config.ts', `export const token = "${TOKEN}"\n`)
    const repo = await Repo.open(r.dir, {})
    cleanup.push(() => repo.dispose())
    const lint = async () => ({ findings: [], runs: [], report: ['- config.ts:1 todo-lint no-todo: unfinished'] })
    const built = await buildPrompt(repo, { kind: 'review', scope: { kind: 'working' }, profile: 'chill' }, { lint })
    expect(built.prompt).toContain('The built-in secret scan already reported these')
    expect(built.prompt).toContain('- config.ts:1 Possible GitHub token in the code')
    expect(built.prompt).toContain('Linters already reported these')
    expect(built.review!.local).toHaveLength(1)
  })
})

describe('prompts', () => {
  it('leaves lockfiles out of the diff and cuts huge diffs', async () => {
    const r = makeFixture('linear')
    r.write('pnpm-lock.yaml', 'lock: 1\n'.repeat(1000))
    r.write('src/big.ts', 'x'.repeat(MAX_DIFF_CHARS + 500) + '\n')
    r.write('src/a b[1].ts', 'odd name\n')
    r.git('add', '-A')
    const repo = await Repo.open(r.dir, {})
    cleanup.push(() => repo.dispose())
    const { prompt } = await buildPrompt(repo, { kind: 'commit-message' })
    expect(prompt).not.toContain('lock: 1')
    expect(prompt).toContain('more characters of diff left out')
    expect(prompt).toContain('Recent commit subjects:')
  })

  it('refuses paths outside the repository for the conflict task', async () => {
    const repo = await Repo.open(makeFixture('linear').dir, {})
    cleanup.push(() => repo.dispose())
    await expect(buildPrompt(repo, { kind: 'resolve-conflict', path: '../etc/passwd' })).rejects.toThrow('Bad path')
    await expect(buildPrompt(repo, { kind: 'explain-commit', hash: 'HEAD; rm -rf' })).rejects.toThrow('Not a commit hash')
  })

  it('unwraps a fenced commit message', () => {
    expect(cleanCommitMessage('```\nfix: thing\n\nbody\n```')).toBe('fix: thing\n\nbody')
    expect(cleanCommitMessage('  fix: thing  ')).toBe('fix: thing')
  })

  it('reviews over the Anthropic API: the answer is checked against the diff before it is returned', async () => {
    const answer = JSON.stringify({
      summary: 'Adds a widget registry.',
      findings: [
        { path: 'widgets.ts', startLine: 1, endLine: 1, type: 'maintainability', severity: 'minor', title: 'Export a type', message: 'Type the map.', suggestion: 'export const widgets = new Map<string, Widget>()' },
        { path: 'nope.ts', startLine: 1, endLine: 1, type: 'bug', severity: 'critical', title: 'Invented', message: 'x' },
      ],
    })
    const fake = await fakeAnthropic(['```json\n', answer, '\n```'])
    cleanup.push(() => fake.close())
    const t = await setup({ aiProvider: 'anthropic' }, fake)
    t.ai.setApiKey('sk-test')
    t.ai.consent()
    const res = await t.ai.run('r1', 'x', { kind: 'review', scope: { kind: 'staged' }, profile: 'chill' })
    expect(res.review).toMatchObject({
      label: 'Staged changes', head: 'index', summary: 'Adds a widget registry.',
      findings: [{ path: 'widgets.ts', startLine: 1, title: 'Export a type', original: ['export const widgets = new Map()'] }],
      dropped: [{ title: 'Invented', reason: 'nope.ts is not in this change' }],
    })
    // What was sent: the numbered diff, with the review instructions.
    const sent = JSON.stringify(fake.requests[0])
    expect(sent).toContain('Review this change (Staged changes)')
    expect(sent).toContain('    1+| export const widgets = new Map()')
  })

  it('tells the review about the project: guideline files, path instructions and learnings', async () => {
    const fake = await fakeAnthropic(['{"summary": "ok", "findings": []}'])
    cleanup.push(() => fake.close())
    const t = await setup({
      aiProvider: 'anthropic',
      reviewLearnings: {},
    }, fake)
    t.r.write('CLAUDE.md', 'Use tabs.\n').write('docs/AGENTS.md', 'Only for docs.\n')
    t.r.write('.coderabbit.yaml', 'reviews:\n  path_instructions:\n    - path: "**/*.ts"\n      instructions: "No default exports."\n    - path: "docs/**"\n      instructions: "Not this one."\n')
    // Already part of the project (committed); only widgets.ts is staged for review.
    t.r.git('add', 'CLAUDE.md', 'docs/AGENTS.md', '.coderabbit.yaml')
    t.r.git('commit', '-q', '-m', 'project rules', '--', 'CLAUDE.md', 'docs/AGENTS.md', '.coderabbit.yaml')
    t.ai['deps'].setSettings({ reviewLearnings: { [t.repo.path]: [{ text: 'Maps without types are fine here', added: 1 }, { text: 'Only for css', path: '*.css', added: 2 }] } })
    t.ai.setApiKey('sk-test')
    t.ai.consent()
    const res = await t.ai.run('r1', 'x', { kind: 'review', scope: { kind: 'staged' }, profile: 'chill' })
    expect(res.review!.context).toEqual({ guidelines: ['CLAUDE.md'], pathInstructions: ['**/*.ts'], learnings: 1 })
    const sent = (fake.requests[0] as unknown as { messages: { content: string }[] }).messages[0]!.content
    expect(sent).toContain('--- CLAUDE.md (applies to every file) ---\nUse tabs.')
    expect(sent).not.toContain('Only for docs.')
    expect(sent).toContain('- **/*.ts: No default exports.')
    expect(sent).toContain('- Maps without types are fine here')
    expect(sent).not.toContain('Only for css')
  })

  it('re-reviews incrementally: an unchanged change is not sent again, its findings stay open', async () => {
    const answer = JSON.stringify({ summary: 'One nit.', findings: [{ path: 'widgets.ts', startLine: 1, endLine: 1, type: 'maintainability', severity: 'minor', title: 'Type the map', message: 'Add types.' }] })
    const fake = await fakeAnthropic([answer])
    cleanup.push(() => fake.close())
    const t = await setup({ aiProvider: 'anthropic' }, fake)
    t.ai.setApiKey('sk-test')
    t.ai.consent()
    const first = (await t.ai.run('r1', 'x', { kind: 'review', scope: { kind: 'staged' }, profile: 'chill' })).review!
    expect(first.findings).toHaveLength(1)
    expect(fake.requests).toHaveLength(1)
    const again = (await t.ai.run('r2', 'x', { kind: 'review', scope: { kind: 'staged' }, profile: 'chill', previous: { findings: first.findings, hunkKeys: first.hunkKeys, contextKey: first.contextKey } })).review!
    expect(fake.requests).toHaveLength(1) // nothing new to ask
    expect(again.incremental).toEqual({ sent: 0, unchanged: 1, addressed: [] })
    expect(again.findings).toMatchObject([{ title: 'Type the map', status: 'open' }])
    expect(again.summary).toBe('Nothing changed in the reviewed code since the last review.')
  })
})
