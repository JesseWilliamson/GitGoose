import type { Repo } from '@gitgoose/git'
import {
  commandArgv, defaultTarget, effectivePrompt, openingPromptKind, reduceThread, systemPromptKind, targetCommandLine, targetKey, targetLabel, transcript,
  type PromptKind, type PromptPreview, type PromptText,
  type AgentInfo, type AiArtifactResult, type AiModelList, type AiPermissionAsk, type AiPermissionRequest, type AiResult, type AiRunOptions, type AiStatus, type AiTarget, type AiTask,
  type AiThread, type AiUpdate, type ArtifactKind, type GitGooseEvent, type PermissionAnswer, type ReviewProfile, type Settings, type ThreadAnchor,
} from '@gitgoose/shared'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { AcpAgent, type PermissionAsk, type PromptHooks, type SessionModels } from './acp'
import { anthropicChat, anthropicModels } from './anthropic'
import type { SecretFile } from './keyStore'
import { extractJson, locateSecret, redactSecrets, repairPlan, scanSecrets, verifyFindings, verifyMermaid, verifyPushChecks, verifyWalkthrough } from '@gitgoose/git'
import { lintForReview } from './linters'
import {
  ANCHOR_ARTIFACTS, anchorContext, type PromptContext, anchorOf, anchorTask, artifactProtocol, buildPrompt, cleanCommitMessage, featureLabel, openingMessage, replayMessage, type BuiltPrompt,
} from './prompts'

/**
 * AI requests, from the renderer's "✨" to an answer. Plain Node; index.ts wires it to Electron.
 *
 * The rules this class enforces (the renderer asks nicely first, but main decides):
 *   - nothing is sent, and no agent is started, until the user has agreed to this provider
 *   - every tool call the agent asks about goes to the user (see acp.ts for the one exception)
 *   - an agent's file write is only ever a proposal the user then accepts or not
 *   - nothing that looks like a credential is sent unless the user chose to send it redacted
 */
export interface AiServiceDeps {
  settings: () => Settings
  setSettings: (patch: Partial<Settings>) => void
  repo: (repoId: string) => Repo
  apiKey: SecretFile
  emit: (event: GitGooseEvent) => void
  anthropicBaseURL?: string
  fetch?: typeof fetch
  /** How long a thread's session outlives its view (10 minutes; tests shorten it). */
  threadIdleMs?: number
}

/** A thread's session stays this long after its view closes, so coming back is instant. */
export const THREAD_IDLE_MS = 10 * 60_000

/** Threads kept per repository (most recently used first). */
const MAX_THREADS = 100

/**
 * The last check before anything leaves: scan exactly the text that would be sent. With hits,
 * either stop and say what was found (masked), or, when the user chose to, replace each one with
 * a "[REDACTED kind]" marker. Scanning the final text rather than the inputs means no prompt
 * builder can forget to call it.
 */
export function guardSecrets(built: BuiltPrompt, redact: boolean): void {
  if (!checkSecrets(`${built.system}\n\n${built.prompt}`, redact)) return
  built.system = redactSecrets(built.system).text
  built.prompt = redactSecrets(built.prompt).text
}

/** The same check for one turn of a conversation: every outgoing turn, not only the first. Returns the text to send. */
export function guardTurn(text: string, redact: boolean): string {
  return checkSecrets(text, redact) ? redactSecrets(text).text : text
}

/**
 * The same check for one turn over the API. The API keeps no session, so a turn sends the whole
 * conversation again: the system prompt, every earlier exchange, and the new message. All of it
 * is scanned together (one refusal lists everything) and, when redacting, all of it is redacted.
 * Earlier exchanges matter: a thread reopened from disk rebuilds its first message with the
 * context as it is now, which this turn would be the first to send.
 */
export function guardApiTurn(system: string, history: { user: string; agent: string }[], text: string, redact: boolean): { system: string; history: { user: string; agent: string }[]; text: string } {
  const outgoing = [system, ...history.flatMap((h) => [h.user, h.agent]), text].join('\n\n')
  if (!checkSecrets(outgoing, redact)) return { system, history, text }
  const r = (s: string) => redactSecrets(s).text
  return { system: r(system), history: history.map((h) => ({ user: r(h.user), agent: r(h.agent) })), text: r(text) }
}

/** True when there are hits and the user chose to send them redacted; throws when they did not. */
function checkSecrets(outgoing: string, redact: boolean): boolean {
  const hits = scanSecrets(outgoing)
  if (!hits.length) return false
  if (redact) return true
  const list = hits.slice(0, 5).map((h) => {
    const at = locateSecret(outgoing, h.index)
    const where = at.file ? ` in ${at.file}${at.line ? `:${at.line}` : ''}` : ''
    return `• ${h.kind} ${h.masked}${where}${at.excerpt ? `\n    ${at.excerpt}` : ''}`
  })
  if (hits.length > 5) list.push(`• and ${hits.length - 5} more`)
  throw new AiError(
    `This request contains ${hits.length === 1 ? 'something that looks like a secret' : `${hits.length} things that look like secrets`}, so nothing was sent.\n\n${list.join('\n')}`,
    'ai-secrets',
  )
}

export class AiError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'AiError'
  }
}

/**
 * One conversation, as main keeps it. `thread` is the copy the renderer mirrors (both fold the
 * same ai-update events with reduceThread); the rest is what only main needs.
 */
interface ThreadRec {
  thread: AiThread
  repoId: string
  /** The repository's folder (null for a request with no repository). */
  path: string | null
  cwd: string
  /** Saved and mirrored to the renderer (a view shows it); one-shot requests are neither. */
  keep: boolean
  /** The ACP session; null until the first turn, and gone when the agent restarts. */
  sessionId: string | null
  /** Which agent process (its command line) holds the session; null with no session. */
  agentLine: string | null
  /** Who the conversation is with: set by each turn (a thread can move to another agent, or model). */
  target: AiTarget | null
  /** The session has had the conversation's opening (context and artifact protocol). */
  primed: boolean
  /** What was actually exchanged, oldest first (the first message carries the context). null: not rebuilt yet. */
  history: { user: string; agent: string }[] | null
  /**
   * The history's first message went to the API, which takes the system prompt apart from the
   * messages, so the message itself lacks it. Any agent session told this history later (after
   * a move, or after that agent restarts) needs the system prompt put back in front.
   */
  systemApart: boolean
  /** The API mode's system prompt. */
  system: string
  /** The words the latest send brought for this conversation's opening (the AI panel's, Ask's). */
  prompt?: PromptText
  /** What the feature saw, for checking artifacts with the feature's own verifier. */
  built: BuiltPrompt | null
  task: AiTask | null
  active: { requestId: string; abort: AbortController } | null
  /** A send is working out its turn (opening the session, building the context). */
  starting: boolean
  /** A view shows it; when the last one closes, the idle grace starts. */
  open: boolean
  idle: ReturnType<typeof setTimeout> | null
}

