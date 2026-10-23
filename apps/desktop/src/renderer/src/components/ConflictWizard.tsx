import { countConflicts, parseConflicts, resolveBlocks, type ConflictBlock, type ConflictChoice, type ConflictFile, type ConflictVersions } from '@gitgoose/shared'
import clsx from 'clsx'
import { ArrowLeft, CheckCircle2, CircleAlert, ExternalLink, GitMerge, Sparkles, Wrench } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { openInEditor, openMergeTool, run } from '../lib/actions'
import { areaTarget, cancelAi, conflictJobKey, resolveWithAgent } from '../lib/ai'
import { useRunningJob } from '../lib/aiJobs'
import { api } from '../lib/api'
import { opName, sentence, splitPath } from '../lib/format'
import { reportError, updateRepo, useSetting, useStore, type RepoView } from '../lib/store'
import { Button, Spinner } from './ui'
import { ModelPicker } from './ModelPicker'
import { PromptButton } from './PromptPanel'

const ResultEditor = lazy(() => import('./ResultEditor'))
const MergePanes = lazy(() => import('./MergePanes'))

/**
 * Resolving conflicts, one file at a time. The files are tabs along the top (with how far along
 * the whole operation is), so the file being resolved gets the full width: the three-pane view
 * (yours and theirs above, the result below) or, for a few small conflicts, one card per
 * conflict. Yours is blue and theirs amber in every part of it. When nothing is left unmerged,
 * Continue finishes the merge, rebase, cherry-pick, revert or patch.
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
    }, (e) => reportError('Could not list conflicts', e))
  }, [view.id, unmergedKey, view.worktreeTick])

  // Resolved here means staged during this operation; the count drives the progress bar.
  const resolved = view.snapshot.status.filter((e) => e.kind !== 'unmerged' && e.index !== '.' && e.kind !== 'untracked')
  const total = (files?.length ?? 0) + resolved.length
  const opLabel = op ? opName(op) : 'operation'

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="conflicts">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
        <span className="flex size-8 items-center justify-center rounded-lg bg-warn/15 text-warn"><GitMerge size={17} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">{op ? `${sentence(opLabel)} in progress` : 'No operation in progress'}</div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span data-testid="conflict-progress">
              {files === null ? 'Checking…' : files.length ? `${resolved.length} of ${total} ${total === 1 ? 'file' : 'files'} resolved` : 'All conflicts resolved'}
            </span>
            {total > 0 && (
              <span className="h-1.5 w-32 overflow-hidden rounded-full bg-hover" aria-hidden>
                <span className="block h-full rounded-full bg-add transition-[width]" style={{ width: `${(resolved.length / total) * 100}%` }} />
              </span>
            )}
          </div>
        </div>
        <Button onClick={() => updateRepo(view.id, { center: { kind: 'graph' } })} variant="ghost"><ArrowLeft size={13} /> Back to graph</Button>
        {op && (
          <>
            <Button onClick={() => void run(view.id, `Abort ${opLabel}`, () => api.abortOperation(view.id))}>Abort {opLabel}</Button>
            <Button variant="primary" data-testid="continue-op" disabled={!files || files.length > 0}
              title={files?.length ? 'Resolve every file first' : `Finish the ${opLabel}`}
              onClick={() => void run(view.id, `Continue ${opLabel}`, () => api.continueOperation(view.id), { success: `${sentence(opLabel)} complete` })}>
              Continue {opLabel}
            </Button>
          </>
        )}
      </div>
      {/* The files, as tabs: conflicted first, then the ones already resolved. */}
      <div className="flex shrink-0 items-end gap-1 overflow-x-auto border-b border-line bg-panel px-3 pt-2" role="tablist" aria-label="Files">
        {files?.map((f) => {
          const { dir, name } = splitPath(f.path)
          return (
            <button key={f.path} role="tab" aria-selected={current === f.path} onClick={() => setCurrent(f.path)} data-testid="conflict-file" title={f.path}
              className={clsx('-mb-px flex h-8 max-w-72 shrink-0 items-center gap-1.5 rounded-t-md border px-3 text-[13px]',
                current === f.path ? 'border-line border-b-bg bg-bg text-fg' : 'border-transparent text-muted hover:bg-hover hover:text-fg')}>
              <CircleAlert size={13} className="shrink-0 text-del" />
              <span className="min-w-0 truncate"><span className="text-faint">{dir}</span>{name}</span>
              <span className="shrink-0 rounded-full bg-del/15 px-1.5 text-[10px] font-semibold text-del" title={f.blocks ? `${f.blocks} conflicts` : f.code}>{f.blocks || f.code}</span>
            </button>
          )
        })}
        {resolved.map((e) => (
          <span key={e.path} className="-mb-px flex h-8 max-w-60 shrink-0 items-center gap-1.5 px-3 text-[13px] text-faint" data-testid="resolved-file" title={`${e.path}: resolved`}>
            <CheckCircle2 size={13} className="shrink-0 text-add" />
            <span className="min-w-0 truncate">{splitPath(e.path).name}</span>
          </span>
        ))}
      </div>
      {current && files?.some((f) => f.path === current) ? (
        <ConflictFileView key={current} view={view} file={files.find((f) => f.path === current)!} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-faint">
          {files?.length === 0 ? (
            <>
              <CheckCircle2 size={28} className="text-add" />
              <span>Everything is resolved. Continue the {opLabel} when ready.</span>
            </>
          ) : 'Select a file'}
        </div>
      )}
    </div>
  )
}

