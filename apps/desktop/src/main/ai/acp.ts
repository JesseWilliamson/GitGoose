import * as acp from '@agentclientprotocol/sdk'
import { realPathOf } from '@gitgoose/git'
import { AI_AUTH_REQUIRED, type AgentAuthMethod, type AgentInfo } from '@gitgoose/shared'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

/**
 * GitGoose as an Agent Client Protocol *client*: the same role Zed or JetBrains play. We start
 * the user's agent (Claude, Codex, Gemini CLI, anything that speaks ACP) as a child process and
 * talk JSON-RPC over its stdin/stdout:
 *
 *   initialize          what each side can do; the agent lists its login methods
 *   session/new         a fresh conversation per request, cwd = the repository (requests are
 *                       independent: a shared session would run them one at a time and carry
 *                       every earlier diff along in its context)
 *   session/prompt      the request; the agent streams session/update notifications back
 *
 * and the agent calls *us* for anything outside its own process:
 *
 *   session/request_permission   before a tool call: we show a modal (read-only reads of files
 *                                inside the repository are the only thing allowed silently)
 *   fs/read_text_file            only inside the session's repository
 *   fs/write_text_file           only the one file a request allows, and even then the content
 *                                is captured as a proposal for the user to review, not written
 *
 * The agent's credentials never pass through GitGoose: it logs in on its own.
 */

export interface AgentLaunch {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface PermissionAsk {
  title: string
  kind: string
  paths: string[]
  options: { optionId: string; name: string; kind: acp.PermissionOptionKind }[]
}

/** How one prompt's traffic is handled. */
export interface PromptHooks {
  /** Called with the whole reply so far, after each streamed chunk. */
  onText?(text: string): void
  /** Ask the user. Resolves to the chosen optionId, or null to cancel. */
  onPermission(ask: PermissionAsk): Promise<string | null>
  /** The one file this prompt may "write" (absolute path); writes are handed to onWrite. */
  writable?: string
  onWrite?(path: string, content: string): void
}

export class AgentAuthError extends Error {
  readonly code = AI_AUTH_REQUIRED
  constructor(readonly methods: AgentAuthMethod[]) {
    super('The agent needs you to log in first.')
    this.name = 'AgentAuthError'
  }
}

const AUTH_REQUIRED = -32000

interface Running {
  child: ChildProcess
  conn: acp.ClientConnection
  init: acp.InitializeResponse
}

export class AcpAgent {
  private running: Promise<Running> | null = null
  /** sessionId -> its repository and the prompt it is running. */
  private bySession = new Map<string, { cwd: string; hooks: PromptHooks; text: string }>()
  /** The agent's last stderr lines: shown when it fails to start or dies. */
  private stderr = ''
  /** How many times the agent process has been started (tests use it to see restarts). */
  starts = 0

  constructor(private launch: () => AgentLaunch) {}

  /** Start the agent if it is not running, and run initialize. */
  start(): Promise<Running> {
    this.running ??= this.spawn().catch((e) => {
      this.running = null
      throw e
    })
    return this.running
  }

  async info(): Promise<AgentInfo> {
    const { init } = await this.start()
    return toInfo(init, this.launch())
  }