/** One turn, worked out before anything is sent (so a secret, a login or a git error fails before the turn starts). */
interface Outgoing {
  /** What goes to the agent (or, in API mode, the new user message). */
  text: string
  /** What the conversation remembers as this user message (the opening, or just the text). */
  logical: string
  /** API mode: the whole conversation to send. */
  messages?: { role: 'user' | 'assistant'; content: string }[]
}

interface PendingPermission {
  requestId: string
  resolve: (optionId: string | null) => void
  /** Thread permission cards: which thread, which session, and the question (for "for this session"). */
  thread?: { rec: ThreadRec; ask: PermissionAsk }
}

export class AiService {
  /**
   * One agent process per command line. Each AI area can pick its own agent, so several may run;
   * a thread's session lives in exactly one of them (ThreadRec.agentLine).
   */
  private agents = new Map<string, AcpAgent>()
  /** Command lines with something in flight outside a thread (listing models, Test): not pruned meanwhile. */
  private pinned = new Map<string, number>()
  private requests = new Map<string, { cancel: () => void }>()
  private permissions = new Map<number, PendingPermission>()
  private nextPermission = 1
  private threads = new Map<string, ThreadRec>()

  constructor(private deps: AiServiceDeps) {}

  /** Settings → AI's agent (what Test starts; tests count its starts). */
  get agent(): AcpAgent {
    return this.agentFor(this.commandLine())
  }

  private agentFor(line: string): AcpAgent {
    let agent = this.agents.get(line)
    if (!agent) {
      agent = new AcpAgent(() => {
        const argv = commandArgv(line, {})
        return { command: argv[0] ?? '', args: argv.slice(1) }
      }, { onModels: (m) => this.rememberModels(line, m) })
      this.agents.set(line, agent)
    }
    return agent
  }

  /** Settings → AI's agent command line (whatever the provider). */
  private commandLine(): string {
    const s = this.deps.settings()
    return targetCommandLine({ provider: 'agent', agent: s.aiAgent as AiTarget['agent'], agentCommand: s.aiAgentCommand })
  }

  /**
   * A target with its blanks filled from settings; null when AI is off. Omitted: Settings → AI.
   * An empty model means the default for that provider: the API's model setting, or the default
   * model chosen for that agent (none: the agent's own default, which needs nothing set).
   */
  private target(t?: AiTarget | null): AiTarget | null {
    const s = this.deps.settings()
    if (s.aiProvider === 'off') return null
    if (!t) return defaultTarget(s)
    if (t.provider === 'anthropic') return { provider: 'anthropic', model: t.model || s.anthropicModel || 'claude-opus-5-5' }
    const agent = t.agent ?? 'claude'
    const base: AiTarget = { provider: 'agent', agent, ...(agent === 'custom' ? { agentCommand: t.agentCommand ?? '' } : {}) }
    const model = t.model || s.aiAgentModel[targetKey(base)]
    return model ? { ...base, model } : base
  }

  status(t?: AiTarget): AiStatus {
    const s = this.deps.settings()
    const target = this.target(t)
    const hasApiKey = !!this.deps.apiKey.get()
    const keyInMemoryOnly = hasApiKey && !this.deps.apiKey.persisted()
    if (!target) return { provider: 'off', label: 'AI', ready: false, consented: false, hasApiKey, keyInMemoryOnly }
    // Consent is to a process, not a model: switching models within an agent asks nothing new.
    return {
      provider: target.provider,
      label: targetLabel({ ...target, model: undefined }),
      ready: target.provider === 'agent' ? !!targetCommandLine(target) : hasApiKey,
      consented: s.aiConsent.includes(targetKey(target)),
      hasApiKey,
      keyInMemoryOnly,
    }
  }

  consent(t?: AiTarget): AiStatus {
    const target = this.target(t)
    const s = this.deps.settings()
    const key = target ? targetKey(target) : ''
    if (key && !s.aiConsent.includes(key)) this.deps.setSettings({ aiConsent: [...s.aiConsent, key] })
    return this.status(t)
  }

  setApiKey(key: string | null): AiStatus {
    this.deps.apiKey.set(key?.trim() || null)
    return this.status()
  }

  /**
   * Settings changed: stop agents nothing can reach any more (a custom command that was edited,
   * an area that picked another agent). An agent with a session, the default one, any area's
   * pick, and one busy listing models all stay.
   */
  onSettings(): void {
    this.prune()
  }

  /**
   * Stop every agent process nothing can reach: not the default, not an area's pick, holding no
   * session and not pinned. Run when settings change, and whenever one of those holds ends (a
   * session closes, a pin is released), or a process on an abandoned command line lives on.
   */
  private prune(): void {
    const s = this.deps.settings()
    const keep = new Set<string>([this.commandLine()])
    for (const t of Object.values(s.aiAreaTargets)) if (t?.provider === 'agent') keep.add(targetCommandLine(t))
    for (const rec of this.threads.values()) if (rec.agentLine) keep.add(rec.agentLine)
    for (const [line, agent] of this.agents) {
      if (keep.has(line) || this.pinned.has(line) || agent.sessionCount() > 0) continue
      agent.stop()
      this.agents.delete(line)
    }
  }

  /** Run `work` with an agent that may not be pruned meanwhile. */
  private async withAgent<T>(line: string, work: (agent: AcpAgent) => Promise<T>): Promise<T> {
    this.pinned.set(line, (this.pinned.get(line) ?? 0) + 1)
    try {
      return await work(this.agentFor(line))
    } finally {
      const n = (this.pinned.get(line) ?? 1) - 1
      if (n) this.pinned.set(line, n)
      else {
        this.pinned.delete(line)
        this.prune()
      }
    }
  }

  /** The command line of a target that must be an agent (Test, login, Load models). */
  private agentLineOf(t?: AiTarget): string {
    const target = t ? this.target(t) : null
    const line = target ? targetCommandLine(target) : this.commandLine()
    if (target?.provider === 'anthropic') throw new AiError('The Anthropic API is not an agent.', 'ai-unsupported')
    if (!line) throw new AiError('Set the agent command in Settings → AI.', 'ai-setup')
    return line
  }

