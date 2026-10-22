import { AI_AUTH_REQUIRED, reduceThread, type AiThread, type AiUpdate, type ThreadAnchor } from '@gitgoose/shared'
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { areaOfAnchor, areaTarget, askLogin, askToRedact, ensureAi, whatFor } from './ai'
import { api, toUiError } from './api'
import { reportError, updateRepo } from './store'

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
  const t = useThreads.getState().threads[e.threadId]
  if (!t) return
  const next = reduceThread(t, e.requestId, e.update)
  if (next !== t) useThreads.setState((s) => ({ threads: { ...s.threads, [e.threadId]: next } }))
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
  const key = JSON.stringify(anchor)
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
export async function sendMessage(threadId: string, text: string): Promise<boolean> {
  const thread = useThreads.getState().threads[threadId]
  if (!thread || !text.trim()) return false
  // The area's picker decides who answers; main moves the conversation if that changed.
  const target = areaTarget(areaOfAnchor(thread.anchor)) ?? undefined
  if (!(await ensureAi(whatFor(thread.anchor), target))) return false
  let redact = false
  for (let attempt = 0; ; attempt++) {
    try {
      const opts = { ...(redact ? { redact } : {}), ...(target ? { target } : {}) }
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

export function stopThread(threadId: string): void {
  void api.aiThreadCancel(threadId)
}

/** The free-standing AI panel (Mod+Shift+A): open or close it for the active repository. */
export function toggleChat(repoId: string): void {
  updateRepo(repoId, (v) => ({ chat: { ...v.chat, open: !v.chat.open } }))
}

/** Start a new conversation in the AI panel. */
export function newChat(repoId: string): void {
  updateRepo(repoId, { chat: { open: true, threadId: null, nonce: Date.now() } })
}

/** Which chat rails are open, per view kind (remembered while the app runs). */
export const useRails = create<Record<string, boolean>>(() => ({}))

export function toggleRail(kind: string): void {
  useRails.setState((s) => ({ [kind]: !s[kind] }))
}
