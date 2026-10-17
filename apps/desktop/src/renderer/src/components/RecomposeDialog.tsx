import type { RecomposeProposal } from '@gitsquid/shared'
import clsx from 'clsx'
import { ArrowDown, ArrowUp, CircleAlert, Combine, RotateCcw, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { run } from '../lib/actions'
import { cancelAi, startAi, useAi } from '../lib/ai'
import { api, toUiError } from '../lib/api'
import { toast, updateRepo, useStore } from '../lib/store'
import { Button, Modal, Spinner } from './ui'

/**
 * Recompose with AI, GitKraken-style: the AI proposes a new set of commits for the selected
 * ones; you reorder, squash and edit messages; nothing changes until "Create commits". The new
 * commits always add up to the same final code (main checks that), and Undo puts the old ones back.
 */

type Draft = { message: string; units: string[] }[]

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
  return (
    <Modal open onClose={close} title={`Recompose ${state.hashes.length === 1 ? '1 commit' : `${state.hashes.length} commits`} with AI`} width={760}>
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
  const [open, setOpen] = useState<string | null>(null)
  const busy = useStore((s) => !!s.repos[repoId]?.busy)
  useEffect(() => setDraft(structuredClone(proposal.commits)), [proposal])
  const units = new Map(proposal.units.map((u) => [u.id, u]))

  const move = (i: number, d: -1 | 1) => setDraft((ds) => {
    const next = [...ds]
    const [c] = next.splice(i, 1)
    next.splice(i + d, 0, c!)
    return next
  })
  // Squash commit i into the one after it: its changes and its message go with that commit.
  const squash = (i: number) => setDraft((ds) => {
    const next = [...ds]
    const a = next[i]!
    const b = next[i + 1]!
    next.splice(i, 2, { message: `${b.message.trim()}\n\n${a.message.trim()}`, units: [...a.units, ...b.units] })
    return next
  })
  const edit = (i: number, message: string) => setDraft((ds) => ds.map((c, j) => (j === i ? { ...c, message } : c)))

  const apply = async () => {
    const ok = await run(repoId, 'Recompose', () => api.recomposeApply(repoId, proposal.hashes, draft), {
      quiet: true,
    })
    if (ok) {
      close()
      toast({ kind: 'success', title: `Recomposed into ${draft.length} ${draft.length === 1 ? 'commit' : 'commits'}` })
      const head = useStore.getState().repos[repoId]?.snapshot.head.hash
      if (head) updateRepo(repoId, { selected: { kind: 'commit', hash: head } })
    }
  }

  return (
    <>
      {proposal.onRemote.length > 0 && (
        <p className="mb-2 flex items-start gap-1.5 rounded bg-warn/10 px-2 py-1.5 text-xs text-warn" data-testid="recompose-remote">
          <CircleAlert size={13} className="mt-px shrink-0" />
          {proposal.onRemote.join(', ')} already {proposal.onRemote.length === 1 ? 'has' : 'have'} these commits. After recomposing, pushing {proposal.branch} needs a force-push, which GitSquid will not do for you.
        </p>
      )}
      {proposal.unplaced.length > 0 && (
        <p className="mb-2 text-xs text-muted">The AI left {proposal.unplaced.length} {proposal.unplaced.length === 1 ? 'change' : 'changes'} out; {proposal.unplaced.length === 1 ? 'it was' : 'they were'} added to the last commit.</p>
      )}
      <div className="mb-1 flex items-center text-[11px] font-semibold tracking-wide text-faint uppercase">
        <span className="flex-1">Applied top to bottom</span>
        <button className="flex items-center gap-1 normal-case hover:text-fg" onClick={() => setDraft(structuredClone(proposal.commits))} data-testid="recompose-reset">
          <RotateCcw size={11} /> Reset
        </button>
      </div>
      <ol className="max-h-[55vh] space-y-2 overflow-y-auto pr-1" data-testid="recompose-commits">
        {draft.map((c, i) => (
          <li key={i} className="rounded-md border border-line bg-bg/50 p-2" data-testid="recompose-commit">
            <div className="flex items-start gap-2">
              <span className="mt-1 w-5 shrink-0 text-right font-mono text-xs text-faint">{i + 1}</span>
              <textarea value={c.message} onChange={(e) => edit(i, e.target.value)} rows={Math.min(4, c.message.split('\n').length)}
                className="min-w-0 flex-1 resize-y rounded border border-line bg-bg px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
                data-testid="recompose-message" />
              <div className="flex shrink-0 flex-col gap-1">
                <button title="Earlier" disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-0.5 text-muted hover:bg-hover disabled:opacity-30" data-testid="recompose-up"><ArrowUp size={13} /></button>
                <button title="Later" disabled={i === draft.length - 1} onClick={() => move(i, 1)} className="rounded p-0.5 text-muted hover:bg-hover disabled:opacity-30" data-testid="recompose-down"><ArrowDown size={13} /></button>
                <button title="Squash into the next commit" disabled={i === draft.length - 1} onClick={() => squash(i)} className="rounded p-0.5 text-muted hover:bg-hover disabled:opacity-30" data-testid="recompose-squash"><Combine size={13} /></button>
              </div>
            </div>
            <div className="mt-1.5 ml-7 flex flex-wrap gap-1">
              {c.units.map((id) => {
                const u = units.get(id)
                if (!u) return null
                return (
                  <button key={id} onClick={() => setOpen(open === id ? null : id)} title={u.preview || u.path}
                    className={clsx('flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px]', open === id ? 'border-accent' : 'border-line hover:bg-hover')}>
                    <span className="truncate">{u.path}</span>
                    {u.binary ? <span className="text-faint">binary</span> : <><span className="text-add">+{u.added}</span><span className="text-del">−{u.removed}</span></>}
                  </button>
                )
              })}
            </div>
            {open && c.units.includes(open) && units.get(open)?.preview && (
              <pre className="selectable mt-1.5 ml-7 max-h-40 overflow-auto rounded bg-bg p-2 font-mono text-[11px]">{units.get(open)!.preview}</pre>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-3 flex items-center gap-1 text-xs text-faint">
        <Sparkles size={11} /> Replaces {proposal.hashes.length === 1 ? 'the commit' : `the ${proposal.hashes.length} commits`} on {proposal.branch}. The final code is identical and your working tree is not touched; Undo puts the old commits back.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={() => void apply()} disabled={busy || draft.some((c) => !c.message.trim())} data-testid="recompose-apply">
          Create {draft.length} {draft.length === 1 ? 'commit' : 'commits'}
        </Button>
      </div>
    </>
  )
}
