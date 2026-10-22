import type { AiThread, ThreadAnchor } from '@gitgoose/shared'
import { History, MessagesSquare, Plus, Trash2, X } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useState } from 'react'
import { api } from '../lib/api'
import { modName } from '../lib/keys'
import { reportError, updateRepo, type RepoView } from '../lib/store'
import { deleteThread, newChat, toggleChat, useThread } from '../lib/thread'
import { Thread } from './Thread'
import { DM, Spinner } from './ui'

const FREE = { kind: 'free' } as const

/** What each kind of conversation is, in the history list. */
const KIND: Record<ThreadAnchor['kind'], string> = {
  free: 'Chat',
  review: 'Review',
  changestack: 'Review',
  explain: 'Explain',
  recompose: 'Recompose',
  walkthrough: 'Walkthrough',
  impact: 'Impact',
  ask: 'Ask',
  error: 'Error',
  conflict: 'Conflict',
  task: 'Task',
}

/**
 * The AI panel (Mod+Shift+A): a conversation about the repository with no anchor. Its first
 * message goes with only the repository's name and HEAD; the agent can ask to read files.
 * It also shows answers that have no view of their own (why an action failed, the conflict
 * agent's note), and every kept conversation of the repository is under the clock button, so
 * an earlier explanation or review can be reopened and followed up here.
 */
export function AiChatPanel({ view }: { view: RepoView }) {
  const thread = useThread(view.id, FREE, view.chat.threadId, (id) => updateRepo(view.id, (v) => ({ chat: { ...v.chat, threadId: id } })))
  const [history, setHistory] = useState<AiThread[] | null>(null)
  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-[min(420px,90%)] flex-col border-l border-line bg-panel shadow-xl" data-testid="ai-chat-panel" key={view.chat.nonce}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-3 text-xs">
        <MessagesSquare size={14} className="text-accent" />
        <span className="min-w-0 flex-1 truncate font-semibold">AI · {thread?.title || view.snapshot.name}</span>
        <button onClick={() => newChat(view.id)} title="New conversation" aria-label="New conversation" className="rounded p-1 text-muted hover:bg-hover hover:text-fg" data-testid="ai-chat-new"><Plus size={13} /></button>
        <DropdownMenu.Root onOpenChange={(o) => { if (o) void api.aiThreads(view.id).then(setHistory) }}>
          <DropdownMenu.Trigger asChild>
            <button title="Earlier conversations" aria-label="Earlier conversations" className="rounded p-1 text-muted hover:bg-hover hover:text-fg" data-testid="ai-chat-history"><History size={13} /></button>
          </DropdownMenu.Trigger>
          <DM.Content align="end">
            {!history ? <DM.Label>Loading…</DM.Label> : !history.length ? <DM.Label>No earlier conversations</DM.Label> : history.slice(0, 20).map((t) => (
              <DM.Item key={t.id} onSelect={() => updateRepo(view.id, (v) => ({ chat: { ...v.chat, threadId: t.id } }))}>
                <span className="flex max-w-80 items-baseline gap-2" data-testid="ai-chat-history-item">
                  <span className="w-20 shrink-0 text-[11px] text-faint">{KIND[t.anchor.kind]}</span>
                  <span className="min-w-0 truncate">{t.title || 'Untitled'}</span>
                </span>
              </DM.Item>
            ))}
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
            hint={`Ask anything about ${view.snapshot.name}. The first message goes with the repository's name and current commit only; the agent asks before reading anything.`} />
        : <div className="flex flex-1 items-center justify-center"><Spinner /></div>}
    </div>
  )
}