  /** Start the agent and report who it is (Settings → AI → Test, and logins). The user clicked, so this may spawn. */
  async agentInfo(t?: AiTarget): Promise<AgentInfo> {
    return this.withAgent(this.agentLineOf(t), (agent) => agent.info())
  }

  async authenticate(methodId: string, t?: AiTarget): Promise<void> {
    await this.withAgent(this.agentLineOf(t), (agent) => agent.authenticate(methodId))
  }

  /**
   * The models a target can use. Nothing is started: an agent's come from its last session
   * (settings aiAgentModels); the API's from GET /v1/models, when there is a key.
   */
  async models(t: AiTarget): Promise<AiModelList> {
    const s = this.deps.settings()
    const target = this.target(t) ?? t
    if (target.provider === 'anthropic') {
      // The API's default is the model setting, whatever the list was saved with.
      const saved = s.aiApiModels
      if (saved) return { ...saved, defaultModel: s.anthropicModel }
      return { models: [], defaultModel: s.anthropicModel, known: false, ...(this.deps.apiKey.get() ? {} : { error: 'Add an Anthropic API key in Settings → AI.' }) }
    }
    const cached = s.aiAgentModels[targetKey(target)]
    return cached ?? { models: [], known: false }
  }

  /** One load per target key at a time: a second caller (another window) waits for the first. */
  private loading = new Map<string, Promise<AiModelList>>()

  /**
   * "Load models" / "Refresh models": the user asked, so this may start the agent (open a session,
   * which lists them, close it; no content is sent) or call GET /v1/models. The result is saved
   * (for an agent, by the session's own report) and returned as `models` would.
   */
  loadModels(t: AiTarget): Promise<AiModelList> {
    const target = this.target(t) ?? t
    const key = targetKey(target)
    let run = this.loading.get(key)
    if (!run) {
      run = this.loadNow(target).finally(() => this.loading.delete(key))
      this.loading.set(key, run)
    }
    return run
  }

  private async loadNow(target: AiTarget): Promise<AiModelList> {
    if (target.provider === 'anthropic') {
      const apiKey = this.deps.apiKey.get()
      if (!apiKey) return this.models(target)
      try {
        const models = await anthropicModels({ apiKey, baseURL: this.deps.anthropicBaseURL, fetch: this.deps.fetch })
        this.deps.setSettings({ aiApiModels: { models, known: true, at: Date.now() } })
      } catch (e) {
        // A failed refresh keeps the list there was.
        return { ...(await this.models(target)), error: (e as Error).message }
      }
      return this.models(target)
    }
    await this.withAgent(this.agentLineOf(target), async (agent) => {
      const sessionId = await agent.openSession(tmpdir())
      agent.closeSession(sessionId)
    })
    return this.models(target)
  }

  /** Keep what a new session said about models, for pickers (written only when it changed). */
  private rememberModels(line: string, m: SessionModels | null): void {
    const key = `agent:${line}`
    const list: AiModelList = m ? { models: m.options, defaultModel: m.current, known: true } : { models: [], known: true, fixed: true }
    const all = this.deps.settings().aiAgentModels
    const old = all[key]
    if (old && JSON.stringify({ ...old, at: 0 }) === JSON.stringify({ ...list, at: 0 })) return
    this.deps.setSettings({ aiAgentModels: { ...all, [key]: { ...list, at: Date.now() } } })
  }

  /** Off, not set up, or not agreed to: nothing may be sent. Returns the target with its blanks filled. */
  private ready(t?: AiTarget | null): AiTarget {
    const st = this.status(t ?? undefined)
    if (st.provider === 'off') throw new AiError('AI features are off. Turn them on in Settings → AI.', 'ai-off')
    if (!st.ready) {
      throw new AiError(st.provider === 'anthropic' ? 'Add an Anthropic API key in Settings → AI.' : 'Set the agent command in Settings → AI.', 'ai-setup')
    }
    if (!st.consented) throw new AiError(`You have not agreed to send content to ${st.label} yet.`, 'ai-consent')
    return this.target(t)!
  }

  /**
   * The words for prompts: `override` (what the area's Prompt panel shows) for the request's own
   * kind, else the area's saved edit, Settings → AI's, or the built-in ones. The answer format is
   * not in PromptText at all, so no edit can reach it.
   */
  private words(kind?: PromptKind, override?: PromptText): PromptContext['words'] {
    return (k) => (k === kind && override ? override : effectivePrompt(k, this.deps.settings()))
  }

  /** The words a conversation opens with: what its send brought (the panel's, unsaved too), else the saved ones. */
  private openingWords(rec: ThreadRec): PromptContext['words'] {
    return this.words(openingPromptKind(rec.thread.anchor), rec.prompt)
  }

  /**
   * What a task would send, without sending anything (the Prompt panel). The same builder as a
   * real request, so the panel cannot drift from what goes out; only the review's linters are
   * left out (they run programs, which waits for the real request).
   */
  async preview(repoId: string, task: AiTask, prompt?: PromptText): Promise<PromptPreview> {
    const repo = task.kind === 'explain-error' && !repoId ? null : this.deps.repo(repoId)
    const built = await buildPrompt(repo, task, {
      words: this.words(task.kind, prompt),
      learnings: repo ? this.deps.settings().reviewLearnings[repo.path] : undefined,
    })
    return built.parts
  }

