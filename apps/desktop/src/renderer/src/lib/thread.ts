import { AI_AUTH_REQUIRED, hidePane, isPaneVisible, openingPromptKind, reduceThread, setCollapsed, showPane, slotOf, type AiContextRef, type AiThread, type AiUpdate, type ThreadAnchor } from '@gitgoose/shared'
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { areaOfAnchor, areaTarget, askLogin, askToRedact, ensureAi, onAiThread, useAi, whatFor, wordsFor } from './ai'
import { forgetExplanationThread } from './explain'
import { api, toUiError } from './api'
import { focusInAiPane, focusAiComposer, saveLayout, showAiPane } from './panes'
import { reportError, setting, updateRepo, useStore } from './store'

/**
 * The renderer's copy of the conversations on screen. Main sends every event of a thread as
 * 'ai-update'; this store folds it in with the same reduceThread main uses for its own copy,
 * so what is drawn is exactly what main keeps (and saves). Only threads a view has open are
 * here; events for others are ignored.
 */
export const useThreads = create<{ threads: Record<string, AiThread> }>(() => ({ threads: {} }))

/** How many views show each thread: the last one to close it tells main (the idle grace starts). */
const holders = new Map<string, number>()

export function onThreadUpdate(e: { threadId: string; requestId: string; update: AiUpdate }): void {
  // A feature request learns its thread here, so a view can open it while the answer streams.
  if (e.update.kind === 'turn') onAiThread(e.requestId, e.threadId)
  const t = useThreads.getState().threads[e.threadId]
  if (!t) return
  const next = reduceThread(t, e.requestId, e.update)
  if (next !== t) useThreads.setState((s) => ({ threads: { ...s.threads, [e.threadId]: next } }))
  if (e.update.kind === 'done') revealAnswer(next.repoId, e.threadId)
  // A finished Ask answer: the commit's question list shows it from now on.
  if (e.update.kind === 'done' && next.anchor.kind === 'ask') {
    void api.askThreads(next.repoId).then((askThreads) => updateRepo(next.repoId, { askThreads }), () => {})
  }
}

/** Open a thread (or `resume` one) and hold it while the caller is on screen. */
export async function holdThread(repoId: string, anchor: ThreadAnchor, resume?: string): Promise<AiThread> {
  const thread = await api.aiThreadOpen(repoId, anchor, resume)
  holders.set(thread.id, (holders.get(thread.id) ?? 0) + 1)
  // Main's copy is the truth: events folded so far are in it.
  useThreads.setState((s) => ({ threads: { ...s.threads, [thread.id]: thread } }))
  return thread
}

/**
 * Let go of a thread. The close waits a tick: a view that adopts the thread it just opened (or
 * re-renders with it) holds it again first, and main never sees a close-and-reopen.
 */
export function releaseThread(threadId: string): void {
  const n = (holders.get(threadId) ?? 1) - 1
  if (n > 0) return void holders.set(threadId, n)
  holders.delete(threadId)
  setTimeout(() => {
    if (holders.has(threadId)) return
    useThreads.setState((s) => {
      const { [threadId]: _gone, ...rest } = s.threads
      return { threads: rest }
    })
    void api.aiThreadClose(threadId).catch(() => {})
  }, 0)
}

/**
 * The thread a view shows: `threadId` when the view has one (a feature's own thread), else a new
 * one about `anchor`, reported through `onOpened` so the view can keep it. Opening sends nothing
 * and starts no agent. Released when the view goes away.
 */
