import type { ImpactResult, ReviewScope } from '@gitgoose/shared'
import { api, toUiError } from './api'
import { cancelAi, centerJob, scopeLabel, startAi } from './ai'
import { updateRepo, useStore, type RepoView } from './store'

export interface ImpactState {
  scope: ReviewScope
  loading: boolean
  result: ImpactResult | null
  error: string | null
  /** The AI assessment in flight. */
  requestId: string | null
  /** The conversation about this impact (the assessment's, or one started from the chat rail). */
  threadId?: string | null
  /** What the user wrote in the chat when they asked for it; sent with the assessment. */
  ask?: string
}

/**
 * Find what a change could affect (local, no AI) and show it. Started from a chat, the
 * conversation is remembered on the view, and the user's words go with the assessment the view
 * then asks for: the local search itself sends nothing anywhere.
 */
export function showImpact(id: string, scope: ReviewScope, opts: { thread?: string; ask?: string } = {}): void {
  updateRepo(id, { impact: { scope, loading: true, result: null, error: null, requestId: null, threadId: opts.thread ?? null, ask: opts.ask }, center: { kind: 'impact' } })
  const mine = (v: RepoView) => v.impact?.scope === scope
  api.impact(id, scope).then(
    (result) => {
      updateRepo(id, (v) => (mine(v) ? { impact: { ...v.impact!, loading: false, result } } : {}))
      // Asked as a question in the chat: answer it. Opened from the view, the assessment stays
      // the button it was, because the local search alone is often all the user wanted.
      const v = useStore.getState().repos[id]
      if (opts.thread && mine(v!) && result.callers.length && (useStore.getState().settings?.aiProvider ?? 'off') !== 'off') assessImpact(id)
    },
    (e) => updateRepo(id, (v) => (mine(v) ? { impact: { ...v.impact!, loading: false, error: toUiError(e).message } } : {})),
  )
}

/** Ask the AI which of the found call sites are at risk. */
export function assessImpact(id: string): void {
  const st = useStore.getState().repos[id]?.impact
  if (!st) return
  if (st.requestId) cancelAi(st.requestId)
  const run = startAi(id, { kind: 'assess-impact', scope: st.scope }, undefined, { keepThread: true, thread: st.threadId ?? undefined, ask: st.ask })
  updateRepo(id, (v) => ({ impact: { ...v.impact!, requestId: run.requestId, error: null } }))
  centerJob(run, id, 'impact', `Impact of ${scopeLabel(st.scope)}`)
  const mine = (v: RepoView) => v.impact?.requestId === run.requestId
  run.done.then(
    (res) => updateRepo(id, (v) => (mine(v) ? { impact: { ...v.impact!, requestId: null, result: res?.impact ?? v.impact!.result, threadId: res?.threadId ?? v.impact!.threadId } } : {})),
    (e) => updateRepo(id, (v) => (mine(v) ? { impact: { ...v.impact!, requestId: null, error: toUiError(e).message } } : {})),
  )
}
