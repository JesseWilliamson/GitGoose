import type { AiArtifactResult, AiBlock, AiPermissionAsk, AiPlanEntry, AiThread, AiToolCall, AiTurn, ArtifactKind, PermissionAnswer } from '@gitgoose/shared'
import { runningTurn } from '@gitgoose/shared'
import clsx from 'clsx'
import { Brain, Check, ChevronRight, Circle, CircleAlert, CircleDot, FileDiff, Hammer, RotateCcw, Send, ShieldQuestion, Sparkles, Square } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { applyArtifact } from '../lib/artifacts'
import { sendMessage, stopThread } from '../lib/thread'
import { Markdown } from './Markdown'
import { SequenceSvg } from './SequenceSvg'
import { Button, Spinner } from './ui'

/**
 * A conversation with the agent: its turns, and a box to write the next one. Used under every
 * AI result (review, explain, recompose, walkthrough, impact), by Ask, and by the AI panel.
 *
 * The thread itself is lib/thread.ts's copy, folded from main's events; this only draws it.
 * An agent turn is a list of blocks in the order they happened: text (Markdown), thoughts
 * (folded), tool calls with their input and diffs, the agent's plan, permission questions
 * (answered right here), and artifacts (structured results, checked by main, applied by the
 * user). A feature's own first exchange (the review request and its JSON) is one line: the
 * view around the thread already shows that result.
 */

export interface ThreadTestIds {
  root?: string
  input?: string
  send?: string
  user?: string
  agent?: string
}

export function Thread({ thread, repoId, testids = {}, placeholder, hint, hideFeature, className }: {
  thread: AiThread
  repoId: string
  testids?: ThreadTestIds
  placeholder?: string
  /** Shown while the thread has no turns. */
  hint?: string
  /** Leave the feature's own exchange out entirely (the Explain box shows the answer above). */
  hideFeature?: boolean
  className?: string
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const running = runningTurn(thread)
  const last = thread.turns.at(-1)
  const turns = hideFeature ? thread.turns.filter((t) => !t.feature) : thread.turns
  // Follow the answer as it streams. A block body: scrollIntoView returns a Promise in current
  // Chromium, and an effect that returns anything but a cleanup function crashes React.
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'nearest' })
  }, [thread.turns])

  const send = async (message = text) => {
    if (!message.trim() || sending || running) return
    setSending(true)
    const ok = await sendMessage(thread.id, message)
    setSending(false)
    if (ok && message === text) setText('')
  }
  // Retry: the last message again, as a new turn (the failed one stays, so the record is honest).
  const lastUser = [...thread.turns].reverse().find((t) => t.role === 'user' && !t.feature)
  const retry = last?.role === 'agent' && (last.status === 'error' || last.status === 'cancelled') && lastUser ? () => void send(textOf(lastUser)) : undefined

  return (
    <div className={clsx('flex min-h-0 flex-col', className)} data-testid={testids.root ?? 'thread'} data-thread={thread.id}>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[13px]" data-testid="thread-turns">
        {!turns.length && hint && <p className="text-xs text-faint">{hint}</p>}
        {turns.map((t) => (t.role === 'user'
          ? <UserTurn key={t.id} turn={t} testid={testids.user ?? 'thread-user'} />
          : <AgentTurn key={t.id} turn={t} thread={thread} repoId={repoId} testid={testids.agent ?? 'thread-agent'} retry={t === last ? retry : undefined} />))}
        <div ref={end} />
      </div>
      <div className="flex shrink-0 gap-2 border-t border-line p-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} data-testid={testids.input ?? 'thread-input'}
          placeholder={placeholder ?? 'Ask a follow-up (Enter sends, Shift+Enter for a new line)'}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          className="min-w-0 flex-1 resize-none rounded-md border border-line bg-bg px-2 py-1 text-[13px] outline-none focus:border-accent" />
        {running
          ? <Button onClick={() => stopThread(thread.id)} data-testid="thread-stop" title="Stop the answer"><Square size={12} /> Stop</Button>
          : <Button variant="primary" disabled={!text.trim() || sending} onClick={() => void send()} data-testid={testids.send ?? 'thread-send'} title="Send (Enter)"><Send size={12} /> Send</Button>}
      </div>
    </div>
  )
}

