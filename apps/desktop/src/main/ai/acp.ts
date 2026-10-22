import type * as acp from '@agentclientprotocol/sdk'
import { realPathOf } from '@gitgoose/git'
import { AI_AUTH_REQUIRED, type AgentAuthMethod, type AgentInfo, type AiToolCall, type AiToolContent, type AiUpdate } from '@gitgoose/shared'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

/**
 * The ACP SDK (and zod under it) takes 100-200 ms to load. Most launches never start an agent,
 * so it is loaded with the agent instead of with the app: `spawn` sets this before anything
 * that uses it can run. Types come from the `import type` above, which costs nothing at runtime.
 */
let sdk: typeof acp

/**
 * GitGoose as an Agent Client Protocol *client*: the same role Zed or JetBrains play. We start
 * the user's agent (Claude, Codex, Gemini CLI, anything that speaks ACP) as a child process and
 * talk JSON-RPC over its stdin/stdout:
 *
 *   initialize          what each side can do; the agent lists its login methods
 *   session/new         one conversation per thread, cwd = the repository. Threads are
 *                       independent of each other (a shared session would run them one at a
 *                       time and carry every earlier diff along); within a thread, follow-ups
 *                       go to the same session, so the agent remembers what it said
 *   session/prompt      one turn; the agent streams session/update notifications back (text,
 *                       thoughts, tool calls with their diffs, plans), which we pass on typed
 *   session/load        reopen a thread's session after the agent restarted, when it can
 *   session/cancel      stop the turn in progress
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
  /** The tool's input (JSON, cut for size), when the agent sent one. */
  rawInput?: string
  options: { optionId: string; name: string; kind: acp.PermissionOptionKind }[]
}

/** What a turn streams, besides permission questions: the session/update kinds we show. */
export type AgentUpdate = Extract<AiUpdate, { kind: 'text' | 'thought' | 'tool' | 'plan' | 'meta' }>

/** How one prompt's traffic is handled. */
export interface PromptHooks {
  /** Called with the whole reply so far, after each streamed chunk. */
  onText?(text: string): void
  /** Every update, typed (text and thought chunks are deltas; a tool call comes whole each time). */
  onUpdate?(u: AgentUpdate): void
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

/** Tool inputs and outputs beyond this are cut: a card shows what happened, not a whole file. */
const MAX_TOOL_TEXT = 20_000

/** A session belongs to an agent process; after a restart it is gone (unless the agent can load it). */
export class SessionGoneError extends Error {
  constructor() {
    super('The agent restarted, so this conversation has to be reopened.')
    this.name = 'SessionGoneError'
  }
}

interface Session {
  cwd: string
  /** The turn in progress (null between turns). */
  hooks: PromptHooks | null
  text: string
  /** Replaying history during session/load: we have it already, so updates are ignored. */
  loading: boolean
  tools: Map<string, AiToolCall>
  /** Tool calls the user allowed "for this session" (see permissionKey). */
  allowed: Set<string>
}

interface Running {
  child: ChildProcess
  conn: acp.ClientConnection
  init: acp.InitializeResponse
}

export class AcpAgent {
  private running: Promise<Running> | null = null
  /** sessionId -> its repository and the turn it is running. Cleared when the process goes. */
  private bySession = new Map<string, Session>()
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
    sdk ??= await import('@agentclientprotocol/sdk')
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