  /**
   * A one-shot feature request (commit message, review, walkthrough, …): a thread with the
   * feature's anchor whose first message is the feature's prompt. Without `keepThread` it is
   * closed as soon as the answer is in (open, send, close); with it, the view that shows the
   * result keeps chatting in the same session (AiResult.threadId).
   */
  async run(requestId: string, repoId: string, task: AiTask, opts: AiRunOptions = {}): Promise<AiResult> {
    const target = this.ready(opts.target)
    // Explaining an error needs no repository (it may have happened with none open).
    const repo = task.kind === 'explain-error' && !repoId ? null : this.deps.repo(repoId)
    const settings = this.deps.settings()
    const built = await buildPrompt(repo, task, {
      words: this.words(task.kind, opts.prompt),
      learnings: repo ? settings.reviewLearnings[repo.path] : undefined,
      lint: repo ? (paths, texts, lines) => lintForReview(repo.path, this.deps.settings(), paths, texts, lines) : undefined,
    })
    // A re-review where nothing changed: the last review stands, no need to ask anyone.
    if (task.kind === 'review' && built.review?.skipModel) return { text: '', review: toReview(task, built, '{"summary": "", "findings": []}') }
    if (target.provider === 'anthropic' && task.kind === 'resolve-conflict') {
      throw new AiError('Resolving a conflict needs an agent (it edits the file). The API key mode only writes text.', 'ai-unsupported')
    }
    guardSecrets(built, opts.redact === true)
    const finish = (text: string) => (task.kind === 'commit-message' ? cleanCommitMessage(text) : text.trim())
    // A recompose answer becomes a proposal for the review dialog (nothing changes until Apply).
    const result = (text: string, extra: Partial<AiResult> = {}): AiResult =>
      task.kind === 'recompose' ? { text: '', recompose: toProposal(task.hashes, built, text) }
        : task.kind === 'review' ? { text: '', review: toReview(task, built, text) }
        : task.kind === 'fix-finding' ? toFix(built, text, extra.proposal)
        : task.kind === 'walkthrough' ? { text: '', walkthrough: toWalkthrough(built, text) }
        : task.kind === 'assess-impact' ? { text: '', impact: toAssessment(built, text) }
        // No answer at all still gives a verdict per check: inconclusive, which never passes.
        : task.kind === 'push-checks' ? { text: '', pushChecks: verifyPushChecks(extractJson(text), task.checks, built.pushChecks!.lines) }
        : { text: finish(text), ...extra }

    const keep = opts.keepThread === true && !!repo
    const rec = await this.newRec(repoId, repo, anchorOf(task), keep)
    rec.built = built
    rec.task = task
    rec.system = built.system
    // Not held yet: the view holds it when it shows the chat. Until then the idle grace runs
    // from the end of this turn, so a thread nobody opens does not keep a session forever.
    // The artifact protocol only for a conversation that goes on; a one-shot prompt stays as it was.
    const protocol = keep ? `\n\n${artifactProtocol(rec.thread.anchor, true)}` : ''
    let proposal: AiResult['proposal']
    const legacy: Partial<PromptHooks> = {
      onText: (text) => this.deps.emit({ type: 'ai-text', requestId, text }),
      writable: built.writable,
      onWrite: (_path, content) => {
        if (task.kind === 'resolve-conflict') proposal = { path: task.path, content }
        if (task.kind === 'fix-finding') proposal = { path: task.finding.path, content }
      },
    }
    try {
      const out = await this.outgoing(rec, target, built.prompt + protocol, `${built.system}\n\n${built.prompt}${protocol}`)
      const res = await this.turn(rec, requestId, out, { text: featureLabel(task, built), feature: featureLabel(task, built) }, legacy)
      if (res.stopReason === 'cancelled') throw new AiError('Stopped.', 'ai-cancelled')
      return { ...result(res.text, { proposal }), ...(keep ? { threadId: rec.thread.id } : {}) }
    } finally {
      // Kept, but it failed before its first turn (a model the agent does not offer, a refusal):
      // the caller got no threadId and can never close it, so it ends here like a one-shot.
      if (!keep || !rec.thread.turns.length) this.dispose(rec)
      else this.persist(rec)
    }
  }

  // ------------------------------------------------------------------ threads

  /**
   * Open a thread for a view: a new one about `anchor`, or (`resume`) one this repository already
   * has, from memory or from disk. Nothing is sent and no agent starts until the first message.
   */
  async openThread(repoId: string, anchor: ThreadAnchor, resume?: string): Promise<AiThread> {
    const repo = this.deps.repo(repoId)
    const live = resume ? this.threads.get(resume) : undefined
    if (live) {
      this.hold(live)
      return live.thread
    }
    const saved = resume ? this.saved(repo.path).find((t) => t.id === resume) : undefined
    const rec = await this.newRec(repoId, repo, saved?.anchor ?? anchor, true, saved)
    this.hold(rec)
    return rec.thread
  }

  /**
   * Send a message in a thread. Resolves (with the request id) once the turn has started; the
   * reply streams as ai-update events. Everything that can refuse (setup, consent, a login, a
   * secret in the text) refuses here, before the turn begins.
   */
  async sendThread(threadId: string, text: string, opts: AiRunOptions = {}): Promise<string> {
    const rec = this.threads.get(threadId)
    // The area's pick, or else whoever the thread was last with, or else the default.
    const target = this.ready(opts.target ?? rec?.thread.target)
    if (!rec) throw new AiError('This conversation is closed. Open it again.', 'ai-thread-gone')
    if (opts.prompt) rec.prompt = opts.prompt
    if (rec.active || rec.starting) throw new AiError('The AI is still answering. Wait for it, or stop it.', 'ai-busy')
    const message = text.trim()
    if (!message) throw new AiError('Write a message first.', 'ai-empty')
    // Busy from here: a second send while the session opens would race this one.
    rec.starting = true
    let out: Outgoing
    try {
      out = await this.outgoing(rec, target, message, undefined, opts.redact === true)
    } finally {
      rec.starting = false
    }
    const requestId = randomUUID()
    // The thread shows what was sent: redacted, if the user chose that.
    const shown = opts.redact ? redactSecrets(message).text : message
    void this.turn(rec, requestId, out, { text: shown }).catch(() => {})
    return requestId
  }

  threadAnchor(threadId: string): ThreadAnchor | undefined {
    return this.threads.get(threadId)?.thread.anchor
  }

  threadRepo(threadId: string): string | undefined {
    return this.threads.get(threadId)?.repoId
  }

  cancelThread(threadId: string): void {
    this.threads.get(threadId)?.active?.abort.abort()
  }

  /** The view closed: the session stays for the idle grace, then closes. The thread stays saved. */
  closeThread(threadId: string): void {
    const rec = this.threads.get(threadId)
    if (!rec) return
    rec.open = false
    this.release(rec)
  }

  /** Saved threads of a repository, most recently used first. */
  listThreads(repoId: string): AiThread[] {
    return this.saved(this.deps.repo(repoId).path).map((t) => ({ ...t, repoId }))
  }

  deleteThread(repoId: string, threadId: string): void {
    const rec = this.threads.get(threadId)
    if (rec) this.dispose(rec)
    const path = this.deps.repo(repoId).path
    const all = this.deps.settings().aiThreads
    this.deps.setSettings({ aiThreads: { ...all, [path]: (all[path] ?? []).filter((t) => t.id !== threadId) } })
  }

  /** Save one thread as it is now (the Ask methods of older callers write through this). */
  saveThread(repoId: string, thread: AiThread): void {
    const path = this.deps.repo(repoId).path
    const all = this.deps.settings().aiThreads
    const list = [compact(thread), ...(all[path] ?? []).filter((t) => t.id !== thread.id)].slice(0, MAX_THREADS)
    this.deps.setSettings({ aiThreads: { ...all, [path]: list } })
  }

