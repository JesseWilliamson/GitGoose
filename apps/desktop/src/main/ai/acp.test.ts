import { tempDir } from '@gitgoose/fixtures'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpAgent, AgentAuthError, allInside, SessionGoneError, type AgentUpdate, type PermissionAsk } from './acp'

const FAKE = join(import.meta.dirname, '../../../e2e/fake-agent.mjs')
const agents: AcpAgent[] = []
function fake(env: Record<string, string> = {}) {
  const a = new AcpAgent(() => ({ command: process.execPath, args: [FAKE], env }))
  agents.push(a)
  return a
}
afterEach(() => {
  agents.splice(0).forEach((a) => a.stop())
})

const deny = async () => null

describe('ACP agent', () => {
  it('initializes and reports the agent and its login methods', async () => {
    const info = await fake().info()
    expect(info).toMatchObject({ name: 'Fake Agent', version: '1.2.3' })
    expect(info.authMethods.map((m) => m.id)).toEqual(['fake-login', 'fake-terminal'])
    // A terminal login reruns the agent's own command with its extra arguments.
    expect(info.authMethods[1]!.terminalCommand).toBe(`${process.execPath} ${FAKE} --login`)
  })

  it('streams the reply', async () => {
    const seen: string[] = []
    const res = await fake().ask(tempDir(), 'Write a commit message for this diff', { onText: (t) => seen.push(t), onPermission: deny })
    expect(res.text).toBe('feat: add the widget registry\n\nRegisters widgets by name so plugins can add their own.')
    expect(seen).toHaveLength(3)
    expect(res.stopReason).toBe('end_turn')
  })

  it('runs requests in the same repository side by side, each in its own session', async () => {
    const agent = fake()
    const dir = tempDir()
    const [a, b] = await Promise.all([
      agent.ask(dir, 'Write a commit message for it', { onPermission: deny }),
      agent.ask(dir, 'Explain this commit', { onPermission: deny }),
    ])
    expect(a.text).toContain('feat: add the widget registry')
    expect(b.text).toContain('This change explains itself.')
    expect(agent.starts).toBe(1)
  })

  it('allows reads inside the repository silently, and asks for anything else', async () => {
    const asked: PermissionAsk[] = []
    const res = await fake().ask(tempDir(), 'Explain this commit', {
      onPermission: async (a) => (asked.push(a), null),
    })
    expect(res.text).toContain('inside: allowed, outside: denied')
    expect(asked.map((a) => a.paths)).toEqual([['/etc/hostname']])
  })

  it('captures a write to the allowed file instead of writing it, and refuses others', async () => {
    const dir = tempDir()
    const file = join(dir, 'story.txt')
    const conflicted = 'one\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\nthree\n'
    writeFileSync(file, conflicted)
    const writes: [string, string][] = []
    const text = `Resolve the merge conflict in the file below.\nFile: ${file}\n`
    const agent = fake()

    // Denied in the permission modal: nothing is written or proposed.
    const denied = await agent.ask(dir, text, { onPermission: deny, writable: file, onWrite: (p, c) => writes.push([p, c]) })
    expect(denied.text).toBe('Left the file as it was.')
    expect(writes).toEqual([])

    // Allowed: the content arrives as a proposal; the file on disk is untouched.
    const allowed = await agent.ask(dir, text, { onPermission: async () => 'allow', writable: file, onWrite: (p, c) => writes.push([p, c]) })
    expect(allowed.text).toBe('Kept both sides, ours first.')
    expect(writes).toEqual([[file, 'one\nours\ntheirs\nthree\n']])
    expect(readFileSync(file, 'utf8')).toBe(conflicted)

    // Allowed by the user, but not a file this request may write: the agent gets an error.
    await expect(agent.ask(dir, text, { onPermission: async () => 'allow', writable: join(dir, 'other.txt'), onWrite: () => {} }))
      .rejects.toThrow(/did not allow the agent to write/)
  })

  it('reports auth_required with the login methods, then works after authenticate', async () => {
    const agent = fake({ FAKE_AGENT_AUTH: '1' })
    const dir = tempDir()
    const err = await agent.ask(dir, 'Explain', { onPermission: deny }).catch((e) => e)
    expect(err).toBeInstanceOf(AgentAuthError)
    expect((err as AgentAuthError).methods.map((m) => m.id)).toEqual(['fake-login', 'fake-terminal'])
    await agent.authenticate('fake-login')
    await expect(agent.ask(dir, 'Explain', { onPermission: deny })).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('survives the agent crashing: the request fails, the next one starts a new agent', async () => {
    const agent = fake()
    const dir = tempDir()
    await expect(agent.ask(dir, 'FAKE:crash', { onPermission: deny })).rejects.toThrow(/agent stopped/)
    expect(agent.starts).toBe(1)
    await expect(agent.ask(dir, 'Write a commit message for it', { onPermission: deny })).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(agent.starts).toBe(2)
  })

  it('fails clearly when the command does not exist', async () => {
    const a = new AcpAgent(() => ({ command: '/no/such/agent', args: [] }))
    agents.push(a)
    await expect(a.info()).rejects.toThrow(/Could not start the agent/)
    // One that starts but quits before answering (what a missing command looks like through the Windows shell).
    const quits = new AcpAgent(() => ({ command: process.execPath, args: ['-e', 'process.exit(3)'] }))
    agents.push(quits)
    await expect(quits.info()).rejects.toThrow(/Could not start the agent .*: it exited before answering/)
  })
})

describe('ACP sessions (threads)', () => {
  it('a session remembers: follow-ups are later turns of the same conversation', async () => {
    const agent = fake()
    const sid = await agent.openSession(tempDir())
    expect((await agent.prompt(sid, 'hello', { onPermission: deny })).text).toBe('Turn 1. You said: hello.')
    expect((await agent.prompt(sid, 'again', { onPermission: deny })).text).toBe('Turn 2. You said: again.')
    // Another session is another conversation.
    const other = await agent.openSession(tempDir())
    expect((await agent.prompt(other, 'hi', { onPermission: deny })).text).toBe('Turn 1. You said: hi.')
    agent.closeSession(sid)
    expect(agent.hasSession(sid)).toBe(false)
    await expect(agent.prompt(sid, 'gone?', { onPermission: deny })).rejects.toBeInstanceOf(SessionGoneError)
  })

  it('passes on thoughts, plans and tool calls, merging tool updates into the whole call', async () => {
    const agent = fake()
    const dir = tempDir()
    const sid = await agent.openSession(dir)
    const seen: AgentUpdate[] = []
    const res = await agent.prompt(sid, 'FAKE:tools', { onPermission: deny, onUpdate: (u) => seen.push(u) })
    expect(res.text).toBe('Turn 1. Edited README.md.')
    expect(seen.map((u) => u.kind)).toEqual(['meta', 'thought', 'plan', 'tool', 'tool', 'text'])
    expect(seen[0]).toEqual({ kind: 'meta', commands: ['compact'] })
    const done = seen[4] as Extract<AgentUpdate, { kind: 'tool' }>
    // The update said only status and content; title, kind, input and locations carried over.
    expect(done.tool).toMatchObject({ id: 'edit-readme', title: 'Edit README.md', kind: 'edit', status: 'completed', locations: [`${dir}/README.md`] })
    expect(JSON.parse(done.tool.rawInput!)).toEqual({ path: `${dir}/README.md`, line: 1 })
    expect(done.tool.content).toEqual([{ type: 'diff', path: `${dir}/README.md`, oldText: 'old line\n', newText: 'new line\n' }])
  })

  it('shows the raw input of a permission ask, and "allow for this session" answers the same ask again', async () => {
    const agent = fake()
    const sid = await agent.openSession(tempDir())
    const asked: PermissionAsk[] = []
    const res = await agent.prompt(sid, 'FAKE:permission', {
      onPermission: async (a) => {
        asked.push(a)
        agent.rememberAllow(sid, a)
        return a.options.find((o) => o.kind === 'allow_once')!.optionId
      },
    })
    expect(res.text).toBe('Turn 1. First: allowed, second: allowed.')
    expect(asked).toHaveLength(1)
    expect(JSON.parse(asked[0]!.rawInput!)).toEqual({ command: 'npm test' })
    // Remembered for that session only.
    const other = await agent.openSession(tempDir())
    const again: PermissionAsk[] = []
    await agent.prompt(other, 'FAKE:permission', { onPermission: async (a) => (again.push(a), null) })
    expect(again).toHaveLength(2)
  })

  it('cancel ends the turn as cancelled', async () => {
    const agent = fake()
    const sid = await agent.openSession(tempDir())
    const abort = new AbortController()
    const p = agent.prompt(sid, 'FAKE:slow', { onPermission: deny, onText: (t) => t.includes('chunk 2') && abort.abort() }, abort.signal)
    await expect(p).resolves.toMatchObject({ stopReason: 'cancelled' })
    // The session takes the next turn.
    await expect(agent.prompt(sid, 'next', { onPermission: deny })).resolves.toMatchObject({ text: 'Turn 2. You said: next.' })
  })

  it('loads a session after a restart when the agent can, without repeating its history to us', async () => {
    const env = { FAKE_AGENT_LOAD: '1', FAKE_AGENT_STATE: join(tempDir(), 'state.json') }
    const agent = fake(env)
    const dir = tempDir()
    const sid = await agent.openSession(dir)
    await agent.prompt(sid, 'one', { onPermission: deny })
    await expect(agent.prompt(sid, 'FAKE:crash', { onPermission: deny })).rejects.toThrow(/agent stopped/)
    expect(agent.hasSession(sid)).toBe(false)
    expect(await agent.canLoad()).toBe(true)
    await agent.loadSession(sid, dir)
    const seen: string[] = []
    const res = await agent.prompt(sid, 'two', { onPermission: deny, onText: (t) => seen.push(t) })
    // The replayed history was not streamed into this turn; the agent remembered turn 1.
    expect(res.text).toBe('Turn 2. You said: two.')
    expect(seen).toEqual(['Turn 2. You said: two.'])
    expect(agent.starts).toBe(2)
  })
})

describe('allInside', () => {
  it('follows symlinks out of the repository', async () => {
    const dir = tempDir()
    const outside = tempDir()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), '')
    writeFileSync(join(outside, 'secret'), '')
    symlinkSync(join(outside, 'secret'), join(dir, 'link'))
    expect(await allInside(dir, [join(dir, 'src', 'a.ts'), join(dir, 'new-file.ts')])).toBe(true)
    expect(await allInside(dir, [join(dir, 'link')])).toBe(false)
    // A file that does not exist yet, under a linked folder, would be created outside.
    symlinkSync(outside, join(dir, 'linked-dir'))
    expect(await allInside(dir, [join(dir, 'linked-dir', 'new-file.ts')])).toBe(false)
    // The repository itself reached through a link is still the repository.
    const via = join(tempDir(), 'via')
    symlinkSync(dir, via)
    expect(await allInside(via, [join(dir, 'src', 'a.ts'), join(via, 'src', 'new.ts')])).toBe(true)
    expect(await allInside(dir, [join(dir, '..', 'x')])).toBe(false)
    expect(await allInside(dir, ['relative/path'])).toBe(false)
  })
})
