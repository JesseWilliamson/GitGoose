import type { DiffTarget, ReviewFinding, ReviewProfile, ReviewResult, ReviewScope } from '@gitsquid/shared'
import { toUiError } from './api'
import { cancelAi, startAi } from './ai'
import { setting, updateRepo, useStore, type RepoView } from './store'

/** A review of one change in a repository: running, failed, or done (findings, minus dismissed ones). */
export interface ReviewState {
  scope: ReviewScope
  profile: ReviewProfile
  requestId: string | null
  result: ReviewResult | null
  error: string | null
  /** Finding ids the user dismissed. */
  dismissed: string[]
  /** The finding to scroll to (from a gutter marker). */
  focus: string | null
}

/** Start an AI review and show the review view; a newer review replaces the last. */
export function startReview(id: string, scope: ReviewScope): void {
  const old = useStore.getState().repos[id]?.review
  if (old?.requestId) cancelAi(old.requestId)
  const profile = setting('reviewProfile') as ReviewProfile
  const run = startAi(id, { kind: 'review', scope, profile })
  updateRepo(id, { review: { scope, profile, requestId: run.requestId, result: null, error: null, dismissed: [], focus: null }, center: { kind: 'review' } })
  const mine = (v: RepoView) => v.review?.requestId === run.requestId
  run.done.then(
    (res) => updateRepo(id, (v) => (mine(v) ? { review: res?.review ? { ...v.review!, requestId: null, result: res.review } : null, ...(res ? {} : { center: { kind: 'graph' } as const }) } : {})),
    (e) => updateRepo(id, (v) => (mine(v) ? { review: { ...v.review!, requestId: null, error: toUiError(e).message } } : {})),
  )
}

export function stopReview(id: string): void {
  const r = useStore.getState().repos[id]?.review
  if (r?.requestId) cancelAi(r.requestId)
}

export function dismissFinding(id: string, findingId: string): void {
  updateRepo(id, (v) => (v.review ? { review: { ...v.review, dismissed: [...v.review.dismissed, findingId] } } : {}))
}

/** The revision a diff's new side shows: where its line numbers come from. */
export function newSideOf(target: DiffTarget): string {
  switch (target.kind) {
    case 'unstaged':
    case 'untracked': return 'worktree'
    case 'staged': return 'index'
    case 'commit': return target.hash
    case 'range': return target.to ?? 'worktree'
  }
}

/** Findings that belong in this diff's gutter: same file, same new-side revision, not dismissed. */
export function findingsFor(view: RepoView, target: DiffTarget): ReviewFinding[] {
  const r = view.review
  if (!r?.result || r.result.head !== newSideOf(target)) return []
  return r.result.findings.filter((f) => f.path === target.path && !r.dismissed.includes(f.id))
}

/** The diff that shows a finding's lines: exactly what was reviewed, for that file. */
export function targetFor(result: ReviewResult, path: string): DiffTarget {
  if (result.head === 'index') return { kind: 'staged', path }
  return { kind: 'range', from: result.base ?? 'HEAD', to: result.head === 'worktree' ? null : result.head, path }
}