  private async spawn(): Promise<Running> {
    const { command, args, env } = this.launch()
    if (!command) throw new Error('No agent command is configured (Settings → AI).')
    this.starts++
    this.stderr = ''
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      // npx and friends are .cmd shims on Windows.
      shell: process.platform === 'win32',
    })
    const spawned = new Promise<void>((ok, fail) => {
      child.once('spawn', ok)
      child.once('error', (e) => fail(new Error(`Could not start the agent (${command}): ${e.message}`)))
    })
    child.stderr!.setEncoding('utf8').on('data', (t: string) => {
      this.stderr = (this.stderr + t).slice(-4000)
    })
    await spawned

    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>)
    const conn = acp.client({ name: 'gitgoose' })
      .onNotification(acp.methods.client.session.update, (ctx) => this.onUpdate(ctx.params))
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.onPermission(ctx.params))
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) => this.onRead(ctx.params))
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => this.onWrite(ctx.params))
      .connect(stream)

    // The process dying (or closing its stdout) ends everything: forget its sessions; the next
    // use starts a fresh agent. Whichever we notice first, the connection or the process.
    const gone = () => {
      if (this.current?.conn === conn) this.reset()
      child.kill()
    }
    conn.signal.addEventListener('abort', gone, { once: true })
    child.once('exit', () => {
      gone()
      conn.close(new Error(this.died()))
    })

    let init: acp.InitializeResponse
    try {
      init = await withTimeout(conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          // No shell for the agent from a git client.
          terminal: false,
          // We can show a terminal login command to the user (see AgentAuthMethod.terminalCommand).
          auth: { terminal: true },
        },
        clientInfo: { name: 'gitgoose', version: '0.1.0' },
      }), 60_000, 'The agent did not answer initialize within a minute.')
    } catch (e) {
      // Exiting before initialize means it never started: through the Windows shell a missing
      // command looks like this (the shell starts, prints an error and exits), not like a spawn error.
      const exited = child.exitCode !== null || await new Promise<boolean>((ok) => {
        child.once('exit', () => ok(true))
        setTimeout(() => ok(false), 1000)
      })
      child.kill()
      const message = exited ? `Could not start the agent (${command}): it exited before answering.` : (e as Error).message
      throw new Error(`${message}${this.stderr ? `\n\n${this.stderr.trim()}` : ''}`)
    }
    const running = { child, conn, init }
    this.current = running
    return running
  }

  private current: Running | null = null

  private died(): string {
    return `The agent stopped.${this.stderr ? `\n\n${this.stderr.trim()}` : ''}`
  }

  private reset() {
    this.running = null
    this.current = null
    this.bySession.clear()
  }

  private authError(e: unknown, init: acp.InitializeResponse): unknown {
    if (e instanceof acp.RequestError && e.code === AUTH_REQUIRED) return new AgentAuthError(toInfo(init, this.launch()).authMethods)
    return e
  }

  /** Run one request in a new session; resolves with the full reply. Abort the signal to cancel. */
  async prompt(cwd: string, text: string, hooks: PromptHooks, signal?: AbortSignal): Promise<{ text: string; stopReason: string }> {
    const { conn, init } = await this.start()
    let sessionId: string
    try {
      sessionId = (await conn.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })).sessionId
    } catch (e) {
      throw this.authError(e, init)
    }
    const entry = { cwd, hooks, text: '' }
    this.bySession.set(sessionId, entry)
    const cancel = () => void conn.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {})
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const res = await conn.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] })
      return { text: entry.text, stopReason: res.stopReason }
    } catch (e) {
      if (conn.signal.aborted) throw new Error(this.died())
      throw this.authError(e, init)
    } finally {
      signal?.removeEventListener('abort', cancel)
      this.bySession.delete(sessionId)
      // Free the agent's memory for it, where the agent supports that (an unstable capability).
      const caps = init.agentCapabilities?.sessionCapabilities as Record<string, unknown> | undefined
      if (caps?.close && !conn.signal.aborted) void conn.agent.request(acp.methods.agent.session.close, { sessionId }).catch(() => {})
    }
  }

  /** Log in with a method the agent handles itself (not terminal methods: the user runs those). */
  async authenticate(methodId: string): Promise<void> {
    const { conn } = await this.start()
    await conn.agent.request(acp.methods.agent.authenticate, { methodId })
  }

  stop(): void {
    this.current?.child.kill()
    this.reset()
  }

  // ------------------------------------------------------------ the agent calling us

  private onUpdate(n: acp.SessionNotification): void {
    const entry = this.bySession.get(n.sessionId)
    if (!entry) return
    const u = n.update
    if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
      entry.text += u.content.text
      entry.hooks.onText?.(entry.text)
    }
  }

  private async onPermission(p: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const entry = this.bySession.get(p.sessionId)
    const cancelled: acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
    if (!entry) return cancelled
    const paths = (p.toolCall.locations ?? []).map((l) => l.path)
    // The one silent yes: reading files inside the repository.
    if (p.toolCall.kind === 'read' && paths.length && (await allInside(entry.cwd, paths))) {
      const once = p.options.find((o) => o.kind === 'allow_once')
      if (once) return { outcome: { outcome: 'selected', optionId: once.optionId } }
    }
    const optionId = await entry.hooks.onPermission({
      title: p.toolCall.title ?? 'The agent wants to use a tool',
      kind: p.toolCall.kind ?? 'other',
      paths,
      options: p.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    })
    return optionId && p.options.some((o) => o.optionId === optionId) ? { outcome: { outcome: 'selected', optionId } } : cancelled
  }

  private async onRead(p: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const entry = this.bySession.get(p.sessionId)
    if (!entry || !(await allInside(entry.cwd, [p.path]))) {
      throw acp.RequestError.invalidParams(undefined, 'GitGoose only lets the agent read files inside the open repository.')
    }
    let content = await readFile(p.path, 'utf8').catch(() => {
      throw acp.RequestError.resourceNotFound(p.path)
    })
    if (p.line || p.limit) {
      const lines = content.split('\n')
      const from = Math.max(0, (p.line ?? 1) - 1)
      content = lines.slice(from, p.limit ? from + p.limit : undefined).join('\n')
    }
    return { content }
  }

  private async onWrite(p: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    const hooks = this.bySession.get(p.sessionId)?.hooks
    if (!hooks?.writable || resolve(p.path) !== resolve(hooks.writable) || !hooks.onWrite) {
      throw acp.RequestError.invalidParams(undefined, 'GitGoose did not allow the agent to write this file.')
    }
    hooks.onWrite(resolve(p.path), p.content)
    return {}
  }
}

/**
 * Every path is inside dir, after resolving symlinks (a link inside the repo can point out). A
 * path that does not exist yet is judged by the folders it would be created in, so a new file
 * under a linked folder counts as where the link goes.
 */
export async function allInside(dir: string, paths: string[]): Promise<boolean> {
  const root = await realPathOf(dir)
  for (const p of paths) {
    if (!isAbsolute(p)) return false
    const real = await realPathOf(p)
    const rel = relative(root, real)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  }
  return true
}

function toInfo(init: acp.InitializeResponse, launch: AgentLaunch): AgentInfo {
  return {
    name: init.agentInfo?.title ?? init.agentInfo?.name ?? launch.command,
    version: init.agentInfo?.version ?? '',
    protocolVersion: init.protocolVersion,
    authMethods: (init.authMethods ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description ?? undefined,
      // Terminal methods: the client reruns the agent's own command with extra arguments.
      terminalCommand: 'type' in m && m.type === 'terminal'
        ? [launch.command, ...launch.args, ...(m.args ?? [])].map(quoteArg).join(' ')
        : undefined,
    })),
  }
}

/** Quote for the shell the user will paste into: cmd and PowerShell take double quotes, not single. */
function quoteArg(a: string): string {
  if (process.platform === 'win32') return /^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(message)), ms)
    p.then((v) => (clearTimeout(t), ok(v)), (e) => (clearTimeout(t), fail(e)))
  })
}
