import { Repo } from '@gitgoose/git'
import { fakeAnthropic, makeFixture, tempDir, type FakeAnthropic } from '@gitgoose/fixtures'
import { defaultSettings, type GitGooseEvent, type Settings } from '@gitgoose/shared'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretFile } from './keyStore'
import { buildPrompt, cleanCommitMessage, MAX_DIFF_CHARS } from './prompts'
import { AiService, compact, previewOf } from './service'
import { reduceThread, type AiThread, type AiUpdate } from '@gitgoose/shared'

const FAKE = join(import.meta.dirname, '../../../e2e/fake-agent.mjs')
const memoryKeychain = { secure: () => true, encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() }

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f()
})

async function setup(patch: Partial<Settings> = {}, anthropic?: FakeAnthropic, extra: { threadIdleMs?: number; env?: Record<string, string> } = {}) {
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
  const events: GitGooseEvent[] = []
  const ai = new AiService({
    settings: () => settings,
    setSettings: (p) => (settings = { ...settings, ...p }),
    repo: () => repo,
    apiKey: new SecretFile(join(tempDir(), 'key.bin'), memoryKeychain),
    emit: (e) => {
      events.push(e)
      // Answer permission questions like a user who allows everything.
      if (e.type === 'ai-permission') queueMicrotask(() => ai.respondPermission(e.request.permissionId, e.request.options[0]!.optionId))
      // Permission cards in a thread: "Allow for this session".
      if (e.type === 'ai-update' && e.update.kind === 'permission') queueMicrotask(() => ai.answerPermission(e.update.kind === 'permission' ? e.update.permission.permissionId : 0, 'session'))
    },
    anthropicBaseURL: anthropic?.url,
    threadIdleMs: extra.threadIdleMs,
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
    // The system prompt goes on its own, not again at the top of the message.
    expect(api.requests[0]!.system).toBe('You help people use git.')
    expect(api.requests[0]!.messages[0]!.content).not.toContain('You help people use git.')
    expect(events.filter((e) => e.type === 'ai-text').length).toBeGreaterThan(0)
    await expect(ai.run('r4', 'x', { kind: 'resolve-conflict', path: 'a.txt' })).rejects.toMatchObject({ code: 'ai-unsupported' })
    expect(ai.agent.starts).toBe(0)
  })
})

/** The thread as the renderer would see it: the thread from open, folded over the events. */
function mirror(events: GitGooseEvent[], start: AiThread): AiThread {
  return events.reduce((t, e) => (e.type === 'ai-update' && e.threadId === t.id ? reduceThread(t, e.requestId, e.update) : t), start)
}

/** Resolves once the turn `requestId` has ended (done or error). */
async function ended(events: GitGooseEvent[], requestId: string): Promise<AiUpdate> {
  for (let i = 0; i < 400; i++) {
    const e = events.find((x) => x.type === 'ai-update' && x.requestId === requestId && (x.update.kind === 'done' || x.update.kind === 'error'))
    if (e?.type === 'ai-update') return e.update
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`turn ${requestId} did not end`)
}

const replyOf = (t: AiThread) => t.turns.at(-1)!.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')

