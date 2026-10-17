import type { AskThread } from '@gitsquid/shared'
import { MessageCircleQuestion, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { askInThread, closeAsk } from '../lib/ask'
import { modName } from '../lib/keys'
import { Button } from './ui'

/**
 * A thread about some lines, docked under the diff: the lines, the answers, a question box.
 * Answers are grounded in the function around the lines, the definitions they use and their
 * history (see Repo.askContext); the thread is saved with the commit it was asked at.
 */
export function AskPanel({ repoId, thread: initial }: { repoId: string; thread: AskThread }) {
  const [thread, setThread] = useState(initial)
  const [question, setQuestion] = useState('')
  const busy = thread.messages.at(-1)?.role === 'ai' && thread.messages.at(-1)?.text === '' || false
  const [asking, setAsking] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setThread(initial)
  }, [initial.id])
  // A block body on purpose: scrollIntoView returns a Promise in current Chromium, and an effect
  // that returns anything but a function (its cleanup) crashes React on the next update.
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' })
  }, [thread])
  const send = async () => {
    const q = question.trim()
    if (!q || asking) return
    setQuestion('')
    setAsking(true)
    await askInThread(repoId, thread, q, setThread)
    setAsking(false)
  }
  return (
    <div className="flex h-[45%] min-h-48 shrink-0 flex-col border-t border-line bg-panel" data-testid="ask-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
        <MessageCircleQuestion size={13} className="text-accent" />
        <span className="font-semibold">Ask</span>
        <span className="truncate text-muted">{thread.path}:{thread.startLine}{thread.endLine !== thread.startLine ? `-${thread.endLine}` : ''} · {thread.rev === 'worktree' ? 'working tree' : thread.rev.slice(0, 7)}</span>
        <span className="flex-1" />
        <button onClick={() => closeAsk(repoId)} title="Close" aria-label="Close ask" className="rounded p-1 text-muted hover:bg-hover hover:text-fg"><X size={13} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[13px]">
        <pre className="mb-2 max-h-28 overflow-auto rounded border border-line bg-bg p-2 font-mono text-[12px] text-muted">{thread.code}</pre>
        {thread.messages.map((m, i) => (
          <div key={i} data-testid={m.role === 'user' ? 'ask-question' : 'ask-answer'}
            className={m.role === 'user' ? 'mt-3 font-semibold' : 'selectable mt-1 whitespace-pre-wrap text-fg/90'}>
            {m.text || (asking ? '…' : '')}
          </div>
        ))}
        {!thread.messages.length && <p className="text-xs text-faint">Ask what these lines do, why they are like this, or what would break if they changed.</p>}
        <div ref={end} />
      </div>
      <div className="flex gap-2 border-t border-line p-2">
        <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} placeholder={`Ask about these lines (${modName()}+Enter)`} data-testid="ask-input"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() } }}
          className="min-w-0 flex-1 resize-none rounded-md border border-line bg-bg px-2 py-1 text-[13px] outline-none focus:border-accent" />
        <Button variant="primary" disabled={!question.trim() || asking || busy} onClick={() => void send()} data-testid="ask-send">Ask</Button>
      </div>
    </div>
  )
}
