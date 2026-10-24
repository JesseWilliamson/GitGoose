import { toUiError } from './api'
import { cancelAi, showRepo, startAi, useAi } from './ai'
import { dropJob, finishJob, registerJob } from './aiJobs'
import { updateRepo, useStore } from './store'

/**
 * Starting a recompose, and finding the plan again. The editor itself is
 * components/RecomposeView.tsx; this is the part the menus, the chat and the jobs chip call,
 * and it lives beside the other starters (review.ts, walkthrough.ts, impact.ts, explain.ts)
 * so nothing outside components/ has to import a component to ask for one.
 */

/**
 * Ask for a plan, in the conversation the user started it in (every AI action goes through the
 * chat: lib/aiActions.ts). Waiting does not hold them: leaving the view only leaves it, while
 * the request goes on as a job in the status bar, and the plan is there to open when it is
 * ready — or later, from the chat's history, for as long as those commits are still there.
 */
export function recomposeWithAi(repoId: string, hashes: string[], opts: { thread?: string; ask?: string } = {}): void {
  const old = useAi.getState().recompose
  if (old?.requestId) cancelAi(old.requestId)
  const r = startAi(repoId, { kind: 'recompose', hashes }, undefined, { keepThread: true, ...opts })
  useAi.setState({ recompose: { repoId, hashes, requestId: r.requestId, proposal: null, error: null, threadId: opts.thread } })
  updateRepo(repoId, { center: { kind: 'recompose' } })
  registerJob({
    id: r.requestId,
    repoId,
    key: 'recompose',
    title: `Recompose ${hashes.length === 1 ? '1 commit' : `${hashes.length} commits`}`,
    open: showRecompose,
    stop: () => cancelAi(r.requestId),
    showing: () => showingRecompose(repoId),
  })
  const mine = (s: ReturnType<typeof useAi.getState>) => s.recompose?.requestId === r.requestId
  r.done.then(
    (res) => {
      if (!mine(useAi.getState())) return dropJob(r.requestId)
      if (!res?.recompose) {
        // Cancelled or not set up (already reported).
        dropJob(r.requestId)
        return useAi.setState({ recompose: null })
      }
      useAi.setState((s) => ({ recompose: { ...s.recompose!, requestId: null, proposal: res.recompose!, threadId: res.threadId ?? s.recompose!.threadId } }))
      finishJob(r.requestId)
    },
    (e) => {
      if (!mine(useAi.getState())) return dropJob(r.requestId)
      useAi.setState((s) => ({ recompose: { ...s.recompose!, requestId: null, error: toUiError(e).message } }))
      finishJob(r.requestId, toUiError(e).message)
    },
  )
}

/** Is the plan the view in the middle of the window right now? */
export function showingRecompose(repoId: string): boolean {
  const s = useStore.getState()
  return s.active === repoId && !s.page && s.repos[repoId]?.center.kind === 'recompose'
}

/** Show the plan again (from the AI jobs chip or the "ready" toast). */
export function showRecompose(): void {
  const rc = useAi.getState().recompose
  if (!rc) return
  showRepo(rc.repoId)
  updateRepo(rc.repoId, { center: { kind: 'recompose' } })
}

