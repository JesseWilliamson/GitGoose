import { AI_AUTH_REQUIRED, type AgentAuthMethod, type AiPermissionRequest, type AiResult, type AiTask, type RecomposeProposal } from '@gitsquid/shared'
import { create } from 'zustand'
import { api, toUiError } from './api'
import { attention, useStore } from './store'

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
}

function openSettings(): void {
  useStore.setState({ page: 'settings' })
}

export interface AiRun {
  requestId: string
  /** The result; null when the user cancelled or something was not set up (already reported). */
  done: Promise<AiResult | null>
}

export function startAi(repoId: string | null, task: AiTask, onText?: (text: string) => void): AiRun {
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
    if (onText) textListeners.set(requestId, onText)
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await api.aiRun(requestId, repoId ?? '', task)
        } catch (e) {
          const err = e as { code?: string }
          if (err.code === 'ai-cancelled') return null
          if (err.code !== AI_AUTH_REQUIRED || attempt > 0) throw e
          const info = await api.aiAgentInfo()
          const ok = await new Promise<boolean>((resolve) => useAi.setState({ login: { agent: info.name, methods: info.authMethods, repoId, resolve } }))
          if (!ok) return null
        }
      }
    } finally {
      textListeners.delete(requestId)
    }
  })()
  return { requestId, done }
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