function textOf(turn: AiTurn): string {
  return turn.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

function UserTurn({ turn, testid }: { turn: AiTurn; testid: string }) {
  if (turn.feature) {
    return <div className="mt-2 flex items-center gap-1.5 text-xs text-faint" data-testid="thread-feature"><Sparkles size={11} /> {turn.feature}</div>
  }
  return <div className="selectable mt-3 font-semibold whitespace-pre-wrap" data-testid={testid}>{textOf(turn)}</div>
}

function AgentTurn({ turn, thread, repoId, testid, retry }: { turn: AiTurn; thread: AiThread; repoId: string; testid: string; retry?: () => void }) {
  const [raw, setRaw] = useState(false)
  if (turn.feature) {
    // The feature's own answer (JSON the view has already turned into its result).
    return (
      <div className="mt-0.5 text-xs text-faint" data-testid="thread-feature-answer">
        {turn.status === 'running' ? <span className="flex items-center gap-1.5"><Spinner /> Working on it…</span>
          : turn.status === 'error' ? <span className="text-del">{turn.error?.message}</span>
          : <>Answered; the result is shown here. <button className="hover:text-fg" onClick={() => setRaw(!raw)}>{raw ? 'Hide' : 'Show'} the raw answer</button></>}
        {raw && <pre className="selectable mt-1 max-h-48 overflow-auto rounded border border-line bg-bg p-2 font-mono text-[11px] whitespace-pre-wrap">{textOf(turn)}</pre>}
      </div>
    )
  }
  const empty = !turn.blocks.length
  return (
    <div className="mt-1">
      <div data-testid={testid} data-status={turn.status}>
        {turn.blocks.map((b, i) => <BlockView key={i} b={b} thread={thread} repoId={repoId} />)}
        {empty && turn.status === 'running' && <span className="flex items-center gap-2 text-muted"><Spinner /> Thinking…</span>}
      </div>
      {turn.status === 'cancelled' && <div className="mt-1 text-xs text-faint" data-testid="thread-stopped">Stopped.</div>}
      {turn.status === 'error' && <div className="mt-1 flex items-start gap-1 text-xs text-del whitespace-pre-wrap" data-testid="thread-error"><CircleAlert size={12} className="mt-px shrink-0" /> {turn.error?.message}</div>}
      {retry && <Button size="sm" variant="ghost" className="mt-1" onClick={retry} data-testid="thread-retry"><RotateCcw size={11} /> Try again</Button>}
    </div>
  )
}

function BlockView({ b, thread, repoId }: { b: AiBlock; thread: AiThread; repoId: string }) {
  switch (b.type) {
    case 'text': return <Markdown text={b.text} />
    case 'thought': return <Thought text={b.text} />
    case 'tool': return <ToolCard tool={b.tool} />
    case 'plan': return <PlanCard entries={b.entries} />
    case 'permission': return <PermissionCard p={b.permission} />
    case 'artifact': return <ArtifactCard threadId={thread.id} repoId={repoId} kind={b.artifact} json={b.json} />
  }
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1 text-xs text-muted" data-testid="thread-thought" data-open={open || undefined}>
      <button className="flex items-center gap-1 hover:text-fg" onClick={() => setOpen(!open)}>
        <ChevronRight size={11} className={clsx('transition-transform', open && 'rotate-90')} /><Brain size={11} /> Thinking
      </button>
      {open && <div className="mt-1 border-l-2 border-line pl-2 italic"><Markdown text={text} /></div>}
    </div>
  )
}

const STATUS_ICON: Record<AiToolCall['status'], ReactNode> = {
  pending: <Circle size={11} className="text-faint" />,
  in_progress: <Spinner className="size-3" />,
  completed: <Check size={11} className="text-add" />,
  failed: <CircleAlert size={11} className="text-del" />,
}