export function useThread(repoId: string, anchor: ThreadAnchor, threadId: string | null | undefined, onOpened?: (id: string) => void): AiThread | null {
  const [id, setId] = useState<string | null>(threadId ?? null)
  // The anchor only decides which conversation this is while the view has no id for one yet:
  // with an id, that is what is resumed. So it is left out of the key then, and a view whose
  // anchor settles once the conversation exists (the AI pane, after a composed action has
  // started) does not let go of the thread it is showing and open it again.
  const key = threadId ? '' : JSON.stringify(anchor)
  useEffect(() => {
    let live = true
    let held: string | null = null
    holdThread(repoId, anchor, threadId ?? undefined).then((t) => {
      if (!live) return releaseThread(t.id)
      held = t.id
      setId(t.id)
      if (t.id !== threadId) onOpened?.(t.id)
    }, (e) => reportError('Could not open the conversation', e))
    return () => {
      live = false
      if (held) releaseThread(held)
    }
    // The anchor by value: a new object for the same anchor is the same thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, key, threadId])
  return useThreads((s) => (id ? s.threads[id] ?? null : null))
}

/**
 * Send a message: the same questions as any AI request first (set up? agreed? logged in?), and
 * the secret scan's offer to redact. False when nothing was sent (the caller keeps the text).
 */
export async function sendMessage(threadId: string, text: string, context?: AiContextRef[]): Promise<boolean> {
  const thread = useThreads.getState().threads[threadId]
  if (!thread || !text.trim()) return false
  // The area's picker decides who answers; main moves the conversation if that changed.
  const target = areaTarget(areaOfAnchor(thread.anchor)) ?? undefined
  // Context chips are references; main reads git for them. The consent notice says so.
  const what = whatFor(thread.anchor) + (context?.length ? ', and the git output (messages, diffs, status) for the context chips you attached' : '')
  if (!(await ensureAi(what, target))) return false
  let redact = false
  for (let attempt = 0; ; attempt++) {
    try {
      // A conversation that opens with words of its own (the AI panel's, Ask's) sends the ones on screen.
      const kind = openingPromptKind(thread.anchor)
      const prompt = kind ? wordsFor(kind) : undefined
      const opts = { ...(redact ? { redact } : {}), ...(target ? { target } : {}), ...(prompt ? { prompt } : {}), ...(context?.length ? { context } : {}) }
      await api.aiThreadSend(threadId, text, Object.keys(opts).length ? opts : undefined)
      return true
    } catch (e) {
      const err = toUiError(e)
      if (err.code === 'ai-secrets' && !redact) {
        if (!(await askToRedact(err.message))) return false
        redact = true
        continue
      }
      if (err.code === AI_AUTH_REQUIRED && attempt === 0) {
        if (!(await askLogin(thread.repoId, target))) return false
        continue
      }
      reportError('Could not send', e)
      return false
    }
  }
}

/**
 * Delete a kept conversation (the AI panel's history). Main ends its session, so every view
 * that holds it must let go: each feature's reference is cleared, and a view still on screen
 * then opens a fresh conversation about the same thing instead of sending into a closed one.
 */
export async function deleteThread(repoId: string, threadId: string): Promise<void> {
  await api.aiThreadDelete(repoId, threadId)
  const mine = <T extends { threadId?: string | null }>(x: T | null): T | null => (x?.threadId === threadId ? { ...x, threadId: null } : x)
  updateRepo(repoId, (v) => ({
    review: mine(v.review),
    walkthrough: mine(v.walkthrough),
    impact: mine(v.impact),
    ask: v.ask?.threadId === threadId ? null : v.ask,
    chat: v.chat.threadId === threadId ? { threadId: null, nonce: Date.now() } : v.chat,
  }))
  useAi.setState((s) => (s.recompose?.threadId === threadId ? { recompose: { ...s.recompose, threadId: undefined } } : s))
  forgetExplanationThread(repoId, threadId)
  // A commit's question list shows saved Ask threads.
  updateRepo(repoId, { askThreads: await api.askThreads(repoId) })
}

export function stopThread(threadId: string): void {
  void api.aiThreadCancel(threadId)
}

/**
 * The AI pane's key (Mod+Shift+A): when the pane is not on screen, show it and put the cursor in
 * its message box; when it is on screen and the focus is already inside it, hide it; on screen without the focus, just focus it. (Which slot it lives in, and
 * whether that slot is open, is the layout's business: packages/shared/src/layout.ts.)
 */
export function toggleChat(): void {
  const layout = setting('layout')
  if (isPaneVisible(layout, 'ai')) {
    // On screen: the key hides it when the user is already in it, and otherwise takes them there.
    if (focusInAiPane()) return saveLayout(hidePane(layout, 'ai'))
    return focusAiComposer()
  }
  saveLayout(showPane(layout, 'ai'))
  focusAiComposer()
}

/** Start a new conversation in the AI pane. */
export function newChat(repoId: string): void {
  updateRepo(repoId, { chat: { threadId: null, nonce: Date.now() } })
  showAiPane()
  focusAiComposer()
}

/** An answer arrived in the thread the AI pane shows: a collapsed slot opens so it can be seen. */
function revealAnswer(repoId: string, threadId: string): void {
  if (useStore.getState().repos[repoId]?.chat.threadId !== threadId) return
  const layout = setting('layout')
  const slot = slotOf(layout, 'ai')
  if (slot && layout[slot].collapsed && layout[slot].active === 'ai') saveLayout(setCollapsed(layout, slot, false))
}