  /** The repository closed: its sessions end now (the threads stay saved). */
  closeRepo(repoId: string): void {
    for (const rec of [...this.threads.values()]) if (rec.repoId === repoId) this.dispose(rec)
  }

  /**
   * Check an artifact a conversation sent (a ```json:<kind> or ```mermaid block) with the same verifier as the
   * feature's first answer, against what the feature saw. Nothing is applied here: the renderer
   * shows the result and the user decides.
   */
  async checkArtifact(threadId: string, kind: ArtifactKind, json: string): Promise<AiArtifactResult> {
    const rec = this.threads.get(threadId)
    if (!rec) return { kind: 'problem', message: 'This conversation is closed.' }
    if (!ANCHOR_ARTIFACTS[rec.thread.anchor.kind].includes(kind)) return { kind: 'problem', message: `This conversation cannot apply a ${kind}.` }
    try {
      if (kind === 'commit-message') {
        const raw = extractJson(json) as { message?: unknown } | null
        const message = cleanCommitMessage(typeof raw?.message === 'string' ? raw.message : json)
        return message ? { kind, message } : { kind: 'problem', message: 'The message is empty.' }
      }
      if (kind === 'diagram') {
        // Parsing needs a DOM, so the card asks the renderer to parse it (lib/mermaid.ts).
        const mermaid = verifyMermaid(json)
        return mermaid ? { kind, mermaid } : { kind: 'problem', message: 'The diagram is empty or too long.' }
      }
      const { built, task } = await this.verification(rec)
      if (kind === 'findings' && task?.kind === 'review') {
        const review = toReview(task, built, json)
        return { kind, review: { ...review, findings: review.findings.map((f) => ({ ...f, fromChat: true })) } }
      }
      if (kind === 'plan' && task?.kind === 'recompose') return { kind, recompose: toProposal(task.hashes, built, json) }
      if (kind === 'walkthrough' && task?.kind === 'walkthrough') return { kind, walkthrough: toWalkthrough(built, json) }
      return { kind: 'problem', message: `This conversation cannot apply a ${kind}.` }
    } catch (e) {
      return { kind: 'problem', message: (e as Error).message }
    }
  }

  // ------------------------------------------------------------------ the parts

  private async newRec(repoId: string, repo: Repo | null, anchor: ThreadAnchor, keep: boolean, saved?: AiThread): Promise<ThreadRec> {
    const now = Date.now()
    const head = saved?.head ?? (repo && keep ? (await repo.runner.run(['rev-parse', '--verify', '-q', 'HEAD'], { readOnly: true }).then((r) => r.stdout.trim(), () => '')) : '')
    const thread: AiThread = saved
      ? { ...saved, repoId, turns: saved.turns.map((t) => (t.status === 'running' ? { ...t, status: 'error', error: { message: 'GitGoose closed before the answer finished.' } } : t)) }
      : { id: randomUUID(), repoId, anchor, title: '', turns: [], createdAt: now, updatedAt: now, head }
    const rec: ThreadRec = {
      thread, repoId, path: repo?.path ?? null, cwd: repo?.path ?? tmpdir(), keep, sessionId: null, agentLine: null, target: saved?.target ?? null, primed: false,
      // A thread from disk is told its history again from its transcript, when it needs a session.
      history: saved ? null : [], systemApart: false, system: '', built: null, task: null, active: null, starting: false, open: false, idle: null,
    }
    this.threads.set(thread.id, rec)
    return rec
  }

  /**
   * Work out what one turn sends. `message` is the user's text; `opening` is a feature's own
   * first message (otherwise a fresh conversation opens with the anchor's context). An agent
   * session that is still there gets just the message; one the agent can load is loaded; a new
   * session is told the conversation so far. The API keeps no session, so it gets everything.
   */
  private async outgoing(rec: ThreadRec, target: AiTarget, message: string, opening?: string, redact = false): Promise<Outgoing> {
    this.moveTo(rec, target)
    const anthropic = target.provider === 'anthropic'
    const history = await this.historyOf(rec)
    const first = async (): Promise<string> => opening ?? await this.opening(rec, message)
    if (anthropic) {
      // The API takes the system prompt on its own: a feature's opening is its message as given.
      const logical = history.length || opening !== undefined ? message : await first()
      // Everything that leaves is checked, every turn: the system prompt (an Ask's, set by
      // opening(), or the chat's), the conversation so far, and the new message.
      const guarded = guardApiTurn(rec.system || this.openingWords(rec)!('chat')!.system, history, logical, redact)
      rec.system = guarded.system
      const text = guarded.text
      const messages = [...guarded.history.flatMap((h) => [{ role: 'user' as const, content: h.user }, { role: 'assistant' as const, content: h.agent }]), { role: 'user' as const, content: text }]
      // This turn opens the conversation, without the system prompt in its text.
      if (!history.length) rec.systemApart = true
      return { text, logical: text, messages }
    }
    const line = targetCommandLine(target)
    // Set before anything awaits, so pruning sees this agent is in use.
    rec.agentLine = line
    const agent = this.agentFor(line)
    if (rec.sessionId && !agent.hasSession(rec.sessionId)) {
      // The agent restarted. If it can load sessions, the conversation carries on where it was.
      const old = rec.sessionId
      rec.sessionId = null
      rec.primed = false
      if (history.length && (await agent.canLoad())) {
        try {
          await agent.loadSession(old, rec.cwd)
          rec.sessionId = old
          rec.primed = true
        } catch {
          // Not there any more (or never was in this agent): a new session, told the story so far.
        }
      }
    }
    if (!rec.sessionId) {
      rec.sessionId = await agent.openSession(rec.cwd)
      rec.primed = false
    }
    await this.applyModel(agent, rec.sessionId, target)
    if (rec.primed) {
      const text = guardTurn(message, redact)
      return { text, logical: text }
    }
    if (!history.length) {
      // An agent's opening carries the system prompt in its text.
      rec.systemApart = false
      const text = guardTurn(await first(), redact)
      return { text, logical: text }
    }
    // A history that began with the API lacks its system prompt: it goes first, in every agent session told it.
    const told = rec.systemApart && rec.system && history[0] ? [{ ...history[0], user: `${rec.system}\n\n${history[0].user}` }, ...history.slice(1)] : history
    return { text: guardTurn(replayMessage(told, message), redact), logical: guardTurn(message, redact) }
  }