    const stream = sdk.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>)
    const conn = sdk.client({ name: 'gitgoose' })
      .onNotification(sdk.methods.client.session.update, (ctx) => this.onUpdate(ctx.params))
      .onRequest(sdk.methods.client.session.requestPermission, (ctx) => this.onPermission(ctx.params))
      .onRequest(sdk.methods.client.fs.readTextFile, (ctx) => this.onRead(ctx.params))
      .onRequest(sdk.methods.client.fs.writeTextFile, (ctx) => this.onWrite(ctx.params))
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
      init = await withTimeout(conn.agent.request(sdk.methods.agent.initialize, {
        protocolVersion: sdk.PROTOCOL_VERSION,
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
    if (e instanceof sdk.RequestError && e.code === AUTH_REQUIRED) return new AgentAuthError(toInfo(init, this.launch()).authMethods)
    return e
  }

  /** A new conversation in `cwd`. */
  async openSession(cwd: string): Promise<string> {
    const { conn, init } = await this.start()
    let sessionId: string
    try {
      sessionId = (await conn.agent.request(sdk.methods.agent.session.new, { cwd, mcpServers: [] })).sessionId
    } catch (e) {
      throw this.authError(e, init)
    }
    this.bySession.set(sessionId, newSession(cwd))
    return sessionId
  }

  /** The session still exists in the running agent (false after a restart). */
  hasSession(sessionId: string): boolean {
    return this.bySession.has(sessionId)
  }

  /** The running agent can reopen a session it had before a restart (ACP loadSession). */
  async canLoad(): Promise<boolean> {
    const { init } = await this.start()
    return init.agentCapabilities?.loadSession === true
  }

  /**
   * Reopen a session from an earlier agent process. The agent replays the conversation as
   * session/update notifications; we already have it, so they are dropped.
   */
  async loadSession(sessionId: string, cwd: string): Promise<void> {
    const { conn, init } = await this.start()
    const entry = { ...newSession(cwd), loading: true }
    this.bySession.set(sessionId, entry)
    try {
      await conn.agent.request(sdk.methods.agent.session.load, { sessionId, cwd, mcpServers: [] })
    } catch (e) {
      this.bySession.delete(sessionId)
      throw this.authError(e, init)
    } finally {
      entry.loading = false
    }
  }

  /**
   * One turn in a session; resolves with the turn's whole reply once the agent ends it. Abort
   * the signal to cancel (session/cancel; the agent then ends the turn as 'cancelled').
   */
  async prompt(sessionId: string, prompt: string | acp.ContentBlock[], hooks: PromptHooks, signal?: AbortSignal): Promise<{ text: string; stopReason: string }> {
    const { conn, init } = await this.start()
    const entry = this.bySession.get(sessionId)
    if (!entry) throw new SessionGoneError()
    if (entry.hooks) throw new Error('This conversation is still answering. Wait for it, or stop it first.')
    entry.hooks = hooks
    entry.text = ''
    const cancel = () => void conn.agent.notify(sdk.methods.agent.session.cancel, { sessionId }).catch(() => {})
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const blocks = typeof prompt === 'string' ? [{ type: 'text' as const, text: prompt }] : prompt
      const res = await conn.agent.request(sdk.methods.agent.session.prompt, { sessionId, prompt: blocks })
      return { text: entry.text, stopReason: res.stopReason }
    } catch (e) {
      if (conn.signal.aborted) throw new Error(this.died())
      throw this.authError(e, init)
    } finally {
      signal?.removeEventListener('abort', cancel)
      entry.hooks = null
    }
  }

  /** End a session: forget it, and free the agent's memory for it where the agent supports that. */
  closeSession(sessionId: string): void {
    if (!this.bySession.delete(sessionId)) return
    const running = this.current
    // An unstable capability: only agents that advertise it get the request.
    const caps = running?.init.agentCapabilities?.sessionCapabilities as Record<string, unknown> | undefined
    if (running && caps?.close && !running.conn.signal.aborted) void running.conn.agent.request(sdk.methods.agent.session.close, { sessionId }).catch(() => {})
  }

  /** Answer later questions like this one in this session without asking ("Allow for this session"). */
  rememberAllow(sessionId: string, ask: PermissionAsk): void {
    this.bySession.get(sessionId)?.allowed.add(permissionKey(ask))
  }

  /** One request in a new session, closed afterwards (tests, and anything that needs no thread). */
  async ask(cwd: string, text: string, hooks: PromptHooks, signal?: AbortSignal): Promise<{ text: string; stopReason: string }> {
    const sessionId = await this.openSession(cwd)
    try {
      return await this.prompt(sessionId, text, hooks, signal)
    } finally {
      this.closeSession(sessionId)
    }
  }

  /** Log in with a method the agent handles itself (not terminal methods: the user runs those). */
  async authenticate(methodId: string): Promise<void> {
    const { conn } = await this.start()
    await conn.agent.request(sdk.methods.agent.authenticate, { methodId })
  }

  stop(): void {
    this.current?.child.kill()
    this.reset()
  }

  // ------------------------------------------------------------ the agent calling us

  private onUpdate(n: acp.SessionNotification): void {
    const entry = this.bySession.get(n.sessionId)
    const hooks = entry?.hooks
    if (!entry || entry.loading || !hooks) return
    const u = n.update
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content.type !== 'text') return
        entry.text += u.content.text
        hooks.onText?.(entry.text)
        return hooks.onUpdate?.({ kind: 'text', text: u.content.text })
      case 'agent_thought_chunk':
        if (u.content.type === 'text') hooks.onUpdate?.({ kind: 'thought', text: u.content.text })
        return
      case 'tool_call':
      case 'tool_call_update': {
        // An update names only what changed; the card shows the call as it is now.
        const old = entry.tools.get(u.toolCallId)
        const tool: AiToolCall = {
          id: u.toolCallId,
          title: u.title ?? old?.title ?? 'Tool call',
          kind: u.kind ?? old?.kind ?? 'other',
          status: u.status ?? old?.status ?? 'pending',
          rawInput: u.rawInput !== undefined && u.rawInput !== null ? cut(json(u.rawInput)) : old?.rawInput,
          locations: u.locations ? u.locations.map((l) => (l.line ? `${l.path}:${l.line}` : l.path)) : (old?.locations ?? []),
          content: u.content ? toolContent(u.content) : (old?.content ?? []),
        }
        if (tool.rawInput === undefined) delete tool.rawInput
        entry.tools.set(tool.id, tool)
        return hooks.onUpdate?.({ kind: 'tool', tool })
      }
      case 'plan':
        return hooks.onUpdate?.({ kind: 'plan', entries: u.entries.map((e) => ({ content: e.content, priority: e.priority, status: e.status })) })
      case 'current_mode_update':
        return hooks.onUpdate?.({ kind: 'meta', mode: u.currentModeId })
      case 'available_commands_update':
        return hooks.onUpdate?.({ kind: 'meta', commands: u.availableCommands.map((c) => c.name) })
      default:
        return
    }
  }

  private async onPermission(p: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const entry = this.bySession.get(p.sessionId)
    const cancelled: acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
    if (!entry?.hooks) return cancelled
    const paths = (p.toolCall.locations ?? []).map((l) => l.path)
    const once = p.options.find((o) => o.kind === 'allow_once') ?? p.options.find((o) => o.kind === 'allow_always')
    // The one silent yes: reading files inside the repository.
    if (p.toolCall.kind === 'read' && paths.length && (await allInside(entry.cwd, paths))) {
      if (once) return { outcome: { outcome: 'selected', optionId: once.optionId } }
    }
    const ask: PermissionAsk = {
      title: p.toolCall.title ?? 'The agent wants to use a tool',
      kind: p.toolCall.kind ?? 'other',
      paths,
      ...(p.toolCall.rawInput !== undefined && p.toolCall.rawInput !== null ? { rawInput: cut(json(p.toolCall.rawInput)) } : {}),
      options: p.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    }
    // The user said yes to exactly this earlier in the session.
    if (once && entry.allowed.has(permissionKey(ask))) return { outcome: { outcome: 'selected', optionId: once.optionId } }
    const optionId = await entry.hooks.onPermission(ask)
    return optionId && p.options.some((o) => o.optionId === optionId) ? { outcome: { outcome: 'selected', optionId } } : cancelled
  }

  private async onRead(p: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const entry = this.bySession.get(p.sessionId)
    if (!entry || !(await allInside(entry.cwd, [p.path]))) {
      throw sdk.RequestError.invalidParams(undefined, 'GitGoose only lets the agent read files inside the open repository.')
    }
    let content = await readFile(p.path, 'utf8').catch(() => {
      throw sdk.RequestError.resourceNotFound(p.path)
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
      throw sdk.RequestError.invalidParams(undefined, 'GitGoose did not allow the agent to write this file.')
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

function newSession(cwd: string): Session {
  return { cwd, hooks: null, text: '', loading: false, tools: new Map(), allowed: new Set() }
}

/**
 * What "Allow for this session" covers: the same kind of tool, the same title and the same
 * input. Allowing `npm test` once for the session does not allow `rm -rf`.
 */
function permissionKey(ask: PermissionAsk): string {
  return `${ask.kind}\n${ask.title}\n${ask.rawInput ?? ''}`
}

function json(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function cut(text: string): string {
  return text.length > MAX_TOOL_TEXT ? `${text.slice(0, MAX_TOOL_TEXT)}\n… ${text.length - MAX_TOOL_TEXT} more characters` : text
}

function toolContent(content: acp.ToolCallContent[]): AiToolContent[] {
  return content.flatMap((c): AiToolContent[] => {
    if (c.type === 'diff') return [{ type: 'diff', path: c.path, oldText: c.oldText == null ? null : cut(c.oldText), newText: cut(c.newText) }]
    if (c.type === 'content' && c.content.type === 'text') return [{ type: 'text', text: cut(c.content.text) }]
    // Terminals: we give the agent none. Images and resources: not shown in a git client.
    return []
  })
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