function ToolCard({ tool }: { tool: AiToolCall }) {
  // Open by itself once the call has a diff to show (it usually arrives in a later update),
  // until the user folds or unfolds it.
  const [chosen, setOpen] = useState<boolean | null>(null)
  const open = chosen ?? tool.content.some((c) => c.type === 'diff')
  return (
    <div className="my-1.5 rounded-md border border-line bg-panel text-xs" data-testid="tool-card" data-status={tool.status} data-kind={tool.kind}>
      <button className="flex w-full items-center gap-2 px-2 py-1 text-left" onClick={() => setOpen(!open)}>
        {STATUS_ICON[tool.status]}
        <Hammer size={11} className="text-faint" />
        <span className="min-w-0 flex-1 truncate font-medium" data-testid="tool-title">{tool.title}</span>
        <span className="text-faint">{tool.kind}</span>
        <ChevronRight size={11} className={clsx('text-faint transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="border-t border-line px-2 py-1.5">
          {tool.rawInput && <pre className="selectable mb-1 max-h-32 overflow-auto rounded bg-bg p-1.5 font-mono text-[11px] whitespace-pre-wrap" data-testid="tool-input">{tool.rawInput}</pre>}
          {tool.locations.length > 0 && <div className="mb-1 font-mono text-[11px] text-muted">{tool.locations.join(', ')}</div>}
          {tool.content.map((c, i) => c.type === 'text'
            ? <pre key={i} className="selectable max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted">{c.text}</pre>
            : <DiffBox key={i} path={c.path} oldText={c.oldText} newText={c.newText} />)}
        </div>
      )}
    </div>
  )
}

/** A tool's file change, as removed and added lines between what both sides share at the ends. */
function DiffBox({ path, oldText, newText }: { path: string; oldText: string | null; newText: string }) {
  const a = oldText === null ? [] : oldText.replace(/\n$/, '').split('\n')
  const b = newText.replace(/\n$/, '').split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const removed = a.slice(head, a.length - tail)
  const added = b.slice(head, b.length - tail)
  return (
    <div className="mt-1 overflow-hidden rounded border border-line" data-testid="tool-diff">
      <div className="flex items-center gap-1 border-b border-line bg-bg px-1.5 py-0.5 font-mono text-[11px] text-muted"><FileDiff size={11} /> {path.split(/[\\/]/).pop()}{oldText === null && ' (new file)'}</div>
      <pre className="selectable max-h-60 overflow-auto font-mono text-[11px] leading-[1.45]">
        {head > 0 && <div className="px-1.5 text-faint">… {head} unchanged line{head === 1 ? '' : 's'}</div>}
        {removed.map((l, i) => <div key={`r${i}`} className="bg-del-bg px-1.5 text-del">-{l}</div>)}
        {added.map((l, i) => <div key={`a${i}`} className="bg-add-bg px-1.5 text-add">+{l}</div>)}
        {tail > 0 && <div className="px-1.5 text-faint">… {tail} unchanged line{tail === 1 ? '' : 's'}</div>}
      </pre>
    </div>
  )
}

function PlanCard({ entries }: { entries: AiPlanEntry[] }) {
  return (
    <div className="my-1.5 rounded-md border border-line bg-panel px-2 py-1.5 text-xs" data-testid="thread-plan">
      <div className="mb-1 font-semibold text-muted">Plan</div>
      {entries.map((e, i) => (
        <div key={i} className="flex items-center gap-1.5" data-status={e.status}>
          {e.status === 'completed' ? <Check size={11} className="text-add" /> : e.status === 'in_progress' ? <CircleDot size={11} className="text-accent" /> : <Circle size={11} className="text-faint" />}
          <span className={clsx(e.status === 'completed' && 'text-muted line-through')}>{e.content}</span>
        </div>
      ))}
    </div>
  )
}

const ANSWERED: Record<PermissionAnswer, string> = { deny: 'Denied', once: 'Allowed once', session: 'Allowed for this session', expired: 'Not answered' }

/**
 * The agent asks before using a tool. The tool's input comes first when there is one: some
 * agents put the real command there and only prose in the title.
 */
function PermissionCard({ p }: { p: AiPermissionAsk }) {
  const [busy, setBusy] = useState(false)
  const answer = (a: Exclude<PermissionAnswer, 'expired'>) => {
    setBusy(true)
    void api.aiThreadPermission(p.permissionId, a)
  }
  return (
    <div className={clsx('my-1.5 rounded-md border p-2 text-xs', p.answer ? 'border-line bg-panel' : 'border-warn/50 bg-warn/10')} data-testid="thread-permission" data-answer={p.answer} data-has-raw-input={p.rawInput ? true : undefined}>
      <div className="flex items-center gap-1.5 font-semibold"><ShieldQuestion size={12} className="text-warn" /> The agent wants to {p.kind === 'other' ? 'use a tool' : p.kind}</div>
      {p.rawInput && <pre className="selectable mt-1 max-h-32 overflow-auto rounded bg-bg p-1.5 font-mono text-[11px] whitespace-pre-wrap" data-testid="permission-input">{p.rawInput}</pre>}
      <div className="mt-1">{p.title}</div>
      {p.paths.length > 0 && <div className="mt-0.5 font-mono text-[11px] break-all text-muted">{p.paths.join('\n')}</div>}
      {p.answer ? (
        <div className="mt-1.5 text-faint" data-testid="permission-answer">{ANSWERED[p.answer]}</div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" disabled={busy} onClick={() => answer('deny')} data-testid="thread-permission-deny">Deny</Button>
          <Button size="sm" disabled={busy} onClick={() => answer('once')} data-testid="thread-permission-once">Allow once</Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => answer('session')} data-testid="thread-permission-session">Allow for this session</Button>
        </div>
      )}
    </div>
  )
}

