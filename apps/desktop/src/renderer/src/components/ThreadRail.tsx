import type { ThreadAnchor } from '@gitgoose/shared'
import clsx from 'clsx'
import { MessagesSquare, X } from 'lucide-react'
import { toggleRail, useRails, useThread } from '../lib/thread'
import { Thread } from './Thread'
import { Button, Spinner } from './ui'

/**
 * The chat beside an AI result (review, walkthrough, impact, recompose): the thread the feature
 * started when there is one, else a new one about the same anchor. Opening it sends nothing.
 */
export function ThreadRail({ repoId, anchor, threadId, onThread, kind, hint, className }: {
  repoId: string
  anchor: ThreadAnchor
  threadId: string | null | undefined
  onThread: (id: string) => void
  /** Which view this is (the rail's open state and test id). */
  kind: string
  hint: string
  className?: string
}) {
  const thread = useThread(repoId, anchor, threadId, onThread)
  return (
    <aside className={clsx('flex min-h-0 w-80 shrink-0 flex-col border-l border-line bg-panel', className)} data-testid={`${kind}-chat`}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
        <MessagesSquare size={13} className="text-accent" />
        <span className="flex-1 font-semibold">Chat</span>
        <button onClick={() => toggleRail(kind)} title="Hide the chat" aria-label="Hide the chat" className="rounded p-1 text-muted hover:bg-hover hover:text-fg"><X size={13} /></button>
      </div>
      {thread ? <Thread thread={thread} repoId={repoId} hint={hint} className="flex-1" /> : <div className="flex flex-1 items-center justify-center"><Spinner /></div>}
    </aside>
  )
}

/** The header button that shows or hides a view's chat rail. */
export function RailToggle({ kind }: { kind: string }) {
  const open = useRails((s) => !!s[kind])
  return (
    <Button variant={open ? 'default' : 'ghost'} onClick={() => toggleRail(kind)} data-testid={`${kind}-chat-toggle`} title={open ? 'Hide the chat' : 'Chat about this with the AI'}>
      <MessagesSquare size={13} /> Chat
    </Button>
  )
}

export function useRailOpen(kind: string): boolean {
  return useRails((s) => !!s[kind])
}
