import { tempDir } from '@gitsquid/fixtures'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpAgent, AgentAuthError, allInside, type PermissionAsk } from './acp'

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
    const res = await fake().prompt(tempDir(), 'Write a commit message for this diff', { onText: (t) => seen.push(t), onPermission: deny })
    expect(res.text).toBe('feat: add the widget registry\n\nRegisters widgets by name so plugins can add their own.')
    expect(seen).toHaveLength(3)
    expect(res.stopReason).toBe('end_turn')
  })

  it('passes on what the agent shares while it works: thinking, tool calls, its plan', async () => {
    const seen: string[] = []
    await fake().prompt(tempDir(), 'Explain this commit', {
      onPermission: deny,
      onStarted: () => seen.push('started'),
      onThought: (t) => seen.push(`thought: ${t}`),
      onTool: (id, title, status) => seen.push(`tool ${id}: ${title ?? '-'} ${status ?? '-'}`),
      onPlan: (entries) => seen.push(`plan: ${entries.map((e) => `${e.content} (${e.status})`).join(', ')}`),
    })
    expect(seen).toEqual([
      'started',
      'plan: Read the change (in_progress), Explain it (pending)',
      'thought: The diff touches ',
      'thought: The diff touches one file.', // the whole thought so far, each time
      'tool read-1: Read README in_progress',
      'tool read-1: - completed', // an update carries only what changed
    ])
  })

  it('runs requests in the same repository side by side, each in its own session', async () => {
    const agent = fake()
    const dir = tempDir()
    const [a, b] = await Promise.all([
      agent.prompt(dir, 'Write a commit message', { onPermission: deny }),
      agent.prompt(dir, 'Explain this commit', { onPermission: deny }),
    ])
    expect(a.text).toContain('feat: add the widget registry')
    expect(b.text).toContain('This change explains itself.')
    expect(agent.starts).toBe(1)
  })

  it('allows reads inside the repository silently, and asks for anything else', async () => {
    const asked: PermissionAsk[] = []
    const res = await fake().prompt(tempDir(), 'Explain this commit', {
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
    const denied = await agent.prompt(dir, text, { onPermission: deny, writable: file, onWrite: (p, c) => writes.push([p, c]) })
    expect(denied.text).toBe('Left the file as it was.')
    expect(writes).toEqual([])

    // Allowed: the content arrives as a proposal; the file on disk is untouched.
    const allowed = await agent.prompt(dir, text, { onPermission: async () => 'allow', writable: file, onWrite: (p, c) => writes.push([p, c]) })
    expect(allowed.text).toBe('Kept both sides, ours first.')
    expect(writes).toEqual([[file, 'one\nours\ntheirs\nthree\n']])
    expect(readFileSync(file, 'utf8')).toBe(conflicted)

    // Allowed by the user, but not a file this request may write: the agent gets an error.
    await expect(agent.prompt(dir, text, { onPermission: async () => 'allow', writable: join(dir, 'other.txt'), onWrite: () => {} }))
      .rejects.toThrow(/did not allow the agent to write/)
  })

  it('reports auth_required with the login methods, then works after authenticate', async () => {
    const agent = fake({ FAKE_AGENT_AUTH: '1' })
    const dir = tempDir()
    const err = await agent.prompt(dir, 'Explain', { onPermission: deny }).catch((e) => e)
    expect(err).toBeInstanceOf(AgentAuthError)
    expect((err as AgentAuthError).methods.map((m) => m.id)).toEqual(['fake-login', 'fake-terminal'])
    await agent.authenticate('fake-login')
    await expect(agent.prompt(dir, 'Explain', { onPermission: deny })).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('survives the agent crashing: the request fails, the next one starts a new agent', async () => {
    const agent = fake()
    const dir = tempDir()
    await expect(agent.prompt(dir, 'FAKE:crash', { onPermission: deny })).rejects.toThrow(/agent stopped/)
    expect(agent.starts).toBe(1)
    await expect(agent.prompt(dir, 'Write a commit message', { onPermission: deny })).resolves.toMatchObject({ stopReason: 'end_turn' })
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