describe('threads', () => {
  it('follow-ups go to the same session: the agent remembers, the renderer mirror matches main', async () => {
    const t = await setup()
    t.ai.consent()
    const thread = await t.ai.openThread('x', { kind: 'free' })
    // Opening sends nothing and starts nothing.
    expect(t.ai.agent.starts).toBe(0)
    const r1 = await t.ai.sendThread(thread.id, 'hello there')
    await ended(t.events, r1)
    const r2 = await t.ai.sendThread(thread.id, 'and again')
    await ended(t.events, r2)
    const seen = mirror(t.events, thread)
    expect(replyOf(seen)).toBe('Turn 2. You said: and again.')
    expect(seen.turns.map((x) => x.role)).toEqual(['user', 'agent', 'user', 'agent'])
    // Saved for the repository, the same as the mirror.
    expect(t.settings.aiThreads[t.repo.path]![0]).toEqual({ ...seen, repoId: '' })
    expect(t.ai.listThreads('x')[0]!.id).toBe(thread.id)
    expect(t.ai.agent.starts).toBe(1)
  })

  it('the first message carries the anchor context and the artifact protocol; later ones only the text', async () => {
    const log = join(tempDir(), 'prompts.log')
    process.env.FAKE_AGENT_LOG = log
    cleanup.push(() => void delete process.env.FAKE_AGENT_LOG)
    const t = await setup()
    t.ai.consent()
    const thread = await t.ai.openThread('x', { kind: 'free' })
    await ended(t.events, await t.ai.sendThread(thread.id, 'first'))
    await ended(t.events, await t.ai.sendThread(thread.id, 'second'))
    const [one, two] = readFileSync(log, 'utf8').split('\n---\n')
    expect(one).toContain('HEAD: main at')
    expect(one).toContain('```json:commit-message')
    expect(one!.trim().endsWith('first')).toBe(true)
    expect(two!.trim()).toBe('second')
  })

  it('a feature run with keepThread is the first turn of a thread; a findings artifact is checked like the review', async () => {
    const t = await setup()
    t.ai.consent()
    const res = await t.ai.run('rv', 'x', { kind: 'review', scope: { kind: 'staged' }, profile: 'chill' }, { keepThread: true })
    expect(res.review!.findings).toHaveLength(1)
    const thread = await t.ai.openThread('x', { kind: 'review', scope: { kind: 'staged' } }, res.threadId)
    expect(thread.turns.map((x) => [x.role, x.feature, x.status])).toEqual([['user', 'Review: Staged changes', undefined], ['agent', 'Review: Staged changes', 'done']])
    const r = await t.ai.sendThread(thread.id, 'Anything else? FAKE:findings')
    await ended(t.events, r)
    const art = mirror(t.events, thread).turns.at(-1)!.blocks.find((b) => b.type === 'artifact')
    expect(art).toMatchObject({ type: 'artifact', artifact: 'findings' })
    if (art?.type !== 'artifact') return
    const checked = await t.ai.checkArtifact(thread.id, 'findings', art.json)
    expect(checked.kind).toBe('findings')
    if (checked.kind !== 'findings') return
    // The invented file is thrown out exactly as in the review itself; what is left is marked.
    expect(checked.review.findings.map((f) => [f.title, f.fromChat])).toEqual([['Found in chat', true]])
    expect(checked.review.dropped.map((d) => d.title)).toEqual(['Invented in chat'])
    // An artifact the anchor does not take is refused.
    expect(await t.ai.checkArtifact(thread.id, 'plan', '{}')).toMatchObject({ kind: 'problem' })
  })

  it('a feature thread nobody opens still ends its session after the idle grace', async () => {
    const t = await setup({}, undefined, { threadIdleMs: 60 })
    t.ai.consent()
    const res = await t.ai.run('w1', 'x', { kind: 'review', scope: { kind: 'staged' }, profile: 'chill' }, { keepThread: true })
    expect(t.ai.liveThreads()).toEqual([res.threadId])
    await new Promise((ok) => setTimeout(ok, 150))
    expect(t.ai.liveThreads()).toEqual([])
    // Saved, so the rail can still open it later.
    expect(t.ai.listThreads('x').map((x) => x.id)).toEqual([res.threadId])
  })

  it('saves a compact thread: a long feature answer is cut, the conversation is kept', () => {
    const at = 1
    let thread: AiThread = { id: 't', repoId: 'r', anchor: { kind: 'free' }, title: '', turns: [], createdAt: at, updatedAt: at, head: '' }
    thread = reduceThread(thread, 'a', { kind: 'turn', text: 'Review', feature: 'Review', at })
    thread = reduceThread(thread, 'a', { kind: 'text', text: 'x'.repeat(20_000) })
    thread = reduceThread(thread, 'b', { kind: 'turn', text: 'why?', at })
    thread = reduceThread(thread, 'b', { kind: 'text', text: 'because' })
    const saved = compact(thread)
    expect(saved.repoId).toBe('')
    const feature = saved.turns[1]!.blocks[0]
    expect(feature?.type === 'text' && feature.text.length).toBeLessThan(8_100)
    expect(saved.turns[3]!.blocks).toEqual([{ type: 'text', text: 'because' }])
  })

  it('a thread permission card: "Allow for this session" answers the same question again by itself', async () => {
    const t = await setup()
    t.ai.consent()
    const thread = await t.ai.openThread('x', { kind: 'free' })
    await ended(t.events, await t.ai.sendThread(thread.id, 'FAKE:permission'))
    const seen = mirror(t.events, thread)
    expect(replyOf(seen)).toBe('Turn 1. First: allowed, second: allowed.')
    const cards = seen.turns.at(-1)!.blocks.filter((b) => b.type === 'permission')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ permission: { kind: 'execute', answer: 'session' } })
    // Not the modal: that is for one-shot requests.
    expect(t.events.some((e) => e.type === 'ai-permission')).toBe(false)
  })

  it('cancel stops the turn; the thread takes the next one', async () => {
    const t = await setup()
    t.ai.consent()
    const thread = await t.ai.openThread('x', { kind: 'free' })
    const r = await t.ai.sendThread(thread.id, 'FAKE:slow')
    await expect(t.ai.sendThread(thread.id, 'too soon')).rejects.toMatchObject({ code: 'ai-busy' })
    await new Promise((ok) => setTimeout(ok, 120))
    t.ai.cancelThread(thread.id)
    expect(await ended(t.events, r)).toEqual({ kind: 'done', stopReason: 'cancelled' })
    await ended(t.events, await t.ai.sendThread(thread.id, 'next'))
    // The stopped turn is not part of what the agent is told; its own session counted it.
    expect(mirror(t.events, thread).turns.at(-3)!.status).toBe('cancelled')
    expect(replyOf(mirror(t.events, thread))).toBe('Turn 2. You said: next.')
  })

  it('the agent crashing mid-thread: the turn fails; the next starts a new agent and replays the conversation', async () => {
    const t = await setup()
    t.ai.consent()
    const thread = await t.ai.openThread('x', { kind: 'free' })
    await ended(t.events, await t.ai.sendThread(thread.id, 'one'))
    await ended(t.events, await t.ai.sendThread(thread.id, 'two'))
    expect(await ended(t.events, await t.ai.sendThread(thread.id, 'FAKE:crash'))).toMatchObject({ kind: 'error', message: expect.stringContaining('agent stopped') })
    await ended(t.events, await t.ai.sendThread(thread.id, 'three'))
    // The crashed turn was left out of the replay (it would crash again).
    expect(replyOf(mirror(t.events, thread))).toBe('Turn 3. You said: three. (replayed 2 earlier turns)')
    expect(t.ai.agent.starts).toBe(2)
  })

  it('closing the view keeps the session for the idle grace, then ends it; reopening later replays from disk', async () => {
    const t = await setup({}, undefined, { threadIdleMs: 60 })
    t.ai.consent()
    const thread = await t.ai.openThread('x', { kind: 'free' })
    await ended(t.events, await t.ai.sendThread(thread.id, 'one'))
    t.ai.closeThread(thread.id)
    expect(t.ai.liveThreads()).toEqual([thread.id])
    await new Promise((ok) => setTimeout(ok, 150))
    expect(t.ai.liveThreads()).toEqual([])
    const again = await t.ai.openThread('x', { kind: 'free' }, thread.id)
    expect(again.turns).toHaveLength(2)
    await ended(t.events, await t.ai.sendThread(again.id, 'two'))
    expect(replyOf(mirror(t.events, again))).toBe('Turn 2. You said: two. (replayed 1 earlier turns)')
  })

  it('an explained failure is kept as a thread about the error; reopened later, a follow-up is told the error again', async () => {
    const log = join(tempDir(), 'prompts.log')
    process.env.FAKE_AGENT_LOG = log
    cleanup.push(() => void delete process.env.FAKE_AGENT_LOG)
    const t = await setup({}, undefined, { threadIdleMs: 60 })
    t.ai.consent()
    const res = await t.ai.run('e1', 'x', { kind: 'explain-error', title: 'Push failed', detail: 'policy: pushes to main need review' }, { keepThread: true })
    expect(res.text).toContain('This change explains itself.')
    const [kept] = t.ai.listThreads('x')
    expect(kept).toMatchObject({ id: res.threadId, title: 'Why did this fail: Push failed', anchor: { kind: 'error', title: 'Push failed', detail: 'policy: pushes to main need review' } })
    // Nobody opened it: the session ends after the idle grace, the thread stays saved.
    await new Promise((ok) => setTimeout(ok, 150))
    expect(t.ai.liveThreads()).toEqual([])
    const again = await t.ai.openThread('x', { kind: 'free' }, res.threadId)
    expect(again.anchor.kind).toBe('error')
    await ended(t.events, await t.ai.sendThread(again.id, 'what now?'))
    const replay = readFileSync(log, 'utf8').split('\n---\n').at(-2)!
    expect(replay).toContain('policy: pushes to main need review')
    expect(replay.trim().endsWith('what now?')).toBe(true)
  })

  it('refuses before the turn starts: consent, and a secret in the message (sent redacted when asked)', async () => {
    const TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    const t = await setup()
    const thread = await t.ai.openThread('x', { kind: 'free' })
    await expect(t.ai.sendThread(thread.id, 'hi')).rejects.toMatchObject({ code: 'ai-consent' })
    t.ai.consent()
    await ended(t.events, await t.ai.sendThread(thread.id, 'hi'))
    // The scan runs on every turn, not only the first.
    await expect(t.ai.sendThread(thread.id, `my token is ${TOKEN}`)).rejects.toMatchObject({ code: 'ai-secrets' })
    await ended(t.events, await t.ai.sendThread(thread.id, `my token is ${TOKEN}`, { redact: true }))
    const seen = mirror(t.events, thread)
    expect(JSON.stringify(seen)).not.toContain(TOKEN)
    expect(replyOf(seen)).toBe('Turn 2. You said: my token is [REDACTED GitHub token].')
  })

  it('over the Anthropic API: every turn sends the whole conversation, with the longest-answer setting', async () => {
    const api = await fakeAnthropic(['An answer.'])
    cleanup.push(() => api.close())
    const t = await setup({ aiProvider: 'anthropic' }, api)
    t.ai.setApiKey('sk-ant-test')
    t.ai.consent()
    const thread = await t.ai.openThread('x', { kind: 'free' })
    await ended(t.events, await t.ai.sendThread(thread.id, 'first'))
    await ended(t.events, await t.ai.sendThread(thread.id, 'second'))
    expect(api.requests).toHaveLength(2)
    expect(api.requests[1]!.max_tokens).toBe(8192)
    expect(api.requests[1]!.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(api.requests[1]!.messages[0]!.content).toContain('HEAD: main at')
    expect(api.requests[1]!.messages[2]!.content).toBe('second')
    expect(replyOf(mirror(t.events, thread))).toBe('An answer.')
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
    const err = await ai.run('s1', 'x', task).then(() => null, (e: unknown) => e as { code: string; message: string })
    expect(err).toMatchObject({ code: 'ai-secrets' })
    if (!err) return
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
    await expect(ai.run('s3', 'x', { kind: 'review', scope: { kind: 'staged' }, profile: 'chill' })).rejects.toMatchObject({
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

describe('pre-push checks', () => {
  it('sends the outgoing commits and the rules, and keeps only verified verdicts', async () => {
    const t = await setup()
    t.ai.consent()
    t.r.git('commit', '-qm', 'widgets')
    t.r.write('src/log.ts', 'export function hello() {\n  console.log("hi")\n}\n')
    t.r.git('add', '-A')
    t.r.git('commit', '-qm', 'feat: say hello')
    const checks = [
      { name: 'No debug logging', instructions: 'No console.log calls.', mode: 'block' as const, source: 'repo' as const },
      { name: 'Docs', instructions: 'Public functions are documented elsewhere.', mode: 'warn' as const, source: 'settings' as const },
      { name: 'Small', instructions: 'Keep commits small.', mode: 'warn' as const, source: 'settings' as const },
    ]
    const res = await t.ai.run('p1', 'x', { kind: 'push-checks', checks })
    expect(res.pushChecks!.map((r) => [r.name, r.verdict, r.source])).toEqual([
      ['No debug logging', 'fail', 'repo'],
      ['Docs', 'inconclusive', 'settings'],
      ['Small', 'pass', 'settings'],
    ])
    expect(res.pushChecks![0]!.evidence).toEqual([{ path: 'src/log.ts', line: 2 }])
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
    expect(res.review!.context).toEqual({ guidelines: ['CLAUDE.md'], pathInstructions: ['**/*.ts'], learnings: 1, code: { source: 'patterns', symbols: 1, uses: 0, used: 0, tests: 0, truncated: false } })
    const sent = (fake.requests[0] as unknown as { messages: { content: string }[] }).messages[0]!.content
    expect(sent).toContain('--- CLAUDE.md (applies to every file) ---\nUse tabs.')
    expect(sent).not.toContain('Only for docs.')
    expect(sent).toContain('- **/*.ts: No default exports.')
    expect(sent).toContain('- Maps without types are fine here')
    expect(sent).not.toContain('Only for css')
  })

  it('tells the review what is around the change (callers, used definitions, tests) and what the commits meant', async () => {
    const fake = await fakeAnthropic(['{"summary": "ok", "findings": []}'])
    cleanup.push(() => fake.close())
    const t = await setup({ aiProvider: 'anthropic' }, fake)
    t.r.git('reset', '-q') // widgets.ts is not part of this
    t.r.commit('lib', {
      'lib.ts': 'export function helper(x: number) {\n  return x + 1\n}\n',
      'use.ts': "import { helper } from './lib'\nexport function run() {\n  return helper(1)\n}\n",
      'lib.test.ts': "import { helper } from './lib'\ntest('helper', () => expect(helper(1)).toBe(2))\n",
    })
    // The staged change alters helper's signature and calls widgets; use.ts and the test still call the old one.
    t.r.write('lib.ts', "import { widgets } from './widgets'\nexport function helper(x: number, y: number) {\n  return x + y + widgets.size\n}\n")
    t.r.git('add', 'lib.ts')
    t.ai.setApiKey('sk-test')
    t.ai.consent()
    const res = await t.ai.run('r1', 'x', { kind: 'review', scope: { kind: 'staged' }, profile: 'chill' })
    expect(res.review!.context.code).toEqual({ source: 'patterns', symbols: 1, uses: 4, used: 1, tests: 1, truncated: false })
    const sent = (fake.requests[0] as unknown as { messages: { content: string }[] }).messages[0]!.content
    expect(sent).toContain('Around the change (from the code graph')
    expect(sent).toContain('- function helper (lib.ts:2) changed\n  was: export function helper(x: number) {\n  now: export function helper(x: number, y: number) {\n  used in 4 places outside the change (2 in tests):\n    use.ts:1: import { helper }')
    expect(sent).toContain('use.ts:3 in function run: return helper(1)')
    expect(sent).toContain('Tests that cover the change:\n- not changed: lib.test.ts')
    expect(sent).toContain('Definitions of names the added lines use (outside the change):\n- const widgets (widgets.ts:1), used 1 time:\n  ```\n  export const widgets = new Map()\n  ```')
    expect(sent).toContain('The change:\n=== lib.ts (modified) ===')
    expect(sent).not.toContain('The commit messages')

    // A committed change brings its messages along as the intent.
    const hash = t.r.git('rev-parse', 'HEAD').trim()
    const res2 = await t.ai.run('r2', 'x', { kind: 'review', scope: { kind: 'commits', hashes: [hash] }, profile: 'chill' })
    expect(res2.review!.context.commits).toBe(1)
    const sent2 = (fake.requests[1] as unknown as { messages: { content: string }[] }).messages[0]!.content
    expect(sent2).toContain('The commit messages, newest first (what the author meant to do; judge the change against them):\n- lib\n')
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

describe('recompose previews', () => {
  it('keeps a change whole up to 200 lines, and says how much was cut', () => {
    const body = (n: number) => ['@@ -1 +1 @@', ...Array.from({ length: n }, (_, i) => `+line ${i}`)].join('\n')
    expect(previewOf(body(20))).toBe(body(20))
    const cut = previewOf(body(300)).split('\n')
    expect(cut).toHaveLength(201)
    expect(cut.at(-1)).toBe('… 101 more lines')
  })
})