  /**
   * The turn is for `target`. Another process (another agent, or the API) cannot use this
   * session: it is closed, and the new one is told the conversation so far like after a restart
   * without session/load. Only a model change keeps the session (applyModel switches it).
   */
  private moveTo(rec: ThreadRec, target: AiTarget): void {
    const moved = !rec.target || targetKey(rec.target) !== targetKey(target) || (rec.target.model ?? '') !== (target.model ?? '')
    if (rec.target && targetKey(rec.target) !== targetKey(target)) this.leaveSession(rec)
    rec.target = target
    // The thread records who it is with now (a view's picker starts there when it is reopened).
    if (moved) this.update(rec, '', { kind: 'meta', target })
  }

  /**
   * Put the session on the target's model. A model the user picked must exist, or the turn is
   * refused before it starts (ai-model). "Default" after an earlier pick goes back to the
   * agent's own default, when we know what that was.
   */
  private async applyModel(agent: AcpAgent, sessionId: string, target: AiTarget): Promise<void> {
    const offered = agent.models(sessionId)
    if (!target.model) {
      const fallback = this.deps.settings().aiAgentModels[targetKey(target)]?.defaultModel
      if (offered && fallback && offered.current !== fallback && offered.options.some((o) => o.id === fallback)) await agent.setModel(sessionId, fallback)
      return
    }
    try {
      await agent.setModel(sessionId, target.model)
    } catch (e) {
      throw new AiError((e as Error).message, 'ai-model')
    }
  }

  private leaveSession(rec: ThreadRec): void {
    const left = rec.sessionId && rec.agentLine
    if (left) this.agents.get(rec.agentLine!)?.closeSession(rec.sessionId!)
    rec.sessionId = null
    rec.agentLine = null
    rec.primed = false
    // That may have been the last thing keeping its agent: stop it if nothing else needs it.
    if (left) this.prune()
  }

  /** "Codex · GPT-5": the session's model as the agent reports it, or the API's. */
  private byLabel(rec: ThreadRec): string {
    const target = rec.target
    if (!target) return ''
    if (target.provider === 'anthropic') return targetLabel(target)
    const m = rec.sessionId && rec.agentLine ? this.agents.get(rec.agentLine)?.models(rec.sessionId) : null
    return targetLabel({ ...target, model: m?.current ?? target.model }, m?.options)
  }

  /** The first message of a conversation that starts with the user's words: the anchor's context, the protocol, the message. */
  private async opening(rec: ThreadRec, message: string): Promise<string> {
    const repo = this.deps.repo(rec.repoId)
    const anchor = rec.thread.anchor
    // The API takes the system prompt on its own; an agent gets it at the top of the text.
    const api = rec.target?.provider === 'anthropic'
    if (anchor.kind === 'ask') {
      // Ask's own prompt, with the question in it: the lines, their function, definitions, history.
      const built = await buildPrompt(repo, { kind: 'ask', rev: anchor.rev === 'worktree' ? null : anchor.rev, path: anchor.path, startLine: anchor.lines[0], endLine: anchor.lines[1], question: message, earlier: [] }, { words: this.openingWords(rec) })
      rec.system = built.system
      return `${api ? '' : `${built.system}\n\n`}${built.prompt}\n\n${artifactProtocol(anchor, false)}`
    }
    return openingMessage(await anchorContext(repo, anchor, { words: this.openingWords(rec) }, api), anchor, message)
  }

  /** The conversation as exchanged. A thread from disk rebuilds it: its transcript, with the anchor's context in front. */
  private async historyOf(rec: ThreadRec): Promise<{ user: string; agent: string }[]> {
    if (rec.history) return rec.history
    const past = transcript(rec.thread)
    if (past.length) {
      const anchor = rec.thread.anchor
      // As the opening was: an agent's first message carries the system prompt, the API's does not.
      const context = anchor.kind === 'task' ? '' : await anchorContext(this.deps.repo(rec.repoId), anchor, { words: this.openingWords(rec) }, rec.target?.provider === 'anthropic').catch(() => '')
      past[0] = { ...past[0]!, user: [context, artifactProtocol(anchor, false), past[0]!.user].filter(Boolean).join('\n\n') }
      // Rebuilt the way the API was told it, without the system prompt.
      rec.systemApart = rec.target?.provider === 'anthropic'
      // And that system prompt is not saved with the thread: give the conversation its own again
      // (an Ask's, a review's), not the chat's that the API path would otherwise fall back to.
      const kind = systemPromptKind(anchor)
      if (!rec.system && kind) rec.system = this.openingWords(rec)!(kind)!.system
    }
    rec.history = past
    return past
  }

  /**
   * Run one turn: the user's message goes in as a 'turn' event, the agent's reply streams in as
   * text, thought, tool, plan and permission events, and 'done' or 'error' ends it. Every event
   * goes through reduceThread here and, for kept threads, to the renderer.
   * `legacy` hooks are the one-shot path's (streamed text, the permission modal, file writes).
   */
  private async turn(rec: ThreadRec, requestId: string, out: Outgoing, user: { text: string; feature?: string }, legacy?: Partial<PromptHooks>): Promise<{ text: string; stopReason: string }> {
    const abort = new AbortController()
    rec.active = { requestId, abort }
    this.requests.set(requestId, { cancel: () => abort.abort() })
    if (rec.idle) clearTimeout(rec.idle)
    rec.idle = null
    const emit = (update: AiUpdate) => this.update(rec, requestId, update)
    const by = this.byLabel(rec)
    const sent = sentText(rec, out, user.text)
    emit({ kind: 'turn', text: user.text, at: Date.now(), ...(user.feature ? { feature: user.feature } : {}), ...(by ? { by } : {}), ...(sent ? { sent } : {}) })
    // Saved from the start, so a conversation is in the AI panel's history while its answer streams.
    this.persist(rec)
    try {
      let text: string
      let stopReason: string
      if (out.messages) {
        try {
          text = await anthropicChat({
            apiKey: this.deps.apiKey.get()!,
            model: rec.target?.model || this.deps.settings().anthropicModel || 'claude-opus-5-5',
            maxTokens: this.deps.settings().anthropicMaxTokens,
            system: rec.system,
            messages: out.messages,
            baseURL: this.deps.anthropicBaseURL,
            fetch: this.deps.fetch,
            onText: (snapshot, delta) => {
              legacy?.onText?.(snapshot)
              emit({ kind: 'text', text: delta })
            },
            signal: abort.signal,
          })
          stopReason = 'end_turn'
        } catch (e) {
          if (!abort.signal.aborted) throw e
          text = ''
          stopReason = 'cancelled'
        }
      } else {
        const res = await this.agents.get(rec.agentLine!)!.prompt(rec.sessionId!, out.text, {
          ...legacy,
          onUpdate: (u) => emit(u),
          onPermission: (ask) => this.askPermission(rec, requestId, ask, !!legacy),
        }, abort.signal)
        rec.primed = true
        text = res.text
        stopReason = res.stopReason
      }
      emit({ kind: 'done', stopReason })
      // A stopped turn is not part of the conversation a new session would be told about.
      if (stopReason !== 'cancelled') rec.history?.push({ user: out.logical, agent: text })
      return { text, stopReason }
    } catch (e) {
      const err = e as { message?: string; code?: unknown }
      emit({ kind: 'error', message: err.message ?? String(e), ...(typeof err.code === 'string' ? { code: err.code } : {}) })
      throw e
    } finally {
      rec.active = null
      this.requests.delete(requestId)
      // Unanswered questions from this turn are moot now.
      for (const [id, p] of this.permissions) {
        if (p.requestId !== requestId) continue
        this.permissions.delete(id)
        p.resolve(null)
        if (!p.thread) this.deps.emit({ type: 'ai-permission-closed', permissionId: id })
      }
      // Saved before the renderer can hear 'done' and read it back (the Ask list does).
      this.persist(rec)
      if (!rec.open && rec.keep) this.release(rec)
    }
  }

