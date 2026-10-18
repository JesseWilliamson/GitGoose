import { AI_AUTH_REQUIRED, type AgentAuthMethod, type AiActivity, type AiPermissionRequest, type AiResult, type AiTask, type RecomposeProposal } from '@gitsquid/shared'
import { create } from 'zustand'
import { api, toUiError } from './api'
import { attention, choose, useStore } from './store'

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
  /** A streamed answer shown in a modal (error explanations, conflict notes). */
  output: { title: string; text: string; requestId: string | null; error: string | null } | null
  /** A conflict resolution the agent proposed, for review. */
  proposal: { repoId: string; path: string; content: string; note: string } | null
  /** Fix with AI: waiting for, or showing, a proposed new version of one file. */
  fix: { repoId: string; path: string; title: string; requestId: string | null; before: string | null; after: string | null; note: string; error: string | null } | null
  /** Recompose with AI: waiting for a plan (requestId set), failed, or under review. */
  recompose: { repoId: string; hashes: string[]; requestId: string | null; proposal: RecomposeProposal | null; error: string | null } | null
}

export const useAi = create<AiUi>(() => ({ consent: null, login: null, permissions: [], output: null, proposal: null, recompose: null, fix: null }))

const textListeners = new Map<string, (text: string) => void>()

/** A request on its way: what the progress card shows. */
export interface AiRunInfo {
  requestId: string
  kind: AiTask['kind']
  /** Date.now() when it was sent. */
  started: number
  /** How long this kind of request took lately (median, ms), when known. */
  usually: number | null
  /** The latest activity main reported; null until the first one. */
  activity: AiActivity | null
}

/** Requests on their way, oldest first. */
export const useAiRuns = create<{ runs: AiRunInfo[] }>(() => ({ runs: [] }))

/** Called from the store's event handler. */
export function onAiEvent(e: { type: 'ai-text'; requestId: string; text: string } | { type: 'ai-activity'; requestId: string; activity: AiActivity }
  | { type: 'ai-permission'; request: AiPermissionRequest } | { type: 'ai-permission-closed'; permissionId: number }): void {
  if (e.type === 'ai-text') textListeners.get(e.requestId)?.(e.text)
  else if (e.type === 'ai-activity') {
    useAiRuns.setState((s) => ({ runs: s.runs.map((r) => (r.requestId === e.requestId ? { ...r, activity: e.activity } : r)) }))
  }
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
export function startAi(repoId: string | null, task: AiTask, onText?: (text: string) => void, opts: { before?: () => Promise<void> } = {}): AiRun {
  const requestId = crypto.randomUUID()
  const done = (async (): Promise<AiResult | null> => {
    const status = await api.aiStatus()
    if (status.provider === 'off' || !status.ready) {
      attention({
        title: status.provider === 'off' ? 'AI features are off' : `Finish setting up ${status.label}`,
        detail: 'Choose an agent or add an API key in Settings → AI.',
        actions: [{ label: 'Open settings', variant: 'primary', run: openSettings }],
      })
      return null
    }
    if (!status.consented) {
      const ok = await new Promise<boolean>((resolve) => useAi.setState({ consent: { label: status.label, what: WHAT[task.kind], resolve } }))
      if (!ok) return null
      await api.aiConsent()
    }
    await opts.before?.()
    if (onText) textListeners.set(requestId, onText)
    const started = Date.now()
    useAiRuns.setState((s) => ({ runs: [...s.runs, { requestId, kind: task.kind, started, usually: usualDuration(task.kind), activity: null }] }))
    let finished = false
    try {
      let redact = false
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await api.aiRun(requestId, repoId ?? '', task, redact ? { redact } : undefined)
          finished = true
          return res
        } catch (e) {
          const err = e as { code?: string; message?: string }
          if (err.code === 'ai-cancelled') return null
          if (err.code === 'ai-secrets' && !redact) {
            if (!(await askToRedact(err.message ?? ''))) return null
            redact = true
            continue
          }
          if (err.code !== AI_AUTH_REQUIRED || attempt > 0) throw e
          const info = await api.aiAgentInfo()
          const ok = await new Promise<boolean>((resolve) => useAi.setState({ login: { agent: info.name, methods: info.authMethods, repoId, resolve } }))
          if (!ok) return null
        }
      }
    } finally {
      textListeners.delete(requestId)
      useAiRuns.setState((s) => ({ runs: s.runs.filter((r) => r.requestId !== requestId) }))
      // Only answers count towards "usually": a cancel or a failure says nothing about the time.
      if (finished) recordDuration(task.kind, Date.now() - started)
    }
  })()
  return { requestId, done }
}

// ------------------------------------------------------------------ how long it usually takes

/**
 * The last few durations per kind of request, in this browser profile's localStorage: a viewer
 * convenience, so losing it (private mode, cleared data) only loses the estimate. The median of
 * the last five shrugs off one slow run.
 */
const DURATIONS_KEY = 'gitsquid:ai-durations'
const KEEP = 5

function readDurations(): Partial<Record<AiTask['kind'], number[]>> {
  try {
    return JSON.parse(localStorage.getItem(DURATIONS_KEY) ?? '{}') as Partial<Record<AiTask['kind'], number[]>>
  } catch {
    return {}
  }
}

export function usualDuration(kind: AiTask['kind']): number | null {
  const ds = [...(readDurations()[kind] ?? [])].sort((a, b) => a - b)
  return ds.length ? ds[Math.floor(ds.length / 2)]! : null
}

function recordDuration(kind: AiTask['kind'], ms: number): void {
  try {
    const all = readDurations()
    all[kind] = [...(all[kind] ?? []), ms].slice(-KEEP)
    localStorage.setItem(DURATIONS_KEY, JSON.stringify(all))
  } catch {
    // No storage: no estimate next time, nothing else.
  }
}

/**
 * The secret scan in main stopped a request. Main's message is a sentence, a blank line, then the
 * (masked) list; the list goes in the dialog's detail box. Cancel comes first so Enter is the safe
 * answer, and closing the dialog counts as Cancel.
 */
function askToRedact(message: string): Promise<boolean> {
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
