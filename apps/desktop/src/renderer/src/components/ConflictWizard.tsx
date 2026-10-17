import { parseConflicts, resolveBlocks, type ConflictChoice, type ConflictFile, type ConflictVersions } from '@gitsquid/shared'
import clsx from 'clsx'
import { CheckCircle2, CircleAlert, ExternalLink } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { run } from '../lib/actions'
import { api } from '../lib/api'
import { sentence } from '../lib/format'
import { toastError, updateRepo, type RepoView } from '../lib/store'
import { Button, Spinner } from './ui'

/**
 * Conflict resolution: one file at a time, one conflict block at a time.
 * Each block shows our side and their side; pick one, both, or edit the file elsewhere.
 * When nothing is left unmerged, Continue finishes the merge/rebase/cherry-pick/revert.
 */
export function ConflictWizard({ view }: { view: RepoView }) {
  const [files, setFiles] = useState<ConflictFile[] | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const op = view.snapshot.operation
  const unmergedKey = view.snapshot.status.filter((e) => e.kind === 'unmerged').map((e) => e.path).join('\0')

  useEffect(() => {
    api.conflicts(view.id).then((f) => {
      setFiles(f)
      setCurrent((c) => (c && f.some((x) => x.path === c) ? c : (f[0]?.path ?? null)))
    }, (e) => toastError('Could not list conflicts', e))
  }, [view.id, unmergedKey, view.worktreeTick])

  const resolved = view.snapshot.status.filter((e) => e.kind !== 'unmerged' && e.index !== '.' && e.kind !== 'untracked')
  const opName = op ?? 'operation'

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="conflicts">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
        <CircleAlert size={18} className="text-warn" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">{op ? `${sentence(op)} in progress` : 'No operation in progress'}</div>
          <div className="text-xs text-muted">
            {files === null ? 'Checking…' : files.length ? `${files.length} ${files.length === 1 ? 'file has' : 'files have'} conflicts` : 'All conflicts resolved'}
          </div>
        </div>
        <Button onClick={() => updateRepo(view.id, { center: { kind: 'graph' } })} variant="ghost">Back to graph</Button>
        {op && (
          <>
            <Button onClick={() => void run(view.id, `Abort ${opName}`, () => api.abortOperation(view.id))}>Abort {opName}</Button>
            <Button variant="primary" data-testid="continue-op" disabled={!files || files.length > 0}
              onClick={() => void run(view.id, `Continue ${opName}`, () => api.continueOperation(view.id), { success: `${sentence(opName)} complete` })}>
              Continue {opName}
            </Button>
          </>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-64 shrink-0 overflow-y-auto border-r border-line bg-panel py-2">
          <div className="px-3 pb-1 text-[11px] font-semibold text-muted uppercase">Conflicted</div>
          {files?.map((f) => (
            <button key={f.path} onClick={() => setCurrent(f.path)} data-testid="conflict-file"
              className={clsx('flex h-7 w-full items-center gap-2 px-3 text-left text-[13px]', current === f.path ? 'bg-select' : 'hover:bg-hover')}>
              <CircleAlert size={13} className="shrink-0 text-del" />
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
              <span className="text-[11px] text-faint">{f.blocks || f.code}</span>
            </button>
          ))}
          {resolved.length > 0 && <div className="mt-3 px-3 pb-1 text-[11px] font-semibold text-muted uppercase">Resolved / staged</div>}
          {resolved.map((e) => (
            <div key={e.path} className="flex h-7 items-center gap-2 px-3 text-[13px] text-muted">
              <CheckCircle2 size={13} className="shrink-0 text-add" />
              <span className="truncate">{e.path}</span>
            </div>
          ))}
        </div>
        {current && files?.some((f) => f.path === current) ? (
          <ConflictFileView key={current} view={view} file={files.find((f) => f.path === current)!} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-faint">
            {files?.length === 0 ? `Everything is resolved. Continue the ${opName} when ready.` : 'Select a file'}
          </div>
        )}
      </div>
    </div>
  )
}

function ConflictFileView({ view, file }: { view: RepoView; file: ConflictFile }) {
  const [versions, setVersions] = useState<ConflictVersions | null>(null)
  const [choices, setChoices] = useState<(ConflictChoice | undefined)[]>([])
  useEffect(() => {
    api.conflictVersions(view.id, file.path).then(setVersions, (e) => toastError('Could not read conflict', e))
  }, [view.id, file.path])

  const segments = useMemo(() => (versions?.merged ? parseConflicts(versions.merged) : []), [versions])
  const blocks = segments.filter((s) => s.kind === 'conflict')
  const allChosen = blocks.length > 0 && blocks.every((_, i) => choices[i])

  if (!versions) return <div className="flex flex-1 items-center justify-center text-faint"><Spinner /></div>

  const resolveWith = (resolution: 'ours' | 'theirs') =>
    void run(view.id, `Take ${resolution} for ${file.path}`, () => api.resolveConflict(view.id, file.path, resolution), { quiet: true })
  const save = () =>
    void run(view.id, `Resolve ${file.path}`, () => api.resolveConflict(view.id, file.path, { content: resolveBlocks(versions.merged!, choices) }), { quiet: true })
  const markResolved = () =>
    void run(view.id, `Mark ${file.path} resolved`, () => api.resolveConflict(view.id, file.path, { content: versions.merged ?? '' }), { quiet: true })

  let blockNo = -1
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="min-w-32 flex-1 truncate text-[13px] font-semibold" title={file.path}>{file.path}</span>
        <Button size="sm" onClick={() => resolveWith('ours')} disabled={versions.ours === null && versions.theirs === null}>
          {versions.ours === null ? 'Keep deleted (ours)' : 'Take ours'}
        </Button>
        <Button size="sm" onClick={() => resolveWith('theirs')}>{versions.theirs === null ? 'Keep deleted (theirs)' : 'Take theirs'}</Button>
        <Button size="sm" variant="ghost" title="Open in your default editor" onClick={() => void api.openPath(`${view.snapshot.path}/${file.path}`)}>
          <ExternalLink size={12} /> Open
        </Button>
        {blocks.length === 0 && versions.merged !== null && <Button size="sm" onClick={markResolved}>Mark resolved</Button>}
        {blocks.length > 0 && (
          <Button size="sm" variant="primary" disabled={!allChosen} onClick={save} data-testid="save-resolution">
            Save resolution ({choices.filter(Boolean).length}/{blocks.length})
          </Button>
        )}
      </div>
      <div className="selectable min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px]">
        {versions.merged === null && (
          <div className="font-sans text-sm text-muted">
            This file was deleted on one side and changed on the other. Take ours or theirs to decide whether it stays.
          </div>
        )}
        {blocks.length === 0 && versions.merged !== null && (
          <div className="mb-3 font-sans text-sm text-muted">No conflict markers left in this file. Mark it resolved to stage it.</div>
        )}
        {segments.map((seg, si) => {
          if (seg.kind === 'text') {
            // Show a little context around each conflict instead of the whole file.
            const lines = seg.lines
            const shown = lines.length > 8 ? [...lines.slice(0, si === 0 ? 0 : 3), '⋯', ...lines.slice(-3)] : lines
            return <pre key={si} className="px-2 text-faint">{shown.join('\n')}</pre>
          }
          blockNo++
          const b = blockNo
          const choice = choices[b]
          const choose = (c: ConflictChoice) => setChoices((prev) => { const n = [...prev]; n[b] = c; return n })
          return (
            <div key={si} className="my-2 overflow-hidden rounded-md border border-line font-mono" data-testid="conflict-block">
              <div className="grid grid-cols-2">
                <Side title={`Ours (${seg.oursLabel || 'HEAD'})`} lines={seg.ours} active={choice === 'ours' || choice === 'both'} onPick={() => choose('ours')} pickLabel="Use ours" testId="use-ours" />
                <Side title={`Theirs (${seg.theirsLabel || 'incoming'})`} lines={seg.theirs} active={choice === 'theirs' || choice === 'both'} onPick={() => choose('theirs')} pickLabel="Use theirs" border testId="use-theirs" />
              </div>
              <div className="flex items-center gap-2 border-t border-line bg-panel px-2 py-1 font-sans text-xs">
                <span className="text-muted">Conflict {b + 1}:</span>
                <Button size="sm" variant={choice === 'both' ? 'primary' : 'ghost'} onClick={() => choose('both')}>Use both (ours first)</Button>
                {seg.base && <Button size="sm" variant={choice === 'base' ? 'primary' : 'ghost'} onClick={() => choose('base')}>Use original</Button>}
                <span className="ml-auto text-faint">{choice ? `Using ${choice}` : 'Not decided'}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Side({ title, lines, active, onPick, pickLabel, border, testId }: {
  title: string; lines: string[]; active: boolean; onPick: () => void; pickLabel: string; border?: boolean; testId: string
}) {
  return (
    <div className={clsx('min-w-0', border && 'border-l border-line', active && 'bg-add-bg')}>
      <div className="flex items-center justify-between border-b border-line px-2 py-1 font-sans text-xs">
        <span className="truncate font-semibold text-muted">{title}</span>
        <Button size="sm" variant={active ? 'primary' : 'default'} onClick={onPick} data-testid={testId}>{pickLabel}</Button>
      </div>
      <pre className="overflow-x-auto px-2 py-1">{lines.length ? lines.join('\n') : <span className="text-faint italic">(nothing)</span>}</pre>
    </div>
  )
}
