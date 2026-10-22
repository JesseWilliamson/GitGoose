import { AI_AUTH_REQUIRED, type AgentAuthMethod, type AiPermissionRequest, type AiResult, type AiTask, type RecomposeProposal, type ReviewScope, type ThreadAnchor } from '@gitgoose/shared'
import { create } from 'zustand'
import { dropJob, finishJob, onJobReady, parkJob, registerJob, sweepJobs } from './aiJobs'
import { api, toUiError } from './api'
import { attention, choose, reportError, toast, updateRepo, useStore } from './store'

/**
 * Renderer side of the AI features. `startAi` does the asking (set up? agreed? logged in?) and
 * then hands the task to main, which streams the reply back as 'ai-text' events.
 */

export interface AiUi {
  /** "Send this to …?" before the first request to a provider. */
  consent: { label: string; what: string; resolve: (ok: boolean) => void } | null
  /** The agent wants a login. */
  login: { agent: string; methods: AgentAuthMethod[]; repoId: string | null; resolve: (ok: boolean) => void } | null
  /** Tool calls waiting for an answer, oldest first. */
  permissions: AiPermissionRequest[]
  /** A streamed answer shown in a modal: only an error explained with no repository open (see explainFailure). */
  output: { title: string; text: string; requestId: string | null; error: string | null } | null
  /**
   * A conflict resolution the agent proposed, for review. `hidden`: the dialogs below keep their
   * state when closed (the request, or the answer, is not thrown away); the AI jobs chip or the
   * "ready" toast shows them again.
   */
  proposal: { repoId: string; path: string; content: string; note: string; hidden?: boolean } | null
  /** Fix with AI: waiting for, or showing, a proposed new version of one file. */
  fix: { repoId: string; path: string; title: string; requestId: string | null; before: string | null; after: string | null; note: string; error: string | null; hidden?: boolean } | null
  /** Recompose with AI: waiting for a plan (requestId set), failed, or under review. */
  recompose: {
    repoId: string; hashes: string[]; requestId: string | null; proposal: RecomposeProposal | null; error: string | null
    hidden?: boolean
    /** The conversation the plan came from (the chat column beside the plan). */
    threadId?: string
    /** A plan applied from the chat: the editor takes it as one undo step (see lib/artifacts.ts). */
    incoming?: { commits: RecomposeProposal['commits']; nonce: number }
  } | null
  /** A commit message applied from a chat, for the commit box of that repository to take (undoable there). */
  draft: { repoId: string; message: string; nonce: number } | null
}

export const useAi = create<AiUi>(() => ({ consent: null, login: null, permissions: [], output: null, proposal: null, recompose: null, fix: null, draft: null }))

// A dialog shown again some other way (a plan applied from a chat) counts as seen, like the views in the store.
useAi.subscribe(sweepJobs)

const textListeners = new Map<string, (text: string) => void>()
const threadListeners = new Map<string, (threadId: string) => void>()

/**
 * The first 'ai-update' of a kept request names its thread (AiResult.threadId only comes with
 * the answer): a view can show the thread while it streams. Called by lib/thread.ts.
 */
export function onAiThread(requestId: string, threadId: string): void {
  const listener = threadListeners.get(requestId)
  if (!listener) return
  threadListeners.delete(requestId)
  listener(threadId)
}

/** Called from the store's event handler. */
export function onAiEvent(e: { type: 'ai-text'; requestId: string; text: string } | { type: 'ai-permission'; request: AiPermissionRequest } | { type: 'ai-permission-closed'; permissionId: number }): void {
  if (e.type === 'ai-text') textListeners.get(e.requestId)?.(e.text)
  else if (e.type === 'ai-permission') useAi.setState((s) => ({ permissions: [...s.permissions, e.request] }))
  else useAi.setState((s) => ({ permissions: s.permissions.filter((p) => p.permissionId !== e.permissionId) }))
}

export function answerPermission(permissionId: number, optionId: string | null): void {
  useAi.setState((s) => ({ permissions: s.permissions.filter((p) => p.permissionId !== permissionId) }))
  void api.aiRespondPermission(permissionId, optionId)
}