  private update(rec: ThreadRec, requestId: string, update: AiUpdate): void {
    rec.thread = reduceThread(rec.thread, requestId, update)
    if (rec.keep) this.deps.emit({ type: 'ai-update', threadId: rec.thread.id, requestId, update })
  }

  /**
   * A tool call needs the user. One-shot requests ask in the modal (their views show no
   * thread); a thread asks inline, as a card in the turn.
   */
  private askPermission(rec: ThreadRec, requestId: string, ask: PermissionAsk, modal: boolean): Promise<string | null> {
    const permissionId = this.nextPermission++
    return new Promise((resolve) => {
      if (modal || !rec.keep) {
        this.permissions.set(permissionId, { requestId, resolve })
        const request: AiPermissionRequest = { permissionId, requestId, title: ask.title, kind: ask.kind, paths: ask.paths, options: ask.options }
        this.deps.emit({ type: 'ai-permission', request })
        return
      }
      this.permissions.set(permissionId, { requestId, resolve, thread: { rec, ask } })
      const card: AiPermissionAsk = { permissionId, title: ask.title, kind: ask.kind, paths: ask.paths, options: ask.options, ...(ask.rawInput ? { rawInput: ask.rawInput } : {}) }
      this.update(rec, requestId, { kind: 'permission', permission: card })
    })
  }

  /**
   * The user answered a permission card: Deny, Allow once, or Allow for this session (GitGoose
   * then answers the same question in this session itself; see AcpAgent.rememberAllow).
   */
  answerPermission(permissionId: number, answer: Exclude<PermissionAnswer, 'expired'>): void {
    const p = this.permissions.get(permissionId)
    if (!p?.thread) return
    this.permissions.delete(permissionId)
    const { rec, ask } = p.thread
    const pick = (...kinds: string[]) => kinds.map((k) => ask.options.find((o) => o.kind === k)).find(Boolean)?.optionId ?? null
    const optionId = answer === 'deny' ? pick('reject_once', 'reject_always') : answer === 'once' ? pick('allow_once', 'allow_always') : pick('allow_always', 'allow_once')
    if (answer === 'session' && rec.sessionId && optionId && rec.agentLine) this.agents.get(rec.agentLine)?.rememberAllow(rec.sessionId, ask)
    this.update(rec, p.requestId, { kind: 'permission-answered', permissionId, answer })
    p.resolve(optionId)
  }

  /** What the feature saw: from the request that started the thread, or worked out again (no model call). */
  private async verification(rec: ThreadRec): Promise<{ built: BuiltPrompt; task: AiTask | null }> {
    if (rec.built) return { built: rec.built, task: rec.task }
    const task = anchorTask(rec.thread.anchor, this.deps.settings().reviewProfile as ReviewProfile)
    if (!task) throw new AiError('Nothing to check this against.', 'ai-bad-answer')
    const repo = this.deps.repo(rec.repoId)
    rec.built = await buildPrompt(repo, task, { learnings: this.deps.settings().reviewLearnings[repo.path] })
    rec.task = task
    return { built: rec.built, task }
  }

  private saved(path: string): AiThread[] {
    return this.deps.settings().aiThreads[path] ?? []
  }

  /** Save a kept thread that has something in it. */
  private persist(rec: ThreadRec): void {
    if (!rec.keep || !rec.thread.turns.length) return
    try {
      this.saveThread(rec.repoId, rec.thread)
    } catch {
      // The repository closed meanwhile: nothing to save it under.
    }
  }

  /** A view holds the thread: no idle timer. */
  private hold(rec: ThreadRec): void {
    rec.open = true
    if (rec.idle) clearTimeout(rec.idle)
    rec.idle = null
  }

  /** No view holds it: after the idle grace, end the session and forget it (it stays saved). */
  private release(rec: ThreadRec): void {
    if (rec.idle || rec.active) return
    rec.idle = setTimeout(() => {
      rec.idle = null
      if (!rec.open && !rec.active) this.dispose(rec)
    }, this.deps.threadIdleMs ?? THREAD_IDLE_MS)
    rec.idle.unref?.()
  }

  private dispose(rec: ThreadRec): void {
    rec.active?.abort.abort()
    if (rec.idle) clearTimeout(rec.idle)
    rec.idle = null
    this.leaveSession(rec)
    this.threads.delete(rec.thread.id)
  }

  /** Threads that hold a session now (tests). */
  liveThreads(): string[] {
    return [...this.threads.values()].filter((r) => r.sessionId && r.agentLine && this.agents.get(r.agentLine)?.hasSession(r.sessionId)).map((r) => r.thread.id)
  }

  cancel(requestId: string): void {
    this.requests.get(requestId)?.cancel()
  }

  respondPermission(permissionId: number, optionId: string | null): void {
    const p = this.permissions.get(permissionId)
    this.permissions.delete(permissionId)
    p?.resolve(optionId)
  }

  stop(): void {
    for (const rec of [...this.threads.values()]) this.dispose(rec)
    for (const agent of this.agents.values()) agent.stop()
    this.agents.clear()
  }
}

/**
 * What a turn really sent, for its "Sent" view; undefined when it is just what the user typed.
 * The API's system prompt is separate from the messages, so it is shown first, on the first turn.
 */
