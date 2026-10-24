import { canRestore, centerOf, runningTurn, type AiThread } from '@gitgoose/shared'
import clsx from 'clsx'
import { Check, Clock, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { reportError, updateRepo, type RepoView } from '../lib/store'
import { deleteThread, newChat, useThreads } from '../lib/thread'
import { openSavedThread } from '../lib/threadRestore'
import { ANCHOR_KIND, groupThreadsByDay } from '../lib/threadHistory'
import { Button, Spinner } from './ui'

/** Conversations shown (most recently used first, grouped by day). */
const HISTORY_ITEMS = 100

/**
 * Every conversation of this repository, in the AI pane itself rather than in a dropdown over
 * it. The log of what the AI has been asked is one of the two things the pane is for, and a
 * menu that closes the moment you look away is a poor place for a list you read, scroll and
 * pick from. It takes the pane while it is open; picking a conversation hands the pane back.
 *
 * A conversation that owns a result (a review, a plan, a walkthrough, an impact) says so, and
 * one whose result no longer describes the repository says *that* instead, with the reason on
 * hover. See lib/threadRestore.ts and shared/src/basis.ts.
 */
export function AiChatHistory({ view }: { view: RepoView }) {
  const [history, setHistory] = useState<AiThread[] | null>(null)
  /** Thread id to the sentence saying why its result no longer describes the repository. */
  const [stale, setStale] = useState<Record<string, string>>({})
  const live = useThreads((s) => s.threads)
  const close = () => updateRepo(view.id, (v) => ({ chat: { ...v.chat, history: false } }))

  // The list follows the repository while it is open: a review started from a menu is saved as
  // its request begins, so it appears here with its spinner without anything being reopened.
  useEffect(() => {
    const load = () => {
      void api.aiThreads(view.id).then(setHistory, () => {})
      void api.aiThreadsStale(view.id).then(setStale, () => {})
    }
    load()
    const timer = setInterval(load, 1500)
    return () => clearInterval(timer)
  }, [view.id])

  const groups = useMemo(() => groupThreadsByDay((history ?? []).slice(0, HISTORY_ITEMS)), [history])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ai-chat-history-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <span className="flex-1 font-semibold">Conversations</span>
        <Button size="sm" variant="ghost" onClick={() => { close(); newChat(view.id) }} data-testid="ai-history-new"><Plus size={12} /> New</Button>
        <Button size="sm" variant="ghost" onClick={close} data-testid="ai-history-close">Done</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {!history && <p className="p-3 text-xs text-muted-foreground">Loading…</p>}
        {history && !history.length && <p className="p-3 text-xs text-muted-foreground">Nothing yet. Everything you ask the AI shows up here.</p>}
        {groups.map((g) => (
          <div key={g.label} data-testid="ai-chat-history-day">
            <div className="px-1 pt-2 pb-0.5 text-2xs font-semibold text-muted-foreground uppercase">{g.label}</div>
            {g.threads.map((saved) => (
              <Row key={saved.id} view={view} saved={saved} thread={live[saved.id] ?? saved} why={stale[saved.id] ?? ''} onOpen={close} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function Row({ view, saved, thread, why, onOpen }: { view: RepoView; saved: AiThread; thread: AiThread; why: string; onOpen: () => void }) {
  const running = !!runningTurn(thread)
  const restores = canRestore(thread, why)
  const current = thread.id === view.chat.threadId
  return (
    <div className={clsx('group flex w-full items-start gap-2 rounded px-1 py-1 text-xs hover:bg-accent', current && 'bg-accent/60')}
      data-testid="ai-chat-history-item" data-kind={thread.anchor.kind} data-running={running || undefined} data-current={current || undefined} data-stale={why ? 'true' : undefined}>
      <button className="min-w-0 flex-1 text-left" onClick={() => { onOpen(); void openSavedThread(view.id, saved, why) }}>
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">{thread.title || 'Untitled'}</span>
          {running && <span data-testid="ai-chat-history-running" title="Answering now"><Spinner /></span>}
          {current && <Check size={11} className="shrink-0 text-primary" aria-label="Open now" />}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-2xs text-hint">
          <span>{ANCHOR_KIND[thread.anchor.kind]}</span>
          <span>·</span>
          <span>{when(thread.updatedAt)}</span>
          {why ? (
            <span className="flex items-center gap-1 rounded-sm bg-warn/15 px-1 text-warn" data-testid="ai-chat-history-stale"
              title={`${why} The conversation is still here, but its result is not shown again.`}><Clock size={9} /> out of date</span>
          ) : restores ? <span className="text-muted-foreground">opens its {centerOf(thread.anchor)}</span> : null}
        </span>
      </button>
      <button onClick={() => void remove(view, thread.id)} aria-label="Delete this conversation" title="Delete this conversation"
        data-testid="ai-chat-history-delete" className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background hover:text-destructive">
        <Trash2 size={11} />
      </button>
    </div>
  )
}

async function remove(view: RepoView, threadId: string): Promise<void> {
  // The list stays open: deleting one of forty is not a reason to leave it. Every view that
  // shows the conversation lets go too (a result's Chat button, an explanation, Ask, …).
  if (view.chat.threadId === threadId) updateRepo(view.id, { chat: { threadId: null, nonce: Date.now(), history: true } })
  await deleteThread(view.id, threadId).catch((e) => reportError('Could not delete the conversation', e))
}

/** "14:32" today, "Yesterday", else the date: the day heading says the rest. */
function when(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
