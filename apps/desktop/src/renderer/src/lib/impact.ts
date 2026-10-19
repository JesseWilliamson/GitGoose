import type { ImpactResult, ReviewScope } from '@gitgoose/shared'
import { api, toUiError } from './api'
import { cancelAi, startAi } from './ai'
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
}

/** Find what a change could affect (local, no AI) and show it. */
export function showImpact(id: string, scope: ReviewScope): void {
  updateRepo(id, { impact: { scope, loading: true, result: null, error: null, requestId: null }, center: { kind: 'impact' } })
  const mine = (v: RepoView) => v.impact?.scope === scope
  api.impact(id, scope).then(
    (result) => updateRepo(id, (v) => (mine(v) ? { impact: { ...v.impact!, loading: false, result } } : {})),
    (e) => updateRepo(id, (v) => (mine(v) ? { impact: { ...v.impact!, loading: false, error: toUiError(e).message } } : {})),
  )
}

/** Ask the AI which of the found call sites are at risk. */
export function assessImpact(id: string): void {
  const st = useStore.getState().repos[id]?.impact
  if (!st) return
  if (st.requestId) cancelAi(st.requestId)
  const run = startAi(id, { kind: 'assess-impact', scope: st.scope }, undefined, { keepThread: true })
  updateRepo(id, (v) => ({ impact: { ...v.impact!, requestId: run.requestId, error: null } }))
  const mine = (v: RepoView) => v.impact?.requestId === run.requestId
  run.done.then(
    (res) => updateRepo(id, (v) => (mine(v) ? { impact: { ...v.impact!, requestId: null, result: res?.impact ?? v.impact!.result, threadId: res?.threadId ?? v.impact!.threadId } } : {})),
    (e) => updateRepo(id, (v) => (mine(v) ? { impact: { ...v.impact!, requestId: null, error: toUiError(e).message } } : {})),
  )
}
