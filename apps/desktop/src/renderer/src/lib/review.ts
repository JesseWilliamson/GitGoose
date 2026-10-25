import type { DiffTarget, ReviewFinding, ReviewProfile, ReviewResult, ReviewScope } from '@gitgoose/shared'
import { api, toUiError } from './api'
import { cancelAi, centerJob, openInPanel, scopeLabel, showRepo, startAi, useAi } from './ai'
import { dropFinishedJob, dropJob, finishJob, registerJob } from './aiJobs'
import { choose, setting, toast, updateRepo, useStore, type RepoView } from './store'
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
  /** The conversation this review is the first turn of (the chat rail). */
  threadId?: string | null
}

/**
 * Start an AI review and show the review view; a newer review replaces the last. With
 * `incremental`, the last review of the same change is the starting point: only hunks that
 * changed since are sent, and its findings carry over while their lines are unchanged.
 */
export function startReview(id: string, scope: ReviewScope, opts: { incremental?: boolean; inChat?: boolean } = {}): void {
  const old = useStore.getState().repos[id]?.review
  if (old?.requestId) cancelAi(old.requestId)
  const profile = setting('reviewProfile') as ReviewProfile
  const same = old?.result && JSON.stringify(old.scope) === JSON.stringify(scope) && old.profile === profile
  const previous = opts.incremental && same ? { findings: old!.result!.findings.filter((f) => !old!.dismissed.includes(f.id)), hunkKeys: old!.result!.hunkKeys, contextKey: old!.result!.contextKey } : undefined
  const run = startAi(id, { kind: 'review', scope, profile, previous }, undefined,
    { before: () => askAboutLinters(id), keepThread: true, ...(opts.inChat ? { onThread: (threadId) => openInPanel(id, threadId) } : {}) })
  updateRepo(id, { review: { scope, profile, requestId: run.requestId, result: null, error: null, dismissed: [], focus: null }, center: { kind: 'review' } })
  centerJob(run, id, 'review', `Review of ${scopeLabel(scope)}`)
  const mine = (v: RepoView) => v.review?.requestId === run.requestId
  run.done.then(
    (res) => updateRepo(id, (v) => (mine(v) ? { review: res?.review ? { ...v.review!, requestId: null, result: res.review, threadId: res.threadId ?? null } : null, ...(res ? {} : { center: { kind: 'graph' } as const }) } : {})),
    (e) => updateRepo(id, (v) => (mine(v) ? { review: { ...v.review!, requestId: null, error: toUiError(e).message } } : {})),
  )
}

/**
 * Linters found since the last review (or a new command in Settings) are asked about once per
 * repository. Each runs the repository's own config, so this is a question about trusting the
 * repository, like opening a project in an editor that runs its tasks. Closing the dialog skips
 * it this time and asks again next time; the buttons are remembered.
 */
async function askAboutLinters(id: string): Promise<void> {
  const list = await api.linters(id).catch(() => [])
  for (const l of list.filter((x) => x.decision === null)) {
    const answer = await new Promise<boolean | null>((resolve) => choose(
      `Run ${l.name} during reviews?`,
      l.source === 'detected'
        ? `This repository is set up for ${l.name}. Reviews can run it on the changed files and show what it reports. It uses the repository's own configuration, which can run code from the repository. Allow this command for this repository?`
        : 'Reviews of this repository can run the linter command from Settings on the changed files. Allow it here?',
      [{ label: "Don't run", run: () => resolve(false) }, { label: 'Allow', variant: 'primary', run: () => resolve(true) }],
      l.command,
      () => resolve(null),
    ))
    if (answer !== null) await api.decideLinter(id, l.command, answer)
  }
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

/** The diff that shows a reviewed (or walked-through) change for one file: exactly what was read. */
export function targetFor(result: { head: string; base?: string }, path: string): DiffTarget {
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

/**
 * Ask the AI to fix a finding; its new version of the file is shown for review, not written.
 * The dialog does not hold the user while it waits: closing it hides it (the request goes on,
 * as a job in the status bar), and the fix is there to open when it is ready.
 */
export function fixWithAi(id: string, f: ReviewFinding): void {
  const old = useAi.getState().fix
  if (old?.requestId) cancelAi(old.requestId)
  // The file as it is when the fix is asked for, read before the request goes out: the diff is
  // shown against it and Use writes only while the file is still exactly this, so edits made
  // while the AI works (or while the fix waits on the chip) are never overwritten.
  const snapshot = api.workingText(id, f.path)
  snapshot.catch(() => {})
  const run = startAi(id, { kind: 'fix-finding', finding: f })
  useAi.setState({ fix: { repoId: id, path: f.path, title: f.title, requestId: run.requestId, before: null, after: null, note: '', error: null, hidden: false } })
  const mine = () => useAi.getState().fix?.requestId === run.requestId
  registerJob({
    id: run.requestId,
    repoId: id,
    key: 'fix',
    title: `Fix: ${f.title}`,
    open: showFix,
    stop: () => cancelAi(run.requestId),
    showing: () => useAi.getState().fix?.hidden === false,
  })
  const settle = (patch: Partial<NonNullable<ReturnType<typeof useAi.getState>['fix']>>, error?: string) => {
    useAi.setState((s) => ({ fix: s.fix && { ...s.fix, requestId: null, ...patch } }))
    finishJob(run.requestId, error)
  }
  run.done.then(async (res) => {
    if (!mine()) return dropJob(run.requestId)
    if (!res) {
      dropJob(run.requestId)
      return useAi.setState({ fix: null })
    }
    // No new file: the agent's note says why (it was not allowed to edit, or saw nothing to fix).
    if (!res.proposal) return settle({ note: res.text || 'The agent did not propose a change.' })
    const before = await snapshot
    if (mine()) settle({ before, after: res.proposal.content, note: res.text })
  }).catch((e) => {
    if (mine()) settle({ error: toUiError(e).message }, toUiError(e).message)
  })
}

/** Show the Fix dialog again (from the AI jobs chip or the "ready" toast). */
export function showFix(): void {
  const fix = useAi.getState().fix
  if (!fix) return
  showRepo(fix.repoId)
  useAi.setState({ fix: { ...fix, hidden: false } })
}

/** Write the proposed fix (checked against the file as it was when proposed; undoable). */
export async function acceptFix(): Promise<void> {
  const fix = useAi.getState().fix
  useAi.setState({ fix: null })
  dropFinishedJob('fix')
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
