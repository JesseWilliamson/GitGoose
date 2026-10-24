import type { AiThread } from '@gitgoose/shared'
import { Clock, History, Plus, Sparkles, X } from 'lucide-react'
import { useEffect } from 'react'
import type { AiAction } from '../lib/aiActions'
import { clearDropped, markSent, useChips, useSentContext } from '../lib/aiContext'
import { updateRepo, type RepoView } from '../lib/store'
import { newChat, useThread } from '../lib/thread'
import { useStaleReason } from '../lib/threadRestore'
import { actionForAnchor, composeAction } from '../lib/aiActions'
import { AiActionsMenu, AiContextChips } from './AiContextBar'
import { AiChatHistory } from './AiChatHistory'
import { Thread } from './Thread'
import { Spinner, WithTooltip } from './ui'

const FREE = { kind: 'free' } as const
const NONE: string[] = []

/**
 * The AI pane (Mod+Shift+A; ADR-010): a conversation about the repository, and the one place
 * everything AI happens. Every AI action is a chat here (lib/aiActions.ts): a menu item writes
 * its request into the box and leaves it for the user to read, change and send, so nothing is
 * ever sent by a click on a menu. Its first message goes with the repository's name and HEAD,
 * plus the context chips in the composer (the selection, and whatever was dropped on the
 * panel); the agent can ask to read files.
 *
 * It also shows answers that have no view of their own (why an action failed, the conflict
 * agent's note), and every kept conversation of the repository is one button away — the history
 * takes the pane itself (AiChatHistory), where there is room to read it. Reopening one brings
 * its result back to the middle of the window while that result still describes the repository,
 * and says so plainly when it does not (lib/threadRestore.ts, shared/src/basis.ts).
 *
 * The pane has no header of its own: its slot's tab strip already says "AI", and the two buttons
 * a header would have held (New, History) are the strip's right end while this tab is in front
 * (AiChatActions, rendered by Pane.tsx). One title, not two.
 *
 * Dropping works through the window's drag handling (DragBadge): this root is a drop target of
 * kind 'ai', and a drop becomes a chip (lib/aiContext.ts). Chips are references; main reads git.
 */
export function AiChatPanel({ view }: { view: RepoView }) {
  const pending = view.chat.pending
  const thread = useThread(view.id, pending?.anchor ?? FREE, view.chat.threadId, (id) => updateRepo(view.id, (v) => ({ chat: { ...v.chat, threadId: id } })))
  const chips = useChips(view)
  // Chips whose context this conversation already has are shown but not sent again.
  const sentKeys = useSentContext((s) => (thread ? s[thread.id] : undefined)) ?? NONE
  const unsent = chips.filter((c) => !sentKeys.includes(c.key))
  const dropPending = () => updateRepo(view.id, (v) => ({ chat: { ...v.chat, pending: undefined } }))
  // Its answer is about commits that are no longer there: say so, above the conversation.
  const stale = useStaleReason(view.id, thread?.id)
  // The action's turn has started: the pill and the seeded words have done their job.
  const started = !!pending && !!thread?.turns.length
  useEffect(() => {
    if (started) dropPending()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started])

  if (view.chat.history) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="ai-chat-panel">
        <AiChatHistory view={view} />
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ai-chat-panel" data-drop-target='{"kind":"ai"}' key={view.chat.nonce}>
      {thread
        ? <Thread thread={thread} repoId={view.id} className="flex-1" placeholder="Ask about this repository (Enter sends, Shift+Enter for a new line)"
            hint={pending ? 'Read it, change it if you like, then press Enter.' : 'Ask about this repository, or drop commits, branches and files here'}
            hintTitle="The first message sends the repository's name and current commit, and what is attached; the agent asks before reading anything else."
            // While an action is waiting, the chips are not part of it (the feature builds its
            // own context from its scope), so they are not shown promising to be sent.
            above={pending
              ? <PendingAction action={pending} onRemove={dropPending} />
              : <>
                  {!!stale && thread && <OutOfDate repoId={view.id} thread={thread} why={stale} />}
                  <AiContextChips view={view} chips={chips} sentKeys={sentKeys} />
                </>}
            actions={<AiActionsMenu view={view} chips={chips} />}
            context={pending ? undefined : unsent.map((c) => c.ref)}
            seed={pending?.prompt ?? ''} seedKey={pending ? `${thread.id}:${pending.name}:${pending.label}` : thread.id}
            // A composed action runs its feature instead of sending an ordinary message, and
            // keeps the words in the box until the turn really starts: a refusal (not set up,
            // consent declined) must not throw away what the user was about to ask.
            submit={pending ? async (text) => { pending.run(view.id, thread.id, text); return false } : undefined}
            onSent={() => {
              markSent(thread.id, unsent.map((c) => c.key))
              clearDropped(view.id)
            }} />
        : <div className="flex flex-1 items-center justify-center"><Spinner /></div>}
    </div>
  )
}

/**
 * The conversation's answer is about a repository that has moved on. It stays open to read and
 * to follow up; what it does not do is quietly put a stale review back on screen, so the one
 * thing offered here is asking the question again about the repository as it is now.
 */
function OutOfDate({ repoId, thread, why }: { repoId: string; thread: AiThread; why: string }) {
  const again = actionForAnchor(thread.anchor)
  return (
    <div className="flex items-start gap-1.5 border-b border-border bg-warn/10 px-2 py-1.5 text-2xs text-warn" data-testid="ai-thread-stale">
      <Clock size={11} className="mt-px shrink-0" />
      <span className="min-w-0 flex-1">
        <b>Out of date.</b> {why} What it says is kept as it was said, and is not shown as a result any more.
      </span>
      {again && (
        <button onClick={() => composeAction(repoId, again)} data-testid="ai-thread-stale-again"
          className="shrink-0 rounded-sm px-1 font-medium underline-offset-2 hover:underline">Ask again</button>
      )}
    </div>
  )
}

/** What Enter will do: the action a menu composed, with the way out beside it. */
function PendingAction({ action, onRemove }: { action: AiAction; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 text-2xs" data-testid="ai-pending-action" data-action={action.name}>
      <Sparkles size={11} className="shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate font-medium">{action.label}</span>
      <span className="shrink-0 text-hint">Enter sends it</span>
      <button onClick={onRemove} aria-label="Just chat instead" title="Just chat instead of running this"
        className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" data-testid="ai-pending-remove"><X size={10} /></button>
    </div>
  )
}

/**
 * New conversation and the history, as small icon buttons: the right end of the slot's tab strip
 * while the AI tab is in front. History is a toggle, not a menu: the list it opens takes the
 * pane (AiChatHistory), so the same button brings the conversation back.
 */
export function AiChatActions({ view }: { view: RepoView }) {
  const open = !!view.chat.history
  const button = 'flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground data-[open]:bg-accent data-[open]:text-foreground'
  return (
    <div className="flex items-center gap-0.5">
      <WithTooltip text="New conversation" side="bottom">
        <button onClick={() => newChat(view.id)} aria-label="New conversation" className={button} data-testid="ai-chat-new"><Plus size={14} /></button>
      </WithTooltip>
      <WithTooltip text={open ? 'Back to the conversation' : 'Earlier conversations'} side="bottom">
        <button aria-label="Earlier conversations" className={button} data-open={open || undefined} data-testid="ai-chat-history"
          onClick={() => updateRepo(view.id, (v) => ({ chat: { ...v.chat, history: !v.chat.history } }))}><History size={14} /></button>
      </WithTooltip>
    </div>
  )
}
