import type { Repo } from '@gitgoose/git'
import {
  agentCommandLine, agentLabel, commandArgv,
  type AgentInfo, type AgentPreset, type AiPermissionRequest, type AiResult, type AiRunOptions, type AiStatus, type AiTask, type GitGooseEvent, type Settings,
} from '@gitgoose/shared'
import { tmpdir } from 'node:os'
import { AcpAgent } from './acp'
import { anthropicComplete } from './anthropic'
import type { SecretFile } from './keyStore'
import { extractJson, locateSecret, redactSecrets, repairPlan, scanSecrets, verifyFindings, verifyPushChecks, verifyWalkthrough } from '@gitgoose/git'
import { lintForReview } from './linters'
import { buildPrompt, cleanCommitMessage, type BuiltPrompt } from './prompts'

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
}

/**
 * The last check before anything leaves: scan exactly the text that would be sent. With hits,
 * either stop and say what was found (masked), or, when the user chose to, replace each one with
 * a "[REDACTED kind]" marker. Scanning the final text rather than the inputs means no prompt
 * builder can forget to call it.
 */
export function guardSecrets(built: BuiltPrompt, redact: boolean): void {
  const outgoing = `${built.system}\n\n${built.prompt}`
  const hits = scanSecrets(outgoing)
  if (!hits.length) return
  if (redact) {
    built.system = redactSecrets(built.system).text
    built.prompt = redactSecrets(built.prompt).text
    return
  }
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

export class AiService {
  readonly agent: AcpAgent
  private requests = new Map<string, { cancel: () => void }>()
  private permissions = new Map<number, { requestId: string; resolve: (optionId: string | null) => void }>()
  private nextPermission = 1
  /** The agent command the running process was started with (restart when it changes). */
  private agentCommand = ''

  constructor(private deps: AiServiceDeps) {
    this.agent = new AcpAgent(() => {
      const argv = commandArgv(this.commandLine(), {})
      return { command: argv[0] ?? '', args: argv.slice(1) }
    })
  }

  private commandLine(): string {
    const s = this.deps.settings()
    return agentCommandLine(s.aiAgent as AgentPreset, s.aiAgentCommand)
  }

  /** What the user agreed to: a provider, and for agents the exact command. */
  private consentKey(): string {
    const s = this.deps.settings()
    if (s.aiProvider === 'agent') return `agent:${this.commandLine()}`
    if (s.aiProvider === 'anthropic') return 'anthropic'
    return ''
  }

  status(): AiStatus {
    const s = this.deps.settings()
    const key = this.consentKey()
    const hasApiKey = !!this.deps.apiKey.get()
    return {
      provider: s.aiProvider,
      label: s.aiProvider === 'anthropic' ? 'Anthropic API' : agentLabel(s.aiAgent as AgentPreset, s.aiAgentCommand),
      ready: s.aiProvider === 'agent' ? !!this.commandLine() : s.aiProvider === 'anthropic' ? hasApiKey : false,
      consented: !!key && s.aiConsent.includes(key),
      hasApiKey,
      keyInMemoryOnly: hasApiKey && !this.deps.apiKey.persisted(),
    }
  }

  consent(): AiStatus {
    const key = this.consentKey()
    const s = this.deps.settings()
    if (key && !s.aiConsent.includes(key)) this.deps.setSettings({ aiConsent: [...s.aiConsent, key] })
    return this.status()
  }

  setApiKey(key: string | null): AiStatus {
    this.deps.apiKey.set(key?.trim() || null)
    return this.status()
  }

  /** Settings changed: an agent started with an old command is stopped (the next use restarts). */
  onSettings(): void {
    if (this.agentCommand && this.agentCommand !== this.commandLine()) {
      this.agent.stop()
      this.agentCommand = ''
    }
  }

  /** Start the agent and report who it is (Settings → AI → Test). The user clicked, so this may spawn. */
  async agentInfo(): Promise<AgentInfo> {
    this.onSettings()
    this.agentCommand = this.commandLine()
    return this.agent.info()
  }

  async authenticate(methodId: string): Promise<void> {
    await this.agent.authenticate(methodId)
  }

  async run(requestId: string, repoId: string, task: AiTask, opts: AiRunOptions = {}): Promise<AiResult> {
    const st = this.status()
    if (st.provider === 'off') throw new AiError('AI features are off. Turn them on in Settings → AI.', 'ai-off')
    if (!st.ready) {
      throw new AiError(st.provider === 'anthropic' ? 'Add an Anthropic API key in Settings → AI.' : 'Set the agent command in Settings → AI.', 'ai-setup')
    }
    if (!st.consented) throw new AiError(`You have not agreed to send content to ${st.label} yet.`, 'ai-consent')
    // Explaining an error needs no repository (it may have happened with none open).
    const repo = task.kind === 'explain-error' && !repoId ? null : this.deps.repo(repoId)
    const cwd = repo?.path ?? tmpdir()
    const settings = this.deps.settings()
    const built = await buildPrompt(repo, task, {
      learnings: repo ? settings.reviewLearnings[repo.path] : undefined,
      lint: repo ? (paths, texts, lines) => lintForReview(repo.path, this.deps.settings(), paths, texts, lines) : undefined,
    })
    // A re-review where nothing changed: the last review stands, no need to ask anyone.
    if (task.kind === 'review' && built.review?.skipModel) return { text: '', review: toReview(task, built, '{"summary": "", "findings": []}') }
    guardSecrets(built, opts.redact === true)
    const emitText = (text: string) => this.deps.emit({ type: 'ai-text', requestId, text })
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

    try {
      if (st.provider === 'anthropic') {
        if (task.kind === 'resolve-conflict') {
          throw new AiError('Resolving a conflict needs an agent (it edits the file). The API key mode only writes text.', 'ai-unsupported')
        }
        const abort = new AbortController()
        this.requests.set(requestId, { cancel: () => abort.abort() })
        const text = await anthropicComplete({
          apiKey: this.deps.apiKey.get()!,
          model: this.deps.settings().anthropicModel || 'claude-opus-5-5',
          system: built.system,
          prompt: built.prompt,
          baseURL: this.deps.anthropicBaseURL,
          fetch: this.deps.fetch,
          onText: emitText,
          signal: abort.signal,
        })
        return result(text)
      }

      this.onSettings()
      this.agentCommand = this.commandLine()
      let proposal: AiResult['proposal']
      const abort = new AbortController()
      this.requests.set(requestId, { cancel: () => abort.abort() })
      const res = await this.agent.prompt(cwd, `${built.system}\n\n${built.prompt}`, {
        onText: emitText,
        writable: built.writable,
        onWrite: (_path, content) => {
          if (task.kind === 'resolve-conflict') proposal = { path: task.path, content }
          if (task.kind === 'fix-finding') proposal = { path: task.finding.path, content }
        },
        onPermission: (ask) => {
          const permissionId = this.nextPermission++
          const request: AiPermissionRequest = { permissionId, requestId, ...ask }
          return new Promise((resolve) => {
            this.permissions.set(permissionId, { requestId, resolve })
            this.deps.emit({ type: 'ai-permission', request })
          })
        },
      }, abort.signal)
      if (res.stopReason === 'cancelled') throw new AiError('Stopped.', 'ai-cancelled')
      return result(res.text, { proposal })
    } finally {
      this.requests.delete(requestId)
      // Unanswered questions from this request are moot now.
      for (const [id, p] of this.permissions) {
        if (p.requestId !== requestId) continue
        this.permissions.delete(id)
        p.resolve(null)
        this.deps.emit({ type: 'ai-permission-closed', permissionId: id })
      }
    }
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
    this.agent.stop()
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