function ConflictFileView({ view, file }: { view: RepoView; file: ConflictFile }) {
  const [versions, setVersions] = useState<ConflictVersions | null>(null)
  const [choices, setChoices] = useState<(ConflictChoice | undefined)[]>([])
  /** Text being edited by hand, or null when picking sides block by block. */
  const [edited, setEdited] = useState<string | null>(null)
  useEffect(() => {
    api.conflictVersions(view.id, file.path).then(setVersions, (e) => reportError('Could not read conflict', e))
  }, [view.id, file.path])

  const segments = useMemo(() => (versions?.merged ? parseConflicts(versions.merged) : []), [versions])
  const blocks = segments.filter((s) => s.kind === 'conflict')
  const allChosen = blocks.length > 0 && blocks.every((_, i) => choices[i])
  const preferred = useSetting('mergeView')
  // The picker shows whenever AI is on, so someone whose default is the API can still pick an
  // agent here; Ask AI shows when what this area would use is an agent (only an agent can edit
  // the file). Subscribed to settings so a pick shows Ask AI at once.
  const aiOn = useSetting('aiProvider') !== 'off'
  useStore((s) => s.settings)
  const agentOn = aiOn && areaTarget('conflict')?.provider === 'agent'
  /** The AI request working on this file, while it runs (a job, so leaving and coming back still shows it). */
  const asking = useRunningJob(conflictJobKey(view.id, file.path))?.id ?? null
  /** Per-file override of the setting, from the header toggle. */
  const [picked, setPicked] = useState<'three-pane' | 'blocks' | null>(null)
  const labels = useMemo(() => {
    const first = segments.find((s) => s.kind === 'conflict')
    return { ours: first?.oursLabel || 'HEAD', theirs: first?.theirsLabel || 'incoming' }
  }, [segments])

  if (!versions) return <div className="flex flex-1 items-center justify-center text-faint"><Spinner /></div>

  // Three panes need all three texts: not for delete/modify conflicts or binary files.
  const text = (s: string | null) => s !== null && !s.includes('\0')
  const canThree = versions.merged !== null && text(versions.ours) && text(versions.theirs) && (versions.base === null || text(versions.base))
  const mode = !canThree ? 'blocks' : (picked ?? (preferred === 'auto' ? (blocks.length < 3 ? 'blocks' : 'three-pane') : preferred))

  // The agent proposes; nothing is written until the user accepts (see AiDialogs ProposalDialog).
  const askAi = () => (asking ? cancelAi(asking) : resolveWithAgent(view.id, file.path))

  const resolveWith = (resolution: 'ours' | 'theirs') =>
    void run(view.id, `Take ${resolution} for ${file.path}`, () => api.resolveConflict(view.id, file.path, resolution), { quiet: true })
  const save = () =>
    void run(view.id, `Resolve ${file.path}`, () => api.resolveConflict(view.id, file.path, { content: resolveBlocks(versions.merged!, choices) }), { quiet: true })
  const saveEdited = () =>
    void run(view.id, `Resolve ${file.path}`, () => api.resolveConflict(view.id, file.path, { content: edited ?? '' }), { quiet: true })
  const markersLeft = edited === null ? 0 : countConflicts(edited)
  const markResolved = () =>
    void run(view.id, `Mark ${file.path} resolved`, () => api.resolveConflict(view.id, file.path, { content: versions.merged ?? '' }), { quiet: true })
  const { dir, name } = splitPath(file.path)

  let blockNo = -1
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="min-w-32 flex-1 truncate text-[13px]" title={file.path}><span className="text-faint">{dir}</span><span className="font-semibold">{name}</span></span>
        {/* The whole file from one side, in that side's colour. */}
        <div className="flex overflow-hidden rounded-md border border-line" role="group" aria-label="Take the whole file">
          <button onClick={() => resolveWith('ours')} disabled={versions.ours === null && versions.theirs === null}
            className="flex h-7 items-center gap-1.5 px-2.5 text-xs hover:bg-hover disabled:opacity-40" title={`Resolve the whole file with your version (${labels.ours})`}>
            <i className="size-2 rounded-sm bg-ours" /> {versions.ours === null ? 'Keep deleted (ours)' : 'Take ours'}
          </button>
          <button onClick={() => resolveWith('theirs')} className="flex h-7 items-center gap-1.5 border-l border-line px-2.5 text-xs hover:bg-hover"
            title={`Resolve the whole file with their version (${labels.theirs})`}>
            <i className="size-2 rounded-sm bg-theirs" /> {versions.theirs === null ? 'Keep deleted (theirs)' : 'Take theirs'}
          </button>
        </div>
        {aiOn && versions.merged !== null && <><ModelPicker area="conflict" agentsOnly /><PromptButton area="conflict" repoId={view.id} task={{ kind: 'resolve-conflict', path: file.path }} /></>}
        {agentOn && versions.merged !== null && (
          <Button size="sm" onClick={askAi} data-testid="ai-resolve" title={asking ? 'Stop' : 'Ask your AI agent to propose a resolution (you review it before anything is written)'}>
            {asking ? <><Spinner /> Stop</> : <><Sparkles size={12} /> Ask AI</>}
          </Button>
        )}
        <Button size="sm" variant="ghost" title="Open in your editor (Settings → Integrations)" aria-label="Open in your editor" onClick={() => void openInEditor(`${view.snapshot.path}/${file.path}`)}>
          <ExternalLink size={13} />
        </Button>
        <Button size="sm" variant="ghost" title="Resolve in your external merge tool (Settings → Diff)" aria-label="Open in the merge tool" onClick={() => void openMergeTool(view.id, file.path)} data-testid="open-merge-tool">
          <Wrench size={13} />
        </Button>
        {canThree && (
          <div className="flex overflow-hidden rounded-md border border-line" role="group" aria-label="Conflict view">
            {(['three-pane', 'blocks'] as const).map((v) => (
              <button key={v} data-testid={`view-${v}`} aria-pressed={mode === v} onClick={() => { setPicked(v); setEdited(null) }}
                className={clsx('h-7 px-2.5 text-xs', v === 'blocks' && 'border-l border-line', mode === v ? 'bg-select font-medium text-fg' : 'text-muted hover:bg-hover')}>
                {v === 'three-pane' ? 'Three panes' : 'Cards'}
              </button>
            ))}
          </div>
        )}
        {versions.merged !== null && mode === 'blocks' && (
          <Button size="sm" variant={edited !== null ? 'primary' : 'default'} data-testid="edit-result"
            onClick={() => setEdited(edited === null ? resolveBlocks(versions.merged!, choices) : null)}
            title="Edit the merged file by hand, starting from the sides picked so far">
            {edited === null ? 'Edit result' : 'Back to cards'}
          </Button>
        )}
        {edited !== null && (
          <Button size="sm" variant="primary" disabled={markersLeft > 0} onClick={saveEdited} data-testid="save-edited"
            title={markersLeft ? 'Remove the remaining conflict markers first' : 'Write this file and mark it resolved'}>
            {markersLeft ? `${markersLeft} ${markersLeft === 1 ? 'conflict' : 'conflicts'} left` : 'Save resolution'}
          </Button>
        )}
        {mode === 'blocks' && edited === null && blocks.length === 0 && versions.merged !== null && <Button size="sm" onClick={markResolved}>Mark resolved</Button>}
        {mode === 'blocks' && edited === null && blocks.length > 0 && (
          <Button size="sm" variant="primary" disabled={!allChosen} onClick={save} data-testid="save-resolution"
            title={allChosen ? 'Write this file and mark it resolved' : 'Decide every conflict first'}>
            Save resolution ({choices.filter(Boolean).length}/{blocks.length})
          </Button>
        )}
      </div>
      {mode === 'three-pane' ? (
        <Suspense fallback={<div className="flex flex-1 items-center justify-center text-faint"><Spinner /></div>}>
          <MergePanes base={versions.base ?? ''} ours={versions.ours!} theirs={versions.theirs!} labels={labels}
            onSave={(content) => void run(view.id, `Resolve ${file.path}`, () => api.resolveConflict(view.id, file.path, { content }), { quiet: true })} />
        </Suspense>
      ) : edited !== null ? (
        <div className="min-h-0 flex-1">
          <Suspense fallback={<div className="flex h-full items-center justify-center text-faint"><Spinner /></div>}>
            <ResultEditor initial={edited} onChange={setEdited} />
          </Suspense>
        </div>
      ) : (
        <div className="selectable min-h-0 flex-1 overflow-auto bg-panel px-4 py-3">
          {versions.merged === null && (
            <div className="mx-auto max-w-2xl rounded-lg border border-line bg-bg p-4 text-sm text-muted">
              This file was deleted on one side and changed on the other. Take ours or theirs to decide whether it stays.
            </div>
          )}
          {blocks.length === 0 && versions.merged !== null && (
            <div className="mb-3 text-sm text-muted">No conflict markers left in this file. Mark it resolved to stage it.</div>
          )}
          {segments.map((seg, si) => {
            if (seg.kind === 'text') {
              // A little context around each conflict instead of the whole file.
              const lines = seg.lines
              const shown = lines.length > 8 ? [...lines.slice(0, si === 0 ? 0 : 3), '⋯', ...lines.slice(-3)] : lines
              return <pre key={si} className="px-3 font-mono text-[12px] text-faint">{shown.join('\n')}</pre>
            }
            blockNo++
            const b = blockNo
            return (
              <ConflictCard key={si} seg={seg} index={b} count={blocks.length} choice={choices[b]}
                onChoose={(c) => setChoices((prev) => { const n = [...prev]; n[b] = c; return n })} />
            )
          })}
        </div>
      )}
    </div>
  )
}

