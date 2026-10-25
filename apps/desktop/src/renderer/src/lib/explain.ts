import { isPaneVisible, showPane, turnText } from '@gitgoose/shared'
import { useEffect } from 'react'
import { create } from 'zustand'
import { cancelAi, openInPanel, showRepo, startAi } from './ai'
import { dropJob, finishJob, registerJob } from './aiJobs'
import { api, toUiError } from './api'
import { ensureLoaded, saveSettings, setting, updateRepo, useStore } from './store'

/**
 * Commit explanations, outside any component: the detail panel shows a commit's explanation,
 * but the explanation belongs to the commit. Selecting another commit unmounts the panel's
 * content; the request goes on, streams into this store, and the commit shows it again when it
 * is selected. Main keeps the conversation (keepThread, anchor { kind: 'explain', hash }), so
 * after a restart the explanation and its follow-ups come back from the saved threads.
 */

export interface Explanation {
  text: string
  /** While it streams. */
  requestId: string | null
  error: string | null
  /** The conversation the explanation is the first turn of (follow-ups go there). */
  threadId?: string
}

/** By `${repoId}:${hash}`. Absent: not looked up yet. null: the user closed it. */
export const useExplains = create<Record<string, Explanation | null>>(() => ({}))

const keyOf = (repoId: string, hash: string) => `${repoId}:${hash}`

function patch(k: string, p: Partial<Explanation>): void {
  useExplains.setState((s) => (s[k] ? { [k]: { ...s[k], ...p } } : s))
}

/** Is this commit's explanation on screen: the commit selected, and the Details pane on screen? */
function selected(repoId: string, hash: string): boolean {
  const s = useStore.getState()
  const sel = s.repos[repoId]?.selected
  return s.active === repoId && !s.page && isPaneVisible(setting('layout'), 'details') && sel?.kind === 'commit' && sel.hash === hash
}

/** Show a commit in the Details pane, showing the pane if it is hidden, behind a tab or collapsed. */
function showCommit(repoId: string, hash: string): void {
  showRepo(repoId)
  const layout = setting('layout')
  if (!isPaneVisible(layout, 'details')) void saveSettings({ layout: showPane(layout, 'details') })
  updateRepo(repoId, { selected: { kind: 'commit', hash } })
  void ensureLoaded(repoId, hash)
}

export function explainCommit(repoId: string, hash: string, opts: { inChat?: boolean } = {}): void {
  const k = keyOf(repoId, hash)
  const run = startAi(repoId, { kind: 'explain-commit', hash }, (text) => patch(k, { text }),
    { keepThread: true, ...(opts.inChat ? { onThread: (threadId) => openInPanel(repoId, threadId) } : {}) })
  useExplains.setState({ [k]: { text: '', requestId: run.requestId, error: null } })
  registerJob({
    id: run.requestId,
    repoId,
    key: `explain:${k}`,
    title: `Explain ${hash.slice(0, 7)}`,
    open: () => showCommit(repoId, hash),
    stop: () => cancelAi(run.requestId),
    showing: () => selected(repoId, hash),
  })
  const mine = () => useExplains.getState()[k]?.requestId === run.requestId
  run.done.then((res) => {
    if (!mine()) return dropJob(run.requestId)
    if (res) {
      patch(k, { text: res.text, requestId: null, threadId: res.threadId })
      return finishJob(run.requestId)
    }
    // Stopped: keep what had streamed; with nothing, as if never asked (an older explanation may show).
    dropJob(run.requestId)
    // Replace mode (the only way to remove a key): every other commit's entry is carried over.
    useExplains.setState((s) => {
      const e = s[k]
      if (e?.text) return { ...s, [k]: { ...e, requestId: null } }
      const { [k]: _gone, ...rest } = s
      return rest
    }, true)
  }, (e) => {
    if (!mine()) return dropJob(run.requestId)
    patch(k, { requestId: null, error: toUiError(e).message })
    finishJob(run.requestId, toUiError(e).message)
  })
}

/** The × on the explanation: stop it if it runs, and do not show it again for this commit (until asked again). */
export function closeExplanation(repoId: string, hash: string): void {
  const k = keyOf(repoId, hash)
  const e = useExplains.getState()[k]
  if (e?.requestId) cancelAi(e.requestId)
  useExplains.setState({ [k]: null })
}

/** Saved explanations of a repository, newest per commit: read once, the first time a commit is shown. */
const saved = new Map<string, Promise<Map<string, Explanation>>>()

function savedExplanations(repoId: string): Promise<Map<string, Explanation>> {
  let p = saved.get(repoId)
  if (!p) {
    p = api.aiThreads(repoId).then((threads) => {
      const byHash = new Map<string, Explanation>()
      // Most recently used first: the first explanation of a commit wins.
      for (const t of threads) {
        if (t.anchor.kind !== 'explain' || byHash.has(t.anchor.hash)) continue
        const answer = t.turns.find((x) => x.role === 'agent' && x.feature)
        if (answer?.status === 'done') byHash.set(t.anchor.hash, { text: turnText(answer), requestId: null, error: null, threadId: t.id })
      }
      return byHash
    })
    p.catch(() => saved.delete(repoId))
    saved.set(repoId, p)
  }
  return p
}

/**
 * The explanation of a commit: the one in this session, or else the last saved one (looked up
 * once per repository, and only with AI on).
 */
export function useExplanation(repoId: string, hash: string, enabled: boolean): Explanation | null {
  const k = keyOf(repoId, hash)
  const e = useExplains((s) => s[k])
  const unknown = e === undefined
  useEffect(() => {
    if (!enabled || !unknown) return
    savedExplanations(repoId).then((byHash) => {
      const found = byHash.get(hash)
      if (found && useExplains.getState()[k] === undefined) useExplains.setState({ [k]: found })
    }, () => {})
  }, [repoId, hash, k, enabled, unknown])
  return e ?? null
}

/** A thread was deleted (the AI panel's history): an explanation from it is gone too. */
export function forgetExplanationThread(repoId: string, threadId: string): void {
  useExplains.setState((s) => Object.fromEntries(Object.entries(s).map(([k, e]) => [k, k.startsWith(`${repoId}:`) && e?.threadId === threadId ? null : e])), true)
  void saved.get(repoId)?.then((byHash) => {
    for (const [hash, e] of byHash) if (e.threadId === threadId) byHash.delete(hash)
  })
}
