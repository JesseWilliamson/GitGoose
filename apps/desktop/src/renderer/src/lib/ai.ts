import { AI_AUTH_REQUIRED, defaultTarget, effectivePrompt, type AgentAuthMethod, type AiArea, type AiPermissionRequest, type AiResult, type AiTarget, type AiTask, type RecomposeProposal, type ThreadAnchor } from '@gitgoose/shared'
import { create } from 'zustand'
import { api, toUiError } from './api'
import { attention, choose, saveSettings, useStore } from './store'

/**
 * Renderer side of the AI features. `startAi` does the asking (set up? agreed? logged in?) and
 * then hands the task to main, which streams the reply back as 'ai-text' events.
 */

export interface AiUi {
  /** "Send this to …?" before the first request to a provider. */
  consent: { label: string; what: string; resolve: (ok: boolean) => void } | null
  /** The agent wants a login. */
  login: { agent: string; methods: AgentAuthMethod[]; repoId: string | null; target?: AiTarget; resolve: (ok: boolean) => void } | null
  /** Tool calls waiting for an answer, oldest first. */
  permissions: AiPermissionRequest[]
  /** A streamed answer shown in a modal (error explanations, conflict notes). */
  output: { title: string; text: string; requestId: string | null; error: string | null } | null
  /** A conflict resolution the agent proposed, for review. */
  proposal: { repoId: string; path: string; content: string; note: string } | null
  /** Fix with AI: waiting for, or showing, a proposed new version of one file. */
  fix: { repoId: string; path: string; title: string; requestId: string | null; before: string | null; after: string | null; note: string; error: string | null } | null
  /** Recompose with AI: waiting for a plan (requestId set), failed, or under review. */
  recompose: {
    repoId: string; hashes: string[]; requestId: string | null; proposal: RecomposeProposal | null; error: string | null
    /** The conversation the plan came from (the chat column beside the plan). */
    threadId?: string
    /** A plan applied from the chat: the editor takes it as one undo step (see lib/artifacts.ts). */
    incoming?: { commits: RecomposeProposal['commits']; nonce: number }
  } | null
  /** A commit message applied from a chat, for the commit box of that repository to take (undoable there). */
  draft: { repoId: string; message: string; nonce: number } | null
}

export const useAi = create<AiUi>(() => ({ consent: null, login: null, permissions: [], output: null, proposal: null, recompose: null, fix: null, draft: null }))

const textListeners = new Map<string, (text: string) => void>()

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

/** Which area a task belongs to: each area remembers its own model pick. */
export function areaOf(kind: AiTask['kind']): AiArea {
  switch (kind) {
    case 'commit-message': return 'commit'
    case 'explain-commit': return 'explain'
    case 'explain-error': return 'error'
    case 'resolve-conflict': return 'conflict'
    case 'review': case 'fix-finding': return 'review'
    case 'assess-impact': return 'impact'
    case 'recompose': case 'walkthrough': case 'ask': case 'push-checks': return kind
  }
}

/** The area a conversation about `anchor` belongs to (the AI panel's free threads are "chat"). */
export function areaOfAnchor(anchor: ThreadAnchor): AiArea {
  switch (anchor.kind) {
    case 'review': case 'changestack': return 'review'
    case 'free': return 'chat'
    case 'task': return areaOf(anchor.task)
    default: return anchor.kind
  }
}

/** What an area uses now: its own pick, else Settings → AI. Null when AI is off. */
export function areaTarget(area: AiArea): AiTarget | null {
  const s = useStore.getState().settings
  if (!s || s.aiProvider === 'off') return null
  return s.aiAreaTargets[area] ?? defaultTarget(s)
}

/** Remember an area's pick; null goes back to following Settings → AI. */
export async function setAreaTarget(area: AiArea, target: AiTarget | null): Promise<void> {
  const all = useStore.getState().settings?.aiAreaTargets ?? {}
  const { [area]: _old, ...rest } = all
  await saveSettings({ aiAreaTargets: target ? { ...rest, [area]: target } : rest })
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
export function startAi(repoId: string | null, task: AiTask, onText?: (text: string) => void, opts: { before?: () => Promise<void>; keepThread?: boolean; target?: AiTarget } = {}): AiRun {
  const requestId = crypto.randomUUID()
  // Decided once, up front: changing the picker mid-request applies to the next one.
  const target = opts.target ?? areaTarget(areaOf(task.kind)) ?? undefined
  // The words the area's Prompt panel shows (its edit, else Settings', else built-in): sent as
  // they are, so what the panel showed is what goes.
  const settings = useStore.getState().settings
  const prompt = settings ? (({ system, instructions }) => ({ system, instructions }))(effectivePrompt(task.kind, settings)) : undefined
  const done = (async (): Promise<AiResult | null> => {
    if (!(await ensureAi(WHAT[task.kind], target))) return null
    await opts.before?.()
    if (onText) textListeners.set(requestId, onText)
    try {
      let redact = false
      for (let attempt = 0; ; attempt++) {
        try {
          const o = { ...(redact ? { redact } : {}), ...(opts.keepThread ? { keepThread: true } : {}), ...(target ? { target } : {}), ...(prompt ? { prompt } : {}) }
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
          if (!(await askLogin(repoId, target))) return null
        }
      }
    } finally {
      textListeners.delete(requestId)
    }
  })()
  return { requestId, done }
}

/**
 * Before anything is sent: is a provider set up, and has the user agreed to send `what` to it?
 * False when they have to do something first (already reported or asked).
 */
export async function ensureAi(what: string, target?: AiTarget): Promise<boolean> {
  const status = await api.aiStatus(target)
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
    await api.aiConsent(target)
  }
  return true
}

/** The agent needs a login: show its methods. True once the user says they have logged in. */
export async function askLogin(repoId: string | null, target?: AiTarget): Promise<boolean> {
  const info = await api.aiAgentInfo(target)
  return new Promise<boolean>((resolve) => useAi.setState({ login: { agent: info.name, methods: info.authMethods, repoId, ...(target ? { target } : {}), resolve } }))
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

/** Show a streamed answer in the AI output modal. */
export function explainInModal(title: string, repoId: string | null, task: AiTask): void {
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