const CHOICES: { value: ConflictChoice; label: string; testId: string; title: string }[] = [
  { value: 'ours', label: 'Ours', testId: 'choice-ours', title: 'Keep only your lines' },
  { value: 'theirs', label: 'Theirs', testId: 'choice-theirs', title: 'Keep only their lines' },
  { value: 'both', label: 'Both', testId: 'choice-both', title: 'Yours, then theirs' },
  { value: 'both-theirs-first', label: 'Both, theirs first', testId: 'choice-both-theirs-first', title: 'Theirs, then yours' },
  { value: 'base', label: 'Original', testId: 'choice-base', title: 'The lines as they were before either change' },
]

/**
 * One conflict: both sides next to each other (click a side to take it), a row of choices, and
 * what the file will contain here once decided, coloured by where each line came from.
 */
function ConflictCard({ seg, index, count, choice, onChoose }: {
  seg: ConflictBlock; index: number; count: number; choice: ConflictChoice | undefined; onChoose: (c: ConflictChoice) => void
}) {
  const result: { line: string; from: 'ours' | 'theirs' | 'base' }[] =
    choice === 'ours' ? seg.ours.map((line) => ({ line, from: 'ours' }))
    : choice === 'theirs' ? seg.theirs.map((line) => ({ line, from: 'theirs' }))
    : choice === 'both' ? [...seg.ours.map((line) => ({ line, from: 'ours' as const })), ...seg.theirs.map((line) => ({ line, from: 'theirs' as const }))]
    : choice === 'both-theirs-first' ? [...seg.theirs.map((line) => ({ line, from: 'theirs' as const })), ...seg.ours.map((line) => ({ line, from: 'ours' as const }))]
    : choice === 'base' ? (seg.base ?? []).map((line) => ({ line, from: 'base' }))
    : []
  const takes = (side: 'ours' | 'theirs') => choice === side || choice === 'both' || choice === 'both-theirs-first'
  return (
    <div className={clsx('my-3 overflow-hidden rounded-lg border bg-bg shadow-sm', choice ? 'border-line' : 'border-del/50')} data-testid="conflict-block" data-choice={choice ?? ''}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-xs">
        <span className={clsx('font-semibold', choice ? 'text-add' : 'text-del')}>{choice ? '✓' : '!'} Conflict {index + 1} of {count}</span>
        <div className="ml-auto flex flex-wrap overflow-hidden rounded-md border border-line" role="radiogroup" aria-label={`Conflict ${index + 1}`}>
          {CHOICES.filter((c) => c.value !== 'base' || seg.base).map((c, i) => (
            <button key={c.value} role="radio" aria-checked={choice === c.value} onClick={() => onChoose(c.value)} title={c.title} data-testid={c.testId}
              className={clsx('flex h-6 items-center gap-1 px-2', i > 0 && 'border-l border-line', choice === c.value ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-hover hover:text-fg')}>
              {c.value === 'ours' && <i className="size-1.5 rounded-sm bg-ours" />}
              {c.value === 'theirs' && <i className="size-1.5 rounded-sm bg-theirs" />}
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 font-mono text-[12px]">
        <SidePanel side="ours" label={seg.oursLabel || 'HEAD'} lines={seg.ours} taken={takes('ours')} onTake={() => onChoose(choice === 'theirs' ? 'both-theirs-first' : 'ours')} />
        <SidePanel side="theirs" label={seg.theirsLabel || 'incoming'} lines={seg.theirs} taken={takes('theirs')} onTake={() => onChoose(choice === 'ours' ? 'both' : 'theirs')} />
      </div>
      <div className="border-t border-line" data-testid="conflict-result">
        <div className="px-3 pt-1.5 text-[11px] font-semibold text-faint uppercase">Result</div>
        {choice ? (
          <pre className="px-0 pt-1 pb-2 font-mono text-[12px]">
            {result.length ? result.map((r, i) => (
              <div key={i} className="px-3" style={{ boxShadow: `inset 3px 0 0 ${r.from === 'base' ? 'var(--gs-faint)' : `var(--gs-${r.from})`}`, background: r.from === 'base' ? undefined : `color-mix(in srgb, var(--gs-${r.from}) 8%, transparent)` }}>
                {r.line || ' '}
              </div>
            )) : <div className="px-3 text-faint italic">(nothing: these lines are removed)</div>}
          </pre>
        ) : <div className="px-3 pt-0.5 pb-2 text-xs text-faint">Pick a side above, or a choice on the right.</div>}
      </div>
    </div>
  )
}

/** One side of a conflict card. Clicking it takes it (adding to the other side if that was taken). */
function SidePanel({ side, label, lines, taken, onTake }: { side: 'ours' | 'theirs'; label: string; lines: string[]; taken: boolean; onTake: () => void }) {
  return (
    <button onClick={onTake} data-testid={side === 'ours' ? 'use-ours' : 'use-theirs'} aria-pressed={taken}
      title={taken ? `${side === 'ours' ? 'Your' : 'Their'} lines are in the result` : `Take ${side === 'ours' ? 'your' : 'their'} lines`}
      className={clsx('min-w-0 text-left', side === 'theirs' && 'border-l border-line')}
      style={{ background: `color-mix(in srgb, var(--gs-${side}) ${taken ? 16 : 5}%, transparent)`, boxShadow: taken ? `inset 0 0 0 2px var(--gs-${side})` : undefined }}>
      <div className="flex items-center gap-2 px-3 py-1 font-sans text-[11px]">
        <span className={clsx('rounded px-1 font-bold text-white', side === 'ours' ? 'bg-ours' : 'bg-theirs')}>{side === 'ours' ? 'A' : 'B'}</span>
        <span className="min-w-0 flex-1 truncate font-semibold text-muted">{side === 'ours' ? 'Yours' : 'Theirs'} ({label})</span>
        <span className={clsx('shrink-0', taken ? 'font-semibold' : 'text-faint')} style={taken ? { color: `var(--gs-${side})` } : undefined}>{taken ? '✓ in result' : 'Click to take'}</span>
      </div>
      <pre className="overflow-x-auto px-3 pb-2">{lines.length ? lines.join('\n') : <span className="text-faint italic">(nothing)</span>}</pre>
    </button>
  )
}
