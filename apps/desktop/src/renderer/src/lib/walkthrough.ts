import type { ReviewScope, WalkthroughResult } from '@gitgoose/shared'
import { toUiError } from './api'
import { cancelAi, startAi } from './ai'
import { updateRepo, useStore, type RepoView } from './store'

export interface WalkthroughState {
  scope: ReviewScope
  requestId: string | null
  result: WalkthroughResult | null
  error: string | null
}

/** Ask for a walkthrough of a change and show it; a newer one replaces the last. */
export function startWalkthrough(id: string, scope: ReviewScope): void {
  const old = useStore.getState().repos[id]?.walkthrough
  if (old?.requestId) cancelAi(old.requestId)
  const run = startAi(id, { kind: 'walkthrough', scope })
  updateRepo(id, { walkthrough: { scope, requestId: run.requestId, result: null, error: null }, center: { kind: 'walkthrough' } })
  const mine = (v: RepoView) => v.walkthrough?.requestId === run.requestId
  run.done.then(
    (res) => updateRepo(id, (v) => (mine(v) ? { walkthrough: res?.walkthrough ? { ...v.walkthrough!, requestId: null, result: res.walkthrough } : null, ...(res ? {} : { center: { kind: 'graph' } as const }) } : {})),
    (e) => updateRepo(id, (v) => (mine(v) ? { walkthrough: { ...v.walkthrough!, requestId: null, error: toUiError(e).message } } : {})),
  )
}

export function stopWalkthrough(id: string): void {
  const w = useStore.getState().repos[id]?.walkthrough
  if (w?.requestId) cancelAi(w.requestId)
}
