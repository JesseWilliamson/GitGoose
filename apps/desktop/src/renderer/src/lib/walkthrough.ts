import type { ReviewScope, WalkthroughResult } from '@gitgoose/shared'
import { toUiError } from './api'
import { cancelAi, centerJob, openInPanel, scopeLabel, startAi } from './ai'
import { updateRepo, useStore, type RepoView } from './store'

export interface WalkthroughState {
  scope: ReviewScope
  requestId: string | null
  result: WalkthroughResult | null
  error: string | null
  /** The conversation this walkthrough is the first turn of (the chat rail). */
  threadId?: string | null
  /** The result was replaced by one from the chat. */
  fromChat?: boolean
}

/** Ask for a walkthrough of a change and show it; a newer one replaces the last. */
export function startWalkthrough(id: string, scope: ReviewScope, opts: { inChat?: boolean } = {}): void {
  const old = useStore.getState().repos[id]?.walkthrough
  if (old?.requestId) cancelAi(old.requestId)
  const run = startAi(id, { kind: 'walkthrough', scope }, undefined,
    { keepThread: true, ...(opts.inChat ? { onThread: (threadId) => openInPanel(id, threadId) } : {}) })
  updateRepo(id, { walkthrough: { scope, requestId: run.requestId, result: null, error: null }, center: { kind: 'walkthrough' } })
  centerJob(run, id, 'walkthrough', `Walkthrough of ${scopeLabel(scope)}`)
  const mine = (v: RepoView) => v.walkthrough?.requestId === run.requestId
  run.done.then(
    (res) => updateRepo(id, (v) => (mine(v) ? { walkthrough: res?.walkthrough ? { ...v.walkthrough!, requestId: null, result: res.walkthrough, threadId: res.threadId ?? null } : null, ...(res ? {} : { center: { kind: 'graph' } as const }) } : {})),
    (e) => updateRepo(id, (v) => (mine(v) ? { walkthrough: { ...v.walkthrough!, requestId: null, error: toUiError(e).message } } : {})),
  )
}

export function stopWalkthrough(id: string): void {
  const w = useStore.getState().repos[id]?.walkthrough
  if (w?.requestId) cancelAi(w.requestId)
}
