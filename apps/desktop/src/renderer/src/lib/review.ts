import type { DiffTarget, ReviewFinding, ReviewProfile, ReviewResult, ReviewScope } from '@gitsquid/shared'
import { api, toUiError } from './api'
import { cancelAi, startAi, useAi } from './ai'
import { setting, toast, updateRepo, useStore, type RepoView } from './store'
import { ask, run } from './actions'

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

/** Apply a finding's suggestion to the working file (refused if those lines changed since). */
export function applySuggestion(id: string, f: ReviewFinding): Promise<boolean> {
  return run(id, `Apply suggestion to ${f.path}`, () => api.applySuggestion(id, f.path, f.startLine, f.endLine, f.original ?? [], f.suggestion ?? ''))
    .then((ok) => {
      if (ok) dismissFinding(id, f.id)
      return ok
    })
}

/** Ask the AI to fix a finding; its new version of the file is shown for review, not written. */
export function fixWithAi(id: string, f: ReviewFinding): void {
  const run = startAi(id, { kind: 'fix-finding', finding: f })
  useAi.setState({ fix: { repoId: id, path: f.path, title: f.title, requestId: run.requestId, before: null, after: null, note: '', error: null } })
  const mine = () => useAi.getState().fix?.requestId === run.requestId
  run.done.then(async (res) => {
    if (!mine()) return
    if (!res?.proposal) return useAi.setState({ fix: null })
    const before = await api.workingText(id, f.path)
    useAi.setState({ fix: { repoId: id, path: f.path, title: f.title, requestId: null, before, after: res.proposal.content, note: res.text, error: null } })
  }, (e) => {
    if (mine()) useAi.setState((s) => ({ fix: s.fix && { ...s.fix, requestId: null, error: toUiError(e).message } }))
  })
}

/** Write the proposed fix (checked against the file as it was when proposed; undoable). */
export async function acceptFix(): Promise<void> {
  const fix = useAi.getState().fix
  useAi.setState({ fix: null })
  if (!fix?.after || fix.before === null) return
  await run(fix.repoId, `Apply AI fix to ${fix.path}`, () => api.writeFileChecked(fix.repoId, fix.path, fix.before!, fix.after!))
}

/**
 * Dismiss a finding and remember why: the note goes with this repository's future reviews
 * ("do not flag …"), optionally only for files matching a glob.
 */
export function rememberDismissal(id: string, f: ReviewFinding): void {
  ask('Do not flag this again', 'What to tell future reviews', 'Remember', async (text, path) => {
    const list = await api.reviewLearnings(id)
    await api.setReviewLearnings(id, [...list, { text: text.trim(), path: path.trim() || undefined, added: Date.now() }])
    dismissFinding(id, f.id)
    toast({ kind: 'success', title: 'Remembered for future reviews' })
  }, { initial: `Do not flag "${f.title}"${f.type === 'style' ? ' (house style)' : ''}`, extra: { label: 'Only for files matching (optional glob)', placeholder: '**/*.test.ts' } })
}
