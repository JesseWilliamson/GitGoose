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
})
