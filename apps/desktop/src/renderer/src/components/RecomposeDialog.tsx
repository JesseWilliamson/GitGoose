import type { RecomposeProposal, RecomposeUnitInfo } from '@gitsquid/shared'
import clsx from 'clsx'
import { ArrowDown, ArrowRight, ArrowUp, CircleAlert, Combine, GripVertical, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { run } from '../lib/actions'
import { cancelAi, startAi, useAi } from '../lib/ai'
import { api, toUiError } from '../lib/api'
import { splitPath } from '../lib/format'
import { addCommit, draftProblems, editMessage, moveCommit, moveUnit, removeEmpty, squashIntoNext, type Draft } from '../lib/recomposeDraft'
import { getLog, toast, updateRepo, useStore } from '../lib/store'
import { Button, DM, Modal, Spinner } from './ui'

/**
 * Recompose with AI, GitKraken-style: the AI proposes a new set of commits for the selected
 * ones, and you shape it before anything changes. The proposed commits are a list on the left;
 * the selected one's message and changes on the right. Drag commits to reorder them, drag a
 * change onto another commit (or use "Move to") to move it, squash, add or remove commits.
 *
 * However the plan is edited, every change stays in exactly one commit (lib/recomposeDraft.ts),
 * so the new commits add up to the same final code; main checks that again, and Undo puts the
 * old commits back.
 */

const COMMIT_MIME = 'application/x-gitsquid-recompose-commit'
const UNIT_MIME = 'application/x-gitsquid-recompose-unit'

export function recomposeWithAi(repoId: string, hashes: string[]): void {
  const r = startAi(repoId, { kind: 'recompose', hashes })
  useAi.setState({ recompose: { repoId, hashes, requestId: r.requestId, proposal: null, error: null } })
  const mine = (s: ReturnType<typeof useAi.getState>) => s.recompose?.requestId === r.requestId
  r.done.then(
    (res) => useAi.setState((s) => {
      if (!mine(s)) return s
      if (!res?.recompose) return { recompose: null } // cancelled or not set up (already reported)
      return { recompose: { ...s.recompose!, requestId: null, proposal: res.recompose } }
    }),
    (e) => useAi.setState((s) => (mine(s) ? { recompose: { ...s.recompose!, requestId: null, error: toUiError(e).message } } : s)),
  )
}

export function RecomposeDialog() {
  const state = useAi((s) => s.recompose)
  if (!state) return null
  const close = () => {
    if (state.requestId) cancelAi(state.requestId)
    useAi.setState({ recompose: null })
  }
  const n = state.hashes.length
  return (
    <Modal open onClose={close} title={`Recompose ${n === 1 ? '1 commit' : `${n} commits`} with AI`} width={state.proposal ? 1120 : 560} tall={!!state.proposal}>
      <div data-testid="recompose-dialog" className="text-[13px]">
        {state.proposal ? (
          <Review key={state.requestId ?? 'review'} repoId={state.repoId} proposal={state.proposal} close={close} />
        ) : state.error ? (
          <>
            <div className="flex items-start gap-2 text-del" data-testid="recompose-error"><CircleAlert size={15} className="mt-px shrink-0" /> {state.error}</div>
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={close}>Close</Button>
              <Button variant="primary" onClick={() => recomposeWithAi(state.repoId, state.hashes)}>Try again</Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-muted"><Spinner /> Asking the AI how to split these changes into commits…</div>
            <div className="mt-4 flex justify-end"><Button onClick={close}>Stop</Button></div>
          </>
        )}
      </div>
    </Modal>
  )
}

function Review({ repoId, proposal, close }: { repoId: string; proposal: RecomposeProposal; close: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => structuredClone(proposal.commits))
  const [selected, setSelected] = useState(0)
  /** Where a dragged commit or change would land in the list. */
  const [dropAt, setDropAt] = useState<{ index: number; kind: 'commit' | 'unit' } | null>(null)
  const busy = useStore((s) => !!s.repos[repoId]?.busy)
  useEffect(() => setDraft(structuredClone(proposal.commits)), [proposal])
  const units = useMemo(() => new Map(proposal.units.map((u) => [u.id, u])), [proposal])
  const order = useMemo(() => proposal.units.map((u) => u.id), [proposal])
  const problems = draftProblems(draft)
  const sel = Math.min(selected, draft.length - 1)
  const current = draft[sel]

  /** The commits being replaced, oldest first, by subject (from the loaded log). */
  const before = useMemo(() => {
    const log = getLog(repoId)
    return [...proposal.hashes].reverse().map((h) => log.commits[log.index.get(h) ?? -1]?.subject ?? h.slice(0, 7))
  }, [repoId, proposal.hashes])

  const update = (f: (d: Draft) => Draft) => setDraft((d) => f(d))

  const apply = async () => {
    const ok = await run(repoId, 'Recompose', () => api.recomposeApply(repoId, proposal.hashes, draft), { quiet: true })
    if (ok) {
      close()
      toast({ kind: 'success', title: `Recomposed into ${draft.length} ${draft.length === 1 ? 'commit' : 'commits'}` })
      const head = useStore.getState().repos[repoId]?.snapshot.head.hash
      if (head) updateRepo(repoId, { selected: { kind: 'commit', hash: head } })
    }
  }

  const onListDrop = (e: DragEvent, index: number) => {
    e.preventDefault()
    setDropAt(null)
    const commit = e.dataTransfer.getData(COMMIT_MIME)
    const unit = e.dataTransfer.getData(UNIT_MIME)
    if (commit) {
      const from = Number(commit)
      update((d) => moveCommit(d, from, index > from ? index - 1 : index))
      setSelected(index > from ? index - 1 : index)
    } else if (unit) {
      update((d) => moveUnit(d, unit, index, order))
    }
  }

  return (
    <div className="flex h-[78vh] flex-col">
      {/* Before → after, so it is clear what is being replaced by what. */}
      <div className="mb-3 flex items-center gap-3 rounded-md border border-line bg-panel px-3 py-2 text-xs" data-testid="recompose-summary">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold tracking-wide text-faint uppercase">Now · {before.length}</div>
          <div className="truncate text-muted line-through decoration-faint/60">{before.join(' · ')}</div>
        </div>
        <ArrowRight size={16} className="shrink-0 text-faint" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold tracking-wide text-faint uppercase">After · {draft.length}</div>
          <div className="truncate">{draft.map((c) => c.message.split('\n')[0] || '(no message)').join(' · ')}</div>
        </div>
        <button className="flex shrink-0 items-center gap-1 text-muted hover:text-fg" onClick={() => { setDraft(structuredClone(proposal.commits)); setSelected(0) }} data-testid="recompose-reset"
          title="Back to what the AI proposed">
          <RotateCcw size={12} /> Reset
        </button>
      </div>
      {proposal.onRemote.length > 0 && (
        <p className="mb-2 flex items-start gap-1.5 rounded bg-warn/10 px-2 py-1.5 text-xs text-warn" data-testid="recompose-remote">
          <CircleAlert size={13} className="mt-px shrink-0" />
          {proposal.onRemote.join(', ')} already {proposal.onRemote.length === 1 ? 'has' : 'have'} these commits. After recomposing, pushing {proposal.branch} needs a force-push, which GitSquid will not do for you.
        </p>
      )}
      {proposal.unplaced.length > 0 && (
        <p className="mb-2 text-xs text-muted">The AI left {proposal.unplaced.length} {proposal.unplaced.length === 1 ? 'change' : 'changes'} out; {proposal.unplaced.length === 1 ? 'it was' : 'they were'} added to the last commit.</p>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border border-line">
        {/* The proposed commits, applied top to bottom. */}
        <div className="flex w-80 shrink-0 flex-col border-r border-line bg-panel">
          <div className="flex items-center px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">
            <span className="flex-1">Commits, oldest first</span>
          </div>
          <ol className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-testid="recompose-commits">
            {draft.map((c, i) => {
              const stats = c.units.reduce((s, id) => ({ add: s.add + (units.get(id)?.added ?? 0), del: s.del + (units.get(id)?.removed ?? 0) }), { add: 0, del: 0 })
              const files = new Set(c.units.map((id) => units.get(id)?.path)).size
              return (
                <li key={i} data-testid="recompose-commit" data-selected={sel === i || undefined}
                  draggable onDragStart={(e) => { e.dataTransfer.setData(COMMIT_MIME, String(i)); e.dataTransfer.effectAllowed = 'move' }}
                  onDragOver={(e) => {
                    const kind = e.dataTransfer.types.includes(COMMIT_MIME) ? 'commit' : e.dataTransfer.types.includes(UNIT_MIME) ? 'unit' : null
                    if (!kind) return
                    e.preventDefault()
                    const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    // A commit lands above or below; a change lands on the commit itself.
                    setDropAt({ index: kind === 'commit' && e.clientY > box.top + box.height / 2 ? i + 1 : i, kind })
                  }}
                  onDragLeave={() => setDropAt(null)}
                  onDrop={(e) => onListDrop(e, dropAt?.index ?? i)}
                  onClick={() => setSelected(i)}
                  className={clsx('group relative mt-1 flex cursor-default gap-2 rounded-md border px-2 py-1.5',
                    sel === i ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-hover',
                    dropAt?.kind === 'unit' && dropAt.index === i && 'ring-2 ring-accent',
                    !c.units.length && 'border-dashed border-del/50')}>
                  {dropAt?.kind === 'commit' && dropAt.index === i && <span className="absolute inset-x-1 -top-1 h-0.5 rounded bg-accent" />}
                  {dropAt?.kind === 'commit' && dropAt.index === i + 1 && i === draft.length - 1 && <span className="absolute inset-x-1 -bottom-1 h-0.5 rounded bg-accent" />}
                  <GripVertical size={13} className="mt-0.5 shrink-0 cursor-grab text-faint opacity-0 group-hover:opacity-100" />
                  <span className="mt-px w-4 shrink-0 text-right font-mono text-[11px] text-faint">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className={clsx('truncate', !c.message.trim() && 'text-faint italic')} data-testid="recompose-title">{c.message.split('\n')[0] || 'No message yet'}</div>
                    <div className="mt-0.5 flex gap-2 text-[11px] text-faint">
                      {c.units.length ? <><span>{files} {files === 1 ? 'file' : 'files'}</span><span className="text-add">+{stats.add}</span><span className="text-del">−{stats.del}</span></>
                        : <span className="text-del">No changes</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col opacity-0 group-hover:opacity-100 group-data-[selected]:opacity-100">
                    <button title="Earlier" disabled={i === 0} onClick={(e) => { e.stopPropagation(); update((d) => moveCommit(d, i, i - 1)); setSelected(i - 1) }}
                      className="rounded p-0.5 text-muted hover:bg-hover disabled:opacity-30" data-testid="recompose-up"><ArrowUp size={12} /></button>
                    <button title="Later" disabled={i === draft.length - 1} onClick={(e) => { e.stopPropagation(); update((d) => moveCommit(d, i, i + 1)); setSelected(i + 1) }}
                      className="rounded p-0.5 text-muted hover:bg-hover disabled:opacity-30" data-testid="recompose-down"><ArrowDown size={12} /></button>
                  </div>
                </li>
              )
            })}
          </ol>
          <div className="flex gap-1 border-t border-line p-2">
            <Button size="sm" variant="ghost" onClick={() => { update(addCommit); setSelected(draft.length) }} data-testid="recompose-add"><Plus size={12} /> New commit</Button>
            {draft.some((c) => !c.units.length) && (
              <Button size="sm" variant="ghost" onClick={() => update(removeEmpty)} data-testid="recompose-remove-empty"><Trash2 size={12} /> Remove empty</Button>
            )}
          </div>
        </div>

        {/* The selected commit: its message, and its changes in full. */}
        {current && (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="border-b border-line p-3">
              <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-faint uppercase">
                <span className="flex-1">Commit {sel + 1} of {draft.length}</span>
                <button title="Squash into the next commit: its changes and message join that one" disabled={sel === draft.length - 1}
                  onClick={() => update((d) => squashIntoNext(d, sel))} data-testid="recompose-squash"
                  className="flex items-center gap-1 normal-case tracking-normal text-muted hover:text-fg disabled:opacity-30"><Combine size={12} /> Squash into next</button>
              </div>
              <textarea key={sel} value={current.message} onChange={(e) => update((d) => editMessage(d, sel, e.target.value))}
                rows={Math.max(2, Math.min(6, current.message.split('\n').length))} placeholder="Commit message (first line is the summary)"
                className="w-full resize-y rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
                data-testid="recompose-message" />
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="recompose-units">
              {current.units.length === 0 && (
                <div className="rounded-md border border-dashed border-line p-6 text-center text-xs text-faint">
                  No changes yet. Drag changes here from another commit's list entry, or use "Move to" on a change.
                </div>
              )}
              {current.units.map((id) => {
                const u = units.get(id)
                return u ? <UnitCard key={id} unit={u} draft={draft} here={sel} onMove={(to) => update((d) => moveUnit(d, id, to, order))} /> : null
              })}
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <p className="flex min-w-0 flex-1 items-center gap-1 text-xs text-faint">
          {problems.length ? (
            <span className="flex items-center gap-1 text-del" data-testid="recompose-problems"><CircleAlert size={12} className="shrink-0" /> {problems[0]}{problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}</span>
          ) : (
            <><Sparkles size={11} className="shrink-0" /> Replaces {proposal.hashes.length === 1 ? 'the commit' : `the ${proposal.hashes.length} commits`} on {proposal.branch}. Every change stays in exactly one commit, so the final code is the same; your working tree is not touched, and Undo puts the old commits back.</>
          )}
        </p>
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={() => void apply()} disabled={busy || problems.length > 0} data-testid="recompose-apply">
          Create {draft.length} {draft.length === 1 ? 'commit' : 'commits'}
        </Button>
      </div>
    </div>
  )
}

/** One change (a hunk, or a whole file): its diff, draggable to another commit, with "Move to". */
function UnitCard({ unit, draft, here, onMove }: { unit: RecomposeUnitInfo; draft: Draft; here: number; onMove: (to: number) => void }) {
  const { dir, name } = splitPath(unit.path)
  return (
    <div className="overflow-hidden rounded-md border border-line bg-bg" data-testid="recompose-unit" data-unit={unit.id}
      draggable onDragStart={(e) => { e.dataTransfer.setData(UNIT_MIME, unit.id); e.dataTransfer.effectAllowed = 'move' }}>
      <div className="flex items-center gap-2 border-b border-line bg-panel px-2 py-1 text-xs">
        <GripVertical size={12} className="shrink-0 cursor-grab text-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]"><span className="text-faint">{dir}</span>{name}</span>
        {unit.binary ? <span className="text-faint">binary</span> : <><span className="text-add">+{unit.added}</span><span className="text-del">−{unit.removed}</span></>}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="rounded px-1.5 py-0.5 text-muted hover:bg-hover hover:text-fg" data-testid="recompose-move">Move to…</button>
          </DropdownMenu.Trigger>
          <DM.Content align="end">
            {draft.map((c, i) => i === here ? null : (
              <DM.Item key={i} onSelect={() => onMove(i)}>{i + 1}. {c.message.split('\n')[0] || '(no message)'}</DM.Item>
            ))}
            <DM.Separator />
            <DM.Item onSelect={() => onMove(draft.length)}>A new commit</DM.Item>
          </DM.Content>
        </DropdownMenu.Root>
      </div>
      {unit.preview ? (
        <pre className="selectable max-h-72 overflow-auto py-1 font-mono text-[11.5px] leading-[1.45]">
          {unit.preview.split('\n').map((l, i) => (
            <div key={i} className={clsx('px-2', l.startsWith('+') ? 'bg-add-bg text-add' : l.startsWith('-') ? 'bg-del-bg text-del' : l.startsWith('@@') ? 'text-accent' : l.startsWith('…') ? 'text-faint italic' : 'text-muted')}>
              {l || ' '}
            </div>
          ))}
        </pre>
      ) : <div className="px-2 py-1.5 text-xs text-faint">{unit.binary ? 'A binary file.' : 'The whole file (a mode change, or an empty file).'}</div>}
    </div>
  )
}
