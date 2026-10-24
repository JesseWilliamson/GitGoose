import { canRestore, centerOf, type AiThread, type ReviewProfile } from '@gitgoose/shared'
import { useEffect } from 'react'
import { create } from 'zustand'
import { useAi } from './ai'
import { api } from './api'
import { showImpact } from './impact'
import { showAiPane } from './panes'
import { holdThread, releaseThread } from './thread'
import { setting, toast, updateRepo, useStore } from './store'

/**
 * Reopening a conversation from the chat's history.
 *
 * A chat about a review, a plan or a walkthrough owns a result, and the conversation is only
 * half of it: the other half was in the middle of the window. So opening one from the history
 * puts that back — but only while it is still true. Main compares what the conversation was
 * about with the repository as it is now (main/ai/basis.ts, shared/src/basis.ts); `stale` is
 * its one-sentence reason, and with a reason nothing is restored. A review of commits that have
 * since been rebased would point at line numbers that no longer mean anything, and a stale
 * answer that looks exactly like a fresh one is worse than no answer.
 *
 * The result is not stored anywhere separate: it is read back out of the conversation itself
 * (`aiThreadResult`) and run through the feature's own verifier, so what comes back on screen
 * is checked against the repository exactly as it was the first time.
 */
export async function openSavedThread(repoId: string, saved: AiThread, stale: string): Promise<void> {
  updateRepo(repoId, (v) => ({ chat: { ...v.chat, threadId: saved.id, pending: undefined, history: false } }))
  showAiPane()
  if (!canRestore(saved, stale)) return
  const center = centerOf(saved.anchor)
  // An impact is worked out locally, not by the model: showing it again is simply doing it again.
  if (center === 'impact' && saved.anchor.kind === 'impact') {
    showImpact(repoId, saved.anchor.scope)
    updateRepo(repoId, (v) => ({ impact: v.impact && { ...v.impact, threadId: saved.id } }))
    return
  }
  // Held while the result is read: main needs the conversation open to check it, and the panel
  // holds it too, so this only keeps it alive across the call.
  const thread = await holdThread(repoId, saved.anchor, saved.id).catch(() => null)
  if (!thread) return
  try {
    const result = await api.aiThreadResult(thread.id)
    if (!result) return
    if (result.kind === 'problem') {
      toast({ kind: 'info', title: 'That conversation’s result could not be shown again', detail: result.message })
      return
    }
    apply(repoId, saved, result)
  } catch {
    // Nothing to show is not a failure worth a toast: the conversation itself is open.
  } finally {
    releaseThread(thread.id)
  }
}

type Result = Awaited<ReturnType<typeof api.aiThreadResult>>

function apply(repoId: string, saved: AiThread, result: NonNullable<Result>): void {
  const anchor = saved.anchor
  if (result.kind === 'findings' && (anchor.kind === 'review' || anchor.kind === 'changestack')) {
    updateRepo(repoId, {
      review: {
        scope: anchor.scope, profile: setting('reviewProfile') as ReviewProfile, requestId: null,
        result: result.review, error: null, dismissed: [], focus: null, threadId: saved.id,
      },
      center: { kind: 'review' },
    })
    return
  }
  if (result.kind === 'walkthrough' && anchor.kind === 'walkthrough') {
    updateRepo(repoId, {
      walkthrough: { scope: anchor.scope, requestId: null, result: result.walkthrough, error: null, threadId: saved.id },
      center: { kind: 'walkthrough' },
    })
    return
  }
  if (result.kind === 'plan' && anchor.kind === 'recompose') {
    // A plan being edited for these same commits keeps its edits; anything else is replaced.
    const open = useAi.getState().recompose
    if (!open || open.repoId !== repoId || open.hashes.join() !== anchor.hashes.join()) {
      useAi.setState({ recompose: { repoId, hashes: anchor.hashes, requestId: null, proposal: result.recompose, error: null, threadId: saved.id } })
    }
    updateRepo(repoId, { center: { kind: 'recompose' } })
  }
}

/** Is this conversation the one whose result is in the middle of the window? */
export function threadShowsResult(repoId: string, threadId: string): boolean {
  const v = useStore.getState().repos[repoId]
  if (!v) return false
  switch (v.center.kind) {
    case 'review': return v.review?.threadId === threadId
    case 'walkthrough': return v.walkthrough?.threadId === threadId
    case 'impact': return v.impact?.threadId === threadId
    case 'recompose': return useAi.getState().recompose?.threadId === threadId
    default: return false
  }
}

/**
 * Which conversations of a repository are out of date, as main last worked it out. One pass of
 * read-only git answers for all of them, so a view that needs one answer asks for the lot and
 * everything on screen shares it.
 */
const useStale = create<Record<string, Record<string, string>>>(() => ({}))

export function refreshStale(repoId: string): void {
  void api.aiThreadsStale(repoId).then((stale) => useStale.setState({ [repoId]: stale }), () => {})
}

/**
 * Why the conversation on screen no longer describes the repository ('' while it still does).
 * Asked again when the conversation changes and whenever the refs move, which is when an
 * answer about commits can stop being true.
 */
export function useStaleReason(repoId: string, threadId: string | null | undefined): string {
  const refs = useStore((s) => s.repos[repoId]?.snapshot.refsVersion ?? 0)
  useEffect(() => {
    if (threadId) refreshStale(repoId)
  }, [repoId, threadId, refs])
  return useStale((s) => (threadId ? s[repoId]?.[threadId] ?? '' : ''))
}
