import { Repo } from '@gitgoose/git'
import { FAKE_MODELS, fakeAnthropic, makeFixture, tempDir, type FakeAnthropic } from '@gitgoose/fixtures'
import { defaultSettings, type GitGooseEvent, type Settings } from '@gitgoose/shared'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretFile } from './keyStore'
import { buildPrompt, cleanCommitMessage, MAX_DIFF_CHARS } from './prompts'
import { AiService, compact, previewOf } from './service'
import { reduceThread, targetKey, type AiTarget, type AiThread, type AiUpdate, type ThreadAnchor } from '@gitgoose/shared'

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
    // An agent has no separate system prompt: the AI panel's goes at the top of the first message.
    expect(one!.startsWith('You help people understand and change the code in their git repository.\n\n')).toBe(true)
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

  it("checks the API's separate system prompt too: a chat's and an Ask's, refused or sent redacted", async () => {
    const api = await fakeAnthropic(['ok'])
    cleanup.push(() => api.close())
    const words = { system: `You know the token ${TOKEN}.`, instructions: '' }
    const t = await setup({ aiProvider: 'anthropic', aiPrompts: { chat: words, ask: words } }, api)
    t.ai.setApiKey('sk-ant-test')
    t.ai.consent()
    const anchors: ThreadAnchor[] = [{ kind: 'free' }, { kind: 'ask', rev: 'worktree', path: 'widgets.ts', lines: [1, 1], code: '' }]
    for (const anchor of anchors) {
      const thread = await t.ai.openThread('x', anchor)
      const before = api.requests.length
      // The message itself is clean: only the system prompt holds the secret.
      await expect(t.ai.sendThread(thread.id, 'what is this?')).rejects.toMatchObject({ code: 'ai-secrets', message: expect.not.stringContaining(TOKEN) })
      expect(api.requests).toHaveLength(before)
      await ended(t.events, await t.ai.sendThread(thread.id, 'what is this?', { redact: true }))
      expect(api.requests).toHaveLength(before + 1)
      expect(api.requests.at(-1)!.system).toBe('You know the token [REDACTED GitHub token].')
      expect(JSON.stringify(api.requests.at(-1))).not.toContain(TOKEN)
      // The Sent view shows the system prompt as it went out; the turn is what was typed.
      const seen = mirror(t.events, thread)
      expect(seen.turns[0]!.blocks).toEqual([{ type: 'text', text: 'what is this?' }])
      expect(seen.turns[0]!.sent!.startsWith('[System prompt]\nYou know the token [REDACTED GitHub token].\n\n[Message]\n')).toBe(true)
      expect(JSON.stringify(seen)).not.toContain(TOKEN)
      // Later turns carry the redacted system prompt, with nothing left to refuse.
      await ended(t.events, await t.ai.sendThread(thread.id, 'and then?'))
      expect(api.requests.at(-1)!.system).toBe('You know the token [REDACTED GitHub token].')
      expect(api.requests.at(-1)!.messages.at(-1)!.content).toBe('and then?')
    }
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

  it('re-reviews in full after the review words were edited, even with the code unchanged', async () => {
    const answer = JSON.stringify({ summary: 'One nit.', findings: [{ path: 'widgets.ts', startLine: 1, endLine: 1, type: 'maintainability', severity: 'minor', title: 'Type the map', message: 'Add types.' }] })
    const fake = await fakeAnthropic([answer])
    cleanup.push(() => fake.close())
    const t = await setup({ aiProvider: 'anthropic' }, fake)
    t.ai.setApiKey('sk-test')
    t.ai.consent()
    const task = { kind: 'review', scope: { kind: 'staged' }, profile: 'chill' } as const
    const first = (await t.ai.run('r1', 'x', task)).review!
    const previous = { findings: first.findings, hunkKeys: first.hunkKeys, contextKey: first.contextKey }
    // Blank edits fall back to the built-in words: the same prompt, so nothing new to ask.
    const blank = (await t.ai.run('r2', 'x', { ...task, previous }, { prompt: { system: '  ', instructions: '' } })).review!
    expect(fake.requests).toHaveLength(1)
    expect(blank.contextKey).toBe(first.contextKey)
    // Edited instructions: the whole change goes out again, nothing is carried over.
    const instructions = (await t.ai.run('r3', 'x', { ...task, previous }, { prompt: { system: '', instructions: 'Review this change ({label}) for security only.' } })).review!
    expect(fake.requests).toHaveLength(2)
    expect(fake.requests[1]!.messages[0]!.content).toContain('Review this change (Staged changes) for security only.')
    expect(fake.requests[1]!.messages[0]!.content).toContain('    1+| export const widgets = new Map()')
    expect(instructions.incremental).toBeUndefined()
    expect(instructions.contextKey).not.toBe(first.contextKey)
    // An edited system prompt, saved in Settings → AI: the same.
    t.ai['deps'].setSettings({ aiPrompts: { review: { system: 'You review for a bank.', instructions: '' } } })
    const system = (await t.ai.run('r4', 'x', { ...task, previous })).review!
    expect(fake.requests).toHaveLength(3)
    expect(fake.requests[2]!.system).toBe('You review for a bank.')
    expect(system.incremental).toBeUndefined()
    expect(system.contextKey).not.toBe(first.contextKey)
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

describe('choosing who answers', () => {
  /** Two agents: the fake twice, with different command lines (so: two processes, two consents). */
  async function two() {
    process.env.FAKE_AGENT_MODELS = '1'
    cleanup.push(() => void delete process.env.FAKE_AGENT_MODELS)
    const t = await setup()
    const a: AiTarget = { provider: 'agent', agent: 'custom', agentCommand: t.settings.aiAgentCommand }
    const b: AiTarget = { provider: 'agent', agent: 'custom', agentCommand: `${t.settings.aiAgentCommand} --second` }
    t.ai.consent(a)
    t.ai.consent(b)
    return { ...t, a, b }
  }

  it("a run uses the area's model: the session switches before the prompt, and the agent's list is kept", async () => {
    const log = join(tempDir(), 'prompts.log')
    process.env.FAKE_AGENT_LOG = log
    cleanup.push(() => void delete process.env.FAKE_AGENT_LOG)
    const t = await two()
    await t.ai.run('m1', 'x', { kind: 'commit-message' }, { target: { ...t.a, model: 'fast' } })
    expect(readFileSync(log, 'utf8').split('\n---\n')[0]).toBe('set model fast')
    // Kept for pickers: the models, and the agent's own default (a new session's model).
    expect(t.settings.aiAgentModels[targetKey(t.a)]).toMatchObject({ known: true, defaultModel: 'smart', models: [{ id: 'fast', name: 'Fake Fast' }, { id: 'smart' }] })
  })

  it('a model the agent does not offer is refused before the turn starts', async () => {
    const t = await two()
    await expect(t.ai.run('m2', 'x', { kind: 'commit-message' }, { target: { ...t.a, model: 'huge' } })).rejects.toMatchObject({ code: 'ai-model' })
  })

  it('listing models starts nothing until the user asks; then one session lists them', async () => {
    const t = await two()
    expect(await t.ai.models(t.b)).toEqual({ models: [], known: false })
    expect(t.ai.agent.starts).toBe(0)
    const list = await t.ai.loadModels(t.b)
    expect(list).toMatchObject({ known: true, defaultModel: 'smart' })
    expect(list.models.map((m) => m.id)).toEqual(['fast', 'smart'])
    // The default agent was never started: only b was.
    expect(t.ai.agent.starts).toBe(0)
  })

  it('consent is per agent, not per model', async () => {
    const t = await setup()
    t.ai.consent()
    const base: AiTarget = { provider: 'agent', agent: 'custom', agentCommand: t.settings.aiAgentCommand }
    expect(t.ai.status({ ...base, model: 'fast' }).consented).toBe(true)
    expect(t.ai.status({ ...base, agentCommand: 'other-agent --acp' }).consented).toBe(false)
  })

  it('a thread switches model in place, and moves to another agent with the conversation so far', async () => {
    const t = await two()
    const thread = await t.ai.openThread('x', { kind: 'free' })
    await ended(t.events, await t.ai.sendThread(thread.id, 'hello there', { target: { ...t.a, model: 'fast' } }))
    // Same agent, other model: the same session (the fake counts turns per session).
    await ended(t.events, await t.ai.sendThread(thread.id, 'FAKE:model', { target: { ...t.a, model: 'smart' } }))
    let seen = mirror(t.events, thread)
    expect(replyOf(seen)).toBe('Model: smart')
    // Another agent: a new session there, told the conversation so far.
    await ended(t.events, await t.ai.sendThread(thread.id, 'and now?', { target: t.b }))
    seen = mirror(t.events, thread)
    expect(replyOf(seen)).toBe('Turn 3. You said: and now?. (replayed 2 earlier turns)')
    expect(seen.target).toEqual({ ...t.b })
    // Each answer says who gave it, so the switch shows in the thread.
    expect(seen.turns.filter((x) => x.role === 'agent').map((x) => x.by)).toEqual(['fake-agent · Fake Fast', 'fake-agent · Fake Smart', 'fake-agent · Fake Smart'])
    // The old agent's session is closed; the thread holds only the new one.
    expect(t.ai.liveThreads()).toEqual([thread.id])
  })

  it('a thread without a pick carries on with whoever it was last with', async () => {
    const t = await two()
    const thread = await t.ai.openThread('x', { kind: 'free' })
    await ended(t.events, await t.ai.sendThread(thread.id, 'one', { target: { ...t.b, model: 'fast' } }))
    await ended(t.events, await t.ai.sendThread(thread.id, 'FAKE:model'))
    expect(replyOf(mirror(t.events, thread))).toBe('Model: fast')
  })

  it("the API key's models come from the API, and a run uses the picked one", async () => {
    const api = await fakeAnthropic(['ok'])
    cleanup.push(() => api.close())
    const { ai } = await setup({ aiProvider: 'anthropic' }, api)
    expect(await ai.models({ provider: 'anthropic' })).toMatchObject({ known: false })
    ai.setApiKey('sk-ant-test')
    ai.consent()
    const list = await ai.models({ provider: 'anthropic' })
    expect(list).toMatchObject({ known: true, defaultModel: 'claude-opus-5-5' })
    expect(list.models).toEqual(FAKE_MODELS)
    await ai.run('m3', 'x', { kind: 'explain-error', title: 'x', detail: 'y' }, { target: { provider: 'anthropic', model: 'claude-haiku-5-5' } })
    expect(api.requests.at(-1)).toMatchObject({ model: 'claude-haiku-5-5' })
  })
})

describe('prompts the user can read and edit', () => {
  it("a run sends the area's words; the answer format is added whatever the edit says", async () => {
    const log = join(tempDir(), 'prompts.log')
    process.env.FAKE_AGENT_LOG = log
    cleanup.push(() => void delete process.env.FAKE_AGENT_LOG)
    const t = await setup()
    t.ai.consent()
    // The fake answers "commit message for" requests, so the edit keeps those words.
    await t.ai.run('p1', 'x', { kind: 'commit-message' }, { prompt: { system: 'You are terse.', instructions: 'Write a commit message for this, in French.' } })
    const sent = readFileSync(log, 'utf8').split('\n---\n')[0]!
    expect(sent.startsWith('You are terse.\n\nWrite a commit message for this, in French.\nReply with the commit message only')).toBe(true)
    expect(sent).toContain('Staged diff:')
    expect(sent).not.toContain('imperative mood')
  })

  it('without an edit from the caller, Settings → AI and then the built-in words are used', async () => {
    const log = join(tempDir(), 'prompts.log')
    process.env.FAKE_AGENT_LOG = log
    cleanup.push(() => void delete process.env.FAKE_AGENT_LOG)
    const t = await setup({ aiPrompts: { 'commit-message': { system: '', instructions: 'Write a commit message for these changes. Settings words.' } } })
    t.ai.consent()
    await t.ai.run('p2', 'x', { kind: 'commit-message' })
    const sent = readFileSync(log, 'utf8').split('\n---\n')[0]!
    // A blank system keeps the built-in one.
    expect(sent.startsWith('You write git commit messages.\n\nWrite a commit message for these changes. Settings words.')).toBe(true)
  })

  it('the preview is what a request would send, built without sending or starting anything', async () => {
    const t = await setup()
    const parts = await t.ai.preview('x', { kind: 'review', scope: { kind: 'staged' }, profile: 'quiet' }, { system: '', instructions: 'Review this change ({label}) carefully. {profile}' })
    expect(parts.kind).toBe('review')
    expect(parts.template).toBe('Review this change ({label}) carefully. {profile}')
    expect(parts.instructions).toBe('Review this change (Staged changes) carefully. Report only real problems: bugs, security holes, data loss, serious performance issues (severity critical or major). If there are none, return no findings. Silence is a fine answer.')
    expect(parts.format).toContain('"findings": [')
    expect(parts.context).toContain('    1+| export const widgets = new Map()')
    // Linters run programs: only for the real request, and the panel says so.
    expect(parts.note).toContain('Linter findings are added')
    expect(t.ai.agent.starts).toBe(0)
  })

  it('a thread keeps exactly what each turn sent, beyond what was typed', async () => {
    const t = await setup()
    t.ai.consent()
    const thread = await t.ai.openThread('x', { kind: 'free' })
    await ended(t.events, await t.ai.sendThread(thread.id, 'first'))
    await ended(t.events, await t.ai.sendThread(thread.id, 'second'))
    const users = mirror(t.events, thread).turns.filter((x) => x.role === 'user')
    // The first message carried the AI panel's words and where we are; the second was just typed.
    expect(users[0]!.sent).toContain('You are helping someone with their git repository')
    expect(users[0]!.sent).toContain('HEAD: main at')
    expect(users[0]!.sent!.trim().endsWith('first')).toBe(true)
    expect(users[1]!.sent).toBeUndefined()
  })

  it("the AI panel's edited system prompt opens an agent conversation; the API sends it on its own", async () => {
    const log = join(tempDir(), 'prompts.log')
    process.env.FAKE_AGENT_LOG = log
    cleanup.push(() => void delete process.env.FAKE_AGENT_LOG)
    const chat: Partial<Settings> = { aiPrompts: { chat: { system: 'You answer like a lighthouse keeper.', instructions: '' } } }
    const t = await setup(chat)
    t.ai.consent()
    const thread = await t.ai.openThread('x', { kind: 'free' })
    await ended(t.events, await t.ai.sendThread(thread.id, 'first'))
    const sent = readFileSync(log, 'utf8').split('\n---\n')[0]!
    expect(sent.startsWith('You answer like a lighthouse keeper.\n\nYou are helping someone with their git repository')).toBe(true)

    const api = await fakeAnthropic(['ok'])
    cleanup.push(() => api.close())
    const a = await setup({ ...chat, aiProvider: 'anthropic' }, api)
    a.ai.setApiKey('sk-ant-test')
    a.ai.consent()
    const other = await a.ai.openThread('x', { kind: 'free' })
    await ended(a.events, await a.ai.sendThread(other.id, 'first'))
    expect(api.requests[0]!.system).toBe('You answer like a lighthouse keeper.')
    expect(api.requests[0]!.messages[0]!.content).not.toContain('lighthouse keeper')
    expect(api.requests[0]!.messages[0]!.content).toContain('HEAD: main at')
  })

  it("the API's sent text shows its separate system prompt on the first turn", async () => {
    const api = await fakeAnthropic(['ok'])
    cleanup.push(() => api.close())
    const t = await setup({ aiProvider: 'anthropic' }, api)
    t.ai.setApiKey('sk-ant-test')
    t.ai.consent()
    const res = await t.ai.run('p3', 'x', { kind: 'explain-commit', hash: t.r.git('rev-parse', 'HEAD').trim() }, { keepThread: true })
    const thread = await t.ai.openThread('x', { kind: 'explain', hash: '' }, res.threadId)
    expect(thread.turns[0]!.sent!.startsWith('[System prompt]\nYou explain code changes to a teammate.\n\n[Message]\nExplain what this commit does')).toBe(true)
  })
})