/** What each task sends, for the consent notice. */
const WHAT: Record<AiTask['kind'], string> = {
  'commit-message': 'the staged diff and your recent commit subjects',
  'explain-commit': "the commit's message and diff",
  'explain-error': "the failed action and git's error output",
  'resolve-conflict': 'the conflicted file (the agent reads it), and it may propose an edit to that one file',
  recompose: "the selected commits' messages and their combined diff",
  review: 'the diff being reviewed, with line numbers and the names of the functions it touches',
  'assess-impact': 'the change, the names of the definitions it touches, and the lines elsewhere that use them',
  ask: 'the selected lines, the function around them, definitions of names they use, and their commit history',
  walkthrough: 'the change, cut into pieces, and the subjects of recent commits to the same files',
  'fix-finding': 'the file the finding is in, and the finding; the agent may propose a new version of that one file',
  'push-checks': "the commits you are pushing (their messages and diff) and the repository's pre-push rules",
}

function openSettings(): void {
  useStore.setState({ page: 'settings' })
}

export interface AiRun {
  requestId: string
  /** The result; null when the user cancelled or something was not set up (already reported). */
  done: Promise<AiResult | null>
}

/**
 * `before` runs once the provider is set up and agreed to, just before the request: for questions
 * that only make sense when the request will really happen (which linters a review may run).
 */
export function startAi(repoId: string | null, task: AiTask, onText?: (text: string) => void, opts: { before?: () => Promise<void>; keepThread?: boolean; onThread?: (threadId: string) => void } = {}): AiRun {
  const requestId = crypto.randomUUID()
  const done = (async (): Promise<AiResult | null> => {
    if (!(await ensureAi(WHAT[task.kind]))) return null
    await opts.before?.()
    if (onText) textListeners.set(requestId, onText)
    if (opts.onThread) threadListeners.set(requestId, opts.onThread)
    try {
      let redact = false
      for (let attempt = 0; ; attempt++) {
        try {
          const o = { ...(redact ? { redact } : {}), ...(opts.keepThread ? { keepThread: true } : {}) }
          return await api.aiRun(requestId, repoId ?? '', task, Object.keys(o).length ? o : undefined)
        } catch (e) {
          const err = e as { code?: string; message?: string }
          if (err.code === 'ai-cancelled') return null
          if (err.code === 'ai-secrets' && !redact) {
            if (!(await askToRedact(err.message ?? ''))) return null
            redact = true
            continue
          }
          if (err.code !== AI_AUTH_REQUIRED || attempt > 0) throw e
          if (!(await askLogin(repoId))) return null
        }
      }
    } finally {
      textListeners.delete(requestId)
      threadListeners.delete(requestId)
    }
  })()
  return { requestId, done }
}

/**
 * Before anything is sent: is a provider set up, and has the user agreed to send `what` to it?
 * False when they have to do something first (already reported or asked).
 */
export async function ensureAi(what: string): Promise<boolean> {
  const status = await api.aiStatus()
  if (status.provider === 'off' || !status.ready) {
    attention({
      title: status.provider === 'off' ? 'AI features are off' : `Finish setting up ${status.label}`,
      detail: 'Choose an agent or add an API key in Settings → AI.',
      actions: [{ label: 'Open settings', variant: 'primary', run: openSettings }],
    })
    return false
  }
  if (!status.consented) {
    const ok = await new Promise<boolean>((resolve) => useAi.setState({ consent: { label: status.label, what, resolve } }))
    if (!ok) return false
    await api.aiConsent()
  }
  return true
}

/** The agent needs a login: show its methods. True once the user says they have logged in. */
export async function askLogin(repoId: string | null): Promise<boolean> {
  const info = await api.aiAgentInfo()
  return new Promise<boolean>((resolve) => useAi.setState({ login: { agent: info.name, methods: info.authMethods, repoId, resolve } }))
}

/** What a conversation about each anchor sends, for the consent notice. */
export function whatFor(anchor: ThreadAnchor): string {
  switch (anchor.kind) {
    case 'review': case 'changestack': return `${WHAT.review}, and what you write`
    case 'explain': return `${WHAT['explain-commit']}, and what you write`
    case 'recompose': return `${WHAT.recompose}, and what you write`
    case 'walkthrough': return `${WHAT.walkthrough}, and what you write`
    case 'impact': return `${WHAT['assess-impact']}, and what you write`
    case 'ask': return `${WHAT.ask}, and what you write`
    case 'free': return "the repository's name and current commit, and what you write (an agent can ask to read files in the repository)"
    case 'error': return `${WHAT['explain-error']}, and what you write`
    case 'conflict': return `the conflicted file (the agent reads it), and what you write`
    case 'task': return WHAT[anchor.task]
  }
}

