import { MessageCircleQuestion, X } from 'lucide-react'
import { closeAsk } from '../lib/ask'
import { updateRepo, type RepoView } from '../lib/store'
import { useThread } from '../lib/thread'
import { Thread } from './Thread'
import { Spinner } from './ui'

/**
 * A thread about some lines, docked under the diff: the lines, the conversation, a question
 * box. It is an AI thread with an ask anchor: the first question goes with the function around
 * the lines, the definitions they use and their history (see Repo.askContext); follow-ups go to
 * the same agent session. The thread is saved with the commit it was asked at.
 */
export function AskPanel({ repoId, ask }: { repoId: string; ask: NonNullable<RepoView['ask']> }) {
  const thread = useThread(repoId, ask.anchor, ask.threadId, (id) => updateRepo(repoId, (v) => (v.ask ? { ask: { ...v.ask, threadId: id } } : {})))
  const [start, end] = ask.anchor.lines
  return (
    <div className="flex h-[45%] min-h-48 shrink-0 flex-col border-t border-line bg-panel" data-testid="ask-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
        <MessageCircleQuestion size={13} className="text-accent" />
        <span className="font-semibold">Ask</span>
        <span className="truncate text-muted">{ask.path}:{start}{end !== start ? `-${end}` : ''} · {ask.anchor.rev === 'worktree' ? 'working tree' : ask.anchor.rev.slice(0, 7)}</span>
        <span className="flex-1" />
        <button onClick={() => closeAsk(repoId)} title="Close" aria-label="Close ask" className="rounded p-1 text-muted hover:bg-hover hover:text-fg"><X size={13} /></button>
      </div>
      {ask.anchor.code && <pre className="mx-3 mt-2 max-h-28 shrink-0 overflow-auto rounded border border-line bg-bg p-2 font-mono text-[12px] text-muted">{ask.anchor.code}</pre>}
      {thread
        ? <Thread thread={thread} repoId={repoId} className="min-h-0 flex-1" testids={{ root: 'ask-thread', input: 'ask-input', send: 'ask-send', user: 'ask-question', agent: 'ask-answer' }}
            placeholder="Ask about these lines (Enter sends, Shift+Enter for a new line)"
            hint="Ask what these lines do, why they are like this, or what would break if they changed." />
        : <div className="flex flex-1 items-center justify-center"><Spinner /></div>}
    </div>
  )
}
