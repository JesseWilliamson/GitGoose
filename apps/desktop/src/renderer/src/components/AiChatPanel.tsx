import { runningTurn, type AiThread } from '@gitgoose/shared'
import { Check, History, MessagesSquare, Plus, Trash2, X } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { clearDropped, useChips } from '../lib/aiContext'
import { modName } from '../lib/keys'
import { reportError, updateRepo, type RepoView } from '../lib/store'
import { deleteThread, newChat, toggleChat, useThread, useThreads } from '../lib/thread'
import { ANCHOR_KIND, groupThreadsByDay } from '../lib/threadHistory'
import { AiContextBar } from './AiContextBar'
import { Thread } from './Thread'
import { DM, Spinner } from './ui'

const FREE = { kind: 'free' } as const
/** Items shown in the history list (most recently used first, grouped by day). */
const HISTORY_ITEMS = 40

/**
 * The AI panel (Mod+Shift+A): a conversation about the repository, and the one place everything
 * AI shows up. Its first message goes with the repository's name and HEAD, plus the context
 * chips above the composer (the selection, and whatever was dropped on the panel); the agent can
 * ask to read files. It also shows answers that have no view of their own (why an action
 * failed, the conflict agent's note), and every kept conversation of the repository is under the
 * clock button, grouped by day, so an earlier explanation or review can be reopened and followed
 * up here. A review, walkthrough or recompose started from the action row is one of them at once.
 *
 * Dropping works through the window's drag handling (DragBadge): this root is a drop target of
 * kind 'ai', and a drop becomes a chip (lib/aiContext.ts). Chips are references; main reads git.
 */
export function AiChatPanel({ view }: { view: RepoView }) {
  const thread = useThread(view.id, FREE, view.chat.threadId, (id) => updateRepo(view.id, (v) => ({ chat: { ...v.chat, threadId: id } })))
  const [history, setHistory] = useState<AiThread[] | null>(null)
  const chips = useChips(view)
  const [historyOpen, setHistoryOpen] = useState(false)
  // Open, the list follows the repository: a review started from the action row (or by a menu)
  // is saved when its request starts, and shows up here without reopening.
  useEffect(() => {
    if (!historyOpen) return
    const load = () => void api.aiThreads(view.id).then(setHistory, () => {})
    load()
    const timer = setInterval(load, 1500)
    return () => clearInterval(timer)
  }, [historyOpen, view.id])
  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-[min(420px,90%)] flex-col border-l border-line bg-panel shadow-xl" data-testid="ai-chat-panel" data-drop-target='{"kind":"ai"}' key={view.chat.nonce}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-3 text-xs">
        <MessagesSquare size={14} className="text-accent" />
        <span className="min-w-0 flex-1 truncate font-semibold">AI · {thread?.title || view.snapshot.name}</span>
        <button onClick={() => newChat(view.id)} title="New conversation" aria-label="New conversation" className="rounded p-1 text-muted hover:bg-hover hover:text-fg" data-testid="ai-chat-new"><Plus size={13} /></button>
        <DropdownMenu.Root onOpenChange={setHistoryOpen}>
          <DropdownMenu.Trigger asChild>
            <button title="Earlier conversations" aria-label="Earlier conversations" className="rounded p-1 text-muted hover:bg-hover hover:text-fg" data-testid="ai-chat-history"><History size={13} /></button>
          </DropdownMenu.Trigger>
          <DM.Content align="end">
            <HistoryList history={history} currentId={thread?.id} onOpen={(id) => updateRepo(view.id, (v) => ({ chat: { ...v.chat, threadId: id } }))} />
            {!!thread?.turns.length && (
              <>
                <DM.Separator />
                <DM.Item onSelect={() => {
                  newChat(view.id)
                  // Every view that shows it lets go too (a review's rail, an explanation, Ask, …).
                  void deleteThread(view.id, thread.id).catch((e) => reportError('Could not delete the conversation', e))
                }}><Trash2 size={12} /> Delete this conversation</DM.Item>
              </>
            )}
          </DM.Content>
        </DropdownMenu.Root>
        <button onClick={() => toggleChat(view.id)} title={`Close (${modName()}+Shift+A)`} aria-label="Close the AI panel" className="rounded p-1 text-muted hover:bg-hover hover:text-fg"><X size={13} /></button>
      </div>
      {thread
        ? <Thread thread={thread} repoId={view.id} className="flex-1" placeholder="Ask about this repository (Enter sends, Shift+Enter for a new line)"
            hint="The first message sends the repository's name and current commit, and what is attached below; the agent asks before reading anything else."
            above={<AiContextBar view={view} chips={chips} />} context={chips.map((c) => c.ref)} onSent={() => clearDropped(view.id)} />
        : <div className="flex flex-1 items-center justify-center"><Spinner /></div>}
    </div>
  )
}

/** The conversations of the repository: by day, each with what it is about, a spinner while it answers, a check on the open one. */
function HistoryList({ history, currentId, onOpen }: { history: AiThread[] | null; currentId?: string; onOpen: (id: string) => void }) {
  // A conversation on screen is fresher than its saved copy.
  const live = useThreads((s) => s.threads)
  const groups = useMemo(() => groupThreadsByDay((history ?? []).slice(0, HISTORY_ITEMS)), [history])
  if (!history) return <DM.Label>Loading…</DM.Label>
  if (!history.length) return <DM.Label>No earlier conversations</DM.Label>
  return (
    <>
      {groups.map((g) => (
        <div key={g.label} data-testid="ai-chat-history-day">
          <DM.Label>{g.label}</DM.Label>
          {g.threads.map((saved) => {
            const t = live[saved.id] ?? saved
            const running = !!runningTurn(t)
            return (
              <DM.Item key={t.id} onSelect={() => onOpen(t.id)}>
                <span className="flex w-80 max-w-full items-center gap-2" data-testid="ai-chat-history-item" data-kind={t.anchor.kind} data-running={running || undefined} data-current={t.id === currentId || undefined}>
                  <span className="w-20 shrink-0 text-[11px] text-faint">{ANCHOR_KIND[t.anchor.kind]}</span>
                  <span className="min-w-0 flex-1 truncate">{t.title || 'Untitled'}</span>
                  {running && <span data-testid="ai-chat-history-running" title="Answering now"><Spinner /></span>}
                  {t.id === currentId && <Check size={12} className="shrink-0 text-accent" aria-label="Open now" />}
                </span>
              </DM.Item>
            )
          })}
        </div>
      ))}
    </>
  )
}