/**
 * The secret scan in main stopped a request. Main's message is a sentence, a blank line, then the
 * (masked) list; the list goes in the dialog's detail box. Cancel comes first so Enter is the safe
 * answer, and closing the dialog counts as Cancel.
 */
export function askToRedact(message: string): Promise<boolean> {
  const cut = message.indexOf('\n\n')
  return new Promise((resolve) => choose(
    'Possible secrets in this request',
    `${cut < 0 ? message : message.slice(0, cut)} Send it with each one replaced by "[REDACTED …]", or cancel and remove them first?`,
    [{ label: 'Cancel', run: () => resolve(false) }, { label: 'Redact and send', variant: 'primary', run: () => resolve(true) }],
    cut < 0 ? undefined : message.slice(cut + 2),
    () => resolve(false),
  ))
}

export function cancelAi(requestId: string): void {
  void api.aiCancel(requestId)
}

// ------------------------------------------------------------------ answers that wait for the user

// A job that finished while its view was not on screen: say so, with a way to it.
onJobReady((job) => toast({
  kind: 'info',
  title: job.status === 'error' ? `AI request failed: ${job.title}` : `AI answer ready: ${job.title}`,
  detail: job.error,
  // Opens even if the user has seen it meanwhile (the job is gone from the list then).
  action: {
    label: 'Open',
    run: () => {
      dropJob(job.id)
      job.open()
    },
  },
}, 10_000))

/** Bring a repository's tab to the front: a job's Open may come from another tab or from Settings. */
export function showRepo(repoId: string): void {
  // A toast can outlive its repository's tab.
  if (useStore.getState().repos[repoId]) useStore.setState({ active: repoId, page: null })
}

/** Open a repository's AI panel on a thread. */
export function openInPanel(repoId: string, threadId: string): void {
  updateRepo(repoId, (v) => ({ chat: { ...v.chat, open: true, threadId } }))
}

/** Is this thread on screen in the AI panel? */
function panelShows(repoId: string, threadId: string | null): boolean {
  const s = useStore.getState()
  const chat = s.repos[repoId]?.chat
  return !!threadId && s.active === repoId && !s.page && !!chat?.open && chat.threadId === threadId
}

/** A run's end finishes its job: an answer or an error stays until seen; nothing at all (stopped, not set up) drops it. */
export function followJob(run: AiRun): void {
  run.done.then((res) => (res ? finishJob(run.requestId) : dropJob(run.requestId)), (e) => finishJob(run.requestId, toUiError(e).message))
}

/** A short name for a change, for a job's title. */
export function scopeLabel(scope: ReviewScope): string {
  switch (scope.kind) {
    case 'staged': return 'staged changes'
    case 'working': return 'uncommitted changes'
    case 'branch': return scope.branch
    case 'commits': return scope.hashes.length === 1 ? scope.hashes[0]!.slice(0, 7) : `${scope.hashes.length} commits`
    case 'outgoing': return 'outgoing commits'
  }
}

/**
 * Review, walkthrough and impact keep their result in the repository's view, so it survives
 * navigation already; the job is how the user hears it is ready while looking at something else.
 */
export function centerJob(run: AiRun, repoId: string, center: 'review' | 'walkthrough' | 'impact', title: string): void {
  registerJob({
    id: run.requestId,
    repoId,
    key: `${center}:${repoId}`,
    title,
    open: () => {
      showRepo(repoId)
      updateRepo(repoId, { center: { kind: center } })
    },
    stop: () => cancelAi(run.requestId),
    showing: () => {
      const s = useStore.getState()
      return s.active === repoId && !s.page && s.repos[repoId]?.center.kind === center
    },
  })
  followJob(run)
}

/**
 * "Why did this fail?" With a repository open, the answer is a kept thread, shown in the AI panel
 * as it streams: the panel is not modal, so the user carries on meanwhile, and the answer stays
 * in the panel's history (with any follow-ups) instead of going when a dialog closes. With no
 * repository open there is nothing to keep it with (main keeps threads per repository), so it
 * is shown in the modal.
 */
export function explainFailure(repoId: string | null, title: string, detail: string): void {
  const task: AiTask = { kind: 'explain-error', title, detail }
  if (!repoId) return explainInModal(`Why: ${title}`, null, task)
  let threadId: string | null = null
  const run = startAi(repoId, task, undefined, {
    keepThread: true,
    onThread: (id) => {
      threadId = id
      openInPanel(repoId, id)
    },
  })
  registerJob({
    id: run.requestId,
    repoId,
    title: `Why: ${title}`,
    open: () => {
      showRepo(repoId)
      if (threadId) openInPanel(repoId, threadId)
    },
    stop: () => cancelAi(run.requestId),
    showing: () => panelShows(repoId, threadId),
  })
  followJob(run)
}