function sentText(rec: ThreadRec, out: Outgoing, shown: string): string | undefined {
  const api = !!out.messages
  const first = api && out.messages!.length === 1
  const text = first && rec.system ? `[System prompt]\n${rec.system}\n\n[Message]\n${out.text}` : out.text
  return text.trim() === shown.trim() ? undefined : text
}

/**
 * A thread as it is saved: what the conversation needs to be read and continued, not every
 * byte that streamed. A feature's own answer (raw JSON the view already turned into its
 * result) keeps 8k characters, other text 40k, tool output what acp.ts kept (20k a piece).
 */
export function compact(thread: AiThread): AiThread {
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters not kept)` : text)
  return {
    ...thread,
    repoId: '',
    turns: thread.turns.slice(-200).map((t) => ({
      ...t,
      blocks: t.blocks.map((b) => (b.type === 'text' || b.type === 'thought' ? { ...b, text: cut(b.text, t.feature ? 8_000 : 40_000) } : b)),
      // What was sent can be a whole diff: enough to read what was asked, not a second copy of the repository.
      ...(t.sent ? { sent: cut(t.sent, 20_000) } : {}),
    })),
  }
}

/** The model's view of which call sites are at risk; only ids we sent count. */
function toAssessment(built: BuiltPrompt, text: string): NonNullable<AiResult['impact']> {
  const impact = built.impact!
  const raw = extractJson(text) as { summary?: unknown; risks?: unknown } | null
  if (!raw) throw new AiError('The AI did not answer with an assessment. Try again.', 'ai-bad-answer')
  const ids = new Set(impact.callers.map((c) => c.id))
  const all = Array.isArray(raw.risks) ? raw.risks : []
  const risks = all.flatMap((r) => {
    const x = (r && typeof r === 'object' ? r : {}) as { id?: unknown; why?: unknown }
    return typeof x.id === 'string' && ids.has(x.id) && typeof x.why === 'string' && x.why.trim() ? [{ id: x.id, why: x.why.trim().slice(0, 600) }] : []
  })
  return { ...impact, assessment: { summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 1000) : '', risks, dropped: all.length - risks.length } }
}

/** The model's walkthrough, checked against the change (see verifyWalkthrough). */
function toWalkthrough(built: BuiltPrompt, text: string): NonNullable<AiResult['walkthrough']> {
  const w = built.walkthrough!
  const raw = extractJson(text)
  if (!raw) throw new AiError('The AI did not answer with a walkthrough. Try again.', 'ai-bad-answer')
  const paths = [...new Set(w.hunks.map((h) => h.path))]
  const v = verifyWalkthrough(raw, paths, w.hunks)
  return { ...w, ...v }
}

/**
 * A proposed fix: the file the agent wrote, or (API mode, or an agent that answered in text) the
 * last fenced block of its reply. The reply's prose becomes the note. No proposal, no fix.
 */
function toFix(built: BuiltPrompt, text: string, written?: { path: string; content: string }): AiResult {
  const fences = [...text.matchAll(/```[\w-]*\n([\s\S]*?)\n```/g)]
  const content = written?.content ?? fences.at(-1)?.[1]
  if (content === undefined) throw new AiError('The AI did not propose a fixed file. Try again.', 'ai-bad-answer')
  const note = text.replace(/```[\w-]*\n[\s\S]*?\n```/g, '').trim()
  // A block that lost the file's final newline would show as a change on the last line.
  const fixed = !written && built.fix!.before.endsWith('\n') && !content.endsWith('\n') ? `${content}\n` : content
  return { text: note, proposal: { path: built.fix!.path, content: fixed } }
}

/** The model's review, checked against the change before anything is shown (see verifyFindings). */
function toReview(task: Extract<AiTask, { kind: 'review' }>, built: BuiltPrompt, text: string): NonNullable<AiResult['review']> {
  const r = built.review!
  const raw = extractJson(text)
  if (!raw) throw new AiError('The AI did not answer with findings. Try again.', 'ai-bad-answer')
  const v = verifyFindings(raw, r.lines, (p) => r.texts.get(p) ?? null, task.profile)
  // Tool findings first. The model saw the secrets redacted and may flag the marker itself: a
  // security finding of its own on a line the scan already reported says nothing new.
  const scanned = r.local.filter((f) => f.source === 'scan')
  const model = v.findings.filter((f) => !(f.type === 'security' && scanned.some((s) => s.path === f.path && f.startLine <= s.endLine && f.endLine >= s.startLine)))
  const fresh = [...r.local, ...model]
  const inc = r.incremental
  // On a re-review, new findings join the ones carried over (a new one on the same spot wins).
  const findings = (inc
    ? [...fresh.map((f) => ({ ...f, status: 'new' as const })), ...inc.open.filter((o) => !fresh.some((f) => f.path === o.path && f.startLine === o.startLine && f.title === o.title))]
    : fresh
  ).map((f, i) => ({ ...f, id: `F${i + 1}` }))
  const summary = v.summary || (inc && !inc.sent ? 'Nothing changed in the reviewed code since the last review.' : '')
  return {
    scope: task.scope, profile: task.profile, label: r.label, head: r.head, base: r.base, summary, findings, dropped: v.dropped, skipped: r.skipped, context: r.context,
    hunkKeys: r.hunkKeys, contextKey: r.contextKey,
    incremental: inc ? { sent: inc.sent, unchanged: inc.unchanged, addressed: inc.addressed.map((f) => ({ title: f.title, path: f.path })) } : undefined,
  }
}

const PREVIEW_LINES = 200
const PREVIEW_CHARS = 20_000

export function previewOf(body: string): string {
  const lines = body.split('\n')
  let out = lines.slice(0, PREVIEW_LINES).join('\n')
  if (out.length > PREVIEW_CHARS) out = out.slice(0, out.lastIndexOf('\n', PREVIEW_CHARS))
  const shown = out.split('\n').length
  return shown < lines.length ? `${out}\n… ${lines.length - shown} more lines` : out
}

function toProposal(hashes: string[], built: BuiltPrompt, text: string): NonNullable<AiResult['recompose']> {
  const info = built.recompose!
  const raw = extractJson(text)
  if (!raw) throw new AiError('The AI did not answer with a plan. Try again.', 'ai-bad-answer')
  const { commits, unplaced } = repairPlan(info.units, raw)
  return {
    hashes,
    branch: info.branch,
    units: info.units.map((u) => ({
      id: u.id, path: u.path, added: u.added, removed: u.removed, binary: u.binary,
      // Enough to read the change in the review dialog; a huge hunk is cut, and says so.
      preview: previewOf(u.body),
    })),
    commits,
    unplaced,
    onRemote: info.onRemote,
  }
}