const ARTIFACT_LABEL: Record<ArtifactKind, string> = {
  findings: 'Revised review', plan: 'Revised plan', walkthrough: 'Revised walkthrough', 'commit-message': 'Commit message', diagram: 'Diagram',
}

/**
 * A structured result sent in the chat. Main checks it with the feature's own verifier first
 * (findings against the diff, a plan against the pieces, …); the card says what survived, and
 * Apply hands it to the view. Nothing is applied by itself.
 */
function ArtifactCard({ threadId, repoId, kind, json }: { threadId: string; repoId: string; kind: ArtifactKind; json: string }) {
  const [checked, setChecked] = useState<AiArtifactResult | null>(null)
  const [applied, setApplied] = useState(false)
  useEffect(() => {
    let live = true
    api.aiThreadArtifact(threadId, kind, json).then((r) => live && setChecked(r), (e: Error) => live && setChecked({ kind: 'problem', message: e.message }))
    return () => { live = false }
  }, [threadId, kind, json])
  return (
    <div className="my-1.5 rounded-md border border-accent/40 bg-accent/5 p-2 text-xs" data-testid="thread-artifact" data-kind={kind} data-state={!checked ? 'checking' : checked.kind === 'problem' ? 'problem' : applied ? 'applied' : 'ready'}>
      <div className="flex items-center gap-1.5 font-semibold"><Sparkles size={12} className="text-accent" /> {ARTIFACT_LABEL[kind]}</div>
      {!checked ? <div className="mt-1 flex items-center gap-1.5 text-muted"><Spinner /> Checking it…</div> : <ArtifactSummary a={checked} />}
      {checked && checked.kind !== 'problem' && checked.kind !== 'diagram' && (
        <div className="mt-2">
          {applied ? <span className="text-faint" data-testid="artifact-applied">Applied</span>
            : <Button size="sm" variant="primary" onClick={() => setApplied(applyArtifact(repoId, checked))} data-testid="artifact-apply">Apply</Button>}
        </div>
      )}
    </div>
  )
}

function ArtifactSummary({ a }: { a: AiArtifactResult }) {
  switch (a.kind) {
    case 'problem': return <div className="mt-1 text-del">{a.message}</div>
    case 'findings': return (
      <div className="mt-1" data-testid="artifact-summary">
        {a.review.findings.length} finding{a.review.findings.length === 1 ? '' : 's'} checked against the change{a.review.dropped.length ? `, ${a.review.dropped.length} thrown out (${a.review.dropped.map((d) => d.title).join(', ')})` : ''}.
        <ul className="mt-1 list-disc pl-4">{a.review.findings.slice(0, 8).map((f) => <li key={f.id}>{f.path}:{f.startLine} {f.title}</li>)}</ul>
      </div>
    )
    case 'plan': return (
      <div className="mt-1" data-testid="artifact-summary">
        {a.recompose.commits.length} commit{a.recompose.commits.length === 1 ? '' : 's'}{a.recompose.unplaced.length ? `; ${a.recompose.unplaced.length} piece${a.recompose.unplaced.length === 1 ? '' : 's'} it left out go in the last` : ''}:
        <ol className="mt-1 list-decimal pl-4">{a.recompose.commits.map((c, i) => <li key={i}>{c.message.split('\n')[0]}</li>)}</ol>
      </div>
    )
    case 'walkthrough': return <div className="mt-1" data-testid="artifact-summary">{a.walkthrough.summary.slice(0, 300)}</div>
    case 'commit-message': return <pre className="selectable mt-1 font-mono text-[11px] whitespace-pre-wrap" data-testid="artifact-summary">{a.message}</pre>
    case 'diagram': return <div className="mt-1"><SequenceSvg d={a.sequence} /></div>
  }
}