export const conflictJobKey = (repoId: string, path: string) => `conflict:${repoId}:${path}`

type Proposal = Omit<NonNullable<AiUi['proposal']>, 'hidden'>

const sameProposal = (a: Proposal, b: Proposal) => a.repoId === b.repoId && a.path === b.path && a.content === b.content

function proposalShown(p: Proposal): boolean {
  const cur = useAi.getState().proposal
  return !!cur && !cur.hidden && sameProposal(cur, p)
}

/**
 * Show a conflict proposal in the (single) proposal dialog. One for another file that is on
 * screen goes back on the jobs list first, so neither answer is lost.
 */
export function showProposal(p: Proposal): void {
  const cur = useAi.getState().proposal
  if (cur && !cur.hidden && !sameProposal(cur, p)) parkProposal(cur)
  showRepo(p.repoId)
  useAi.setState({ proposal: { ...p, hidden: false } })
}

/** Put a proposal aside (its dialog closed, or another took its place): its job holds it until opened. */
export function parkProposal(p: Proposal): void {
  const kept: Proposal = { repoId: p.repoId, path: p.path, content: p.content, note: p.note }
  parkJob({
    id: crypto.randomUUID(),
    repoId: p.repoId,
    key: conflictJobKey(p.repoId, p.path),
    title: `Resolve ${p.path}`,
    open: () => showProposal(kept),
    showing: () => proposalShown(kept),
  })
}

/**
 * Ask the agent to resolve a conflicted file. It answers with a proposed file (reviewed in the
 * proposal dialog before anything is written) or only a note (why it changed nothing), which is
 * a kept thread shown in the AI panel. The user can leave the conflict view meanwhile: a
 * proposal that arrives while they are elsewhere waits, hidden, until they open it.
 */
export function resolveWithAgent(repoId: string, path: string): void {
  /** What came back: a proposal, or a note in a thread. */
  let answer: { proposal?: Proposal; threadId?: string } | null = null
  const run = startAi(repoId, { kind: 'resolve-conflict', path }, undefined, { keepThread: true })
  const atConflicts = () => {
    const s = useStore.getState()
    return s.active === repoId && !s.page && s.repos[repoId]?.center.kind === 'conflicts'
  }
  registerJob({
    id: run.requestId,
    repoId,
    key: conflictJobKey(repoId, path),
    title: `Resolve ${path}`,
    open: () => {
      showRepo(repoId)
      if (answer?.proposal) showProposal(answer.proposal)
      else if (answer?.threadId) openInPanel(repoId, answer.threadId)
      else updateRepo(repoId, { center: { kind: 'conflicts' } })
    },
    stop: () => cancelAi(run.requestId),
    showing: () => (answer?.proposal ? proposalShown(answer.proposal) : panelShows(repoId, answer?.threadId ?? null)),
  })
  run.done.then((res) => {
    if (!res) return dropJob(run.requestId)
    if (res.proposal) {
      // The job holds the proposal: one for another file may be in the dialog meanwhile.
      const proposal: Proposal = { repoId, path, content: res.proposal.content, note: res.text }
      answer = { proposal }
      if (atConflicts()) showProposal(proposal)
    } else {
      answer = { threadId: res.threadId }
      if (res.threadId) openInPanel(repoId, res.threadId)
    }
    finishJob(run.requestId)
  }, (e) => {
    dropJob(run.requestId)
    reportError(`The agent could not resolve ${path}`, e)
  })
}

/** Show a streamed answer in the AI output modal (an error explained with no repository open). */
function explainInModal(title: string, repoId: string | null, task: AiTask): void {
  const run = startAi(repoId, task, (text) => useAi.setState((s) => (s.output ? { output: { ...s.output, text } } : s)))
  useAi.setState({ output: { title, text: '', requestId: run.requestId, error: null } })
  run.done.then(
    (res) => useAi.setState((s) => (s.output ? { output: res ? { ...s.output, text: res.text, requestId: null } : null } : s)),
    (e) => useAi.setState((s) => (s.output ? { output: { ...s.output, requestId: null, error: toUiError(e).message } } : s)),
  )
}

export function useAiEnabled(): boolean {
  return useStore((s) => (s.settings?.aiProvider ?? 'off') !== 'off')
}
