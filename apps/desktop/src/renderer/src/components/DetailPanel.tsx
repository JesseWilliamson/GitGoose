import type { CommitDetails, DiffTarget, StatusEntry } from '@gitsquid/shared'
import { Check, Copy, Minus, Plus, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { copy, discard as discardFiles, openInEditor, pop, run, stashApply, stashDrop } from '../lib/actions'
import { api } from '../lib/api'
import { dateTime, hashColor, initials, laneColor, sentence, shortHash } from '../lib/format'
import { ensureLoaded, reportError, setting, updateRepo, type FileMode, type RepoView } from '../lib/store'
import { FileRow, statusKind } from './FileList'
import { modName } from '../lib/keys'
import { Button, CM, SectionHeader, Spinner } from './ui'

export function DetailPanel({ view }: { view: RepoView }) {
  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-panel" data-testid="detail-panel">
      {view.selected.kind === 'wip' ? <WipPanel view={view} /> : <CommitPanel view={view} hash={view.selected.hash} />}
    </aside>
  )
}

const isOpen = (view: RepoView, t: DiffTarget) =>
  view.center.kind === 'file' && view.center.target.kind === t.kind && view.center.target.path === t.path &&
  (t.kind !== 'commit' || (view.center.target.kind === 'commit' && view.center.target.hash === t.hash))

function openFile(view: RepoView, target: DiffTarget, mode: FileMode = 'diff') {
  updateRepo(view.id, { center: { kind: 'file', target, mode } })
}

/** Right-click menu for a file in any list. Extra items (stage, discard...) come from the caller. */
function FileMenu({ view, target, children }: { view: RepoView; target: DiffTarget; children?: React.ReactNode }) {
  const abs = `${view.snapshot.path}/${target.path}`
  return (
    <CM.Content>
      <CM.Label>{target.path}</CM.Label>
      {children}
      {children && <CM.Separator />}
      <CM.Item onSelect={() => openFile(view, target, 'diff')}>Show changes</CM.Item>
      {target.kind !== 'untracked' && <CM.Item onSelect={() => openFile(view, target, 'history')}>File history</CM.Item>}
      {target.kind !== 'untracked' && <CM.Item onSelect={() => openFile(view, target, 'blame')}>Blame</CM.Item>}
      <CM.Separator />
      {target.kind !== 'commit' && <CM.Item onSelect={() => void openInEditor(abs)}>Open in editor</CM.Item>}
      <CM.Item onSelect={() => void api.openPath(abs).catch((e) => reportError('Could not open the file', e))}>Open with default app</CM.Item>
      <CM.Item onSelect={() => void api.revealPath(abs)}>Reveal in file manager</CM.Item>
      <CM.Item onSelect={() => copy(target.path, 'Copied path')}>Copy path</CM.Item>
    </CM.Content>
  )
}

// ------------------------------------------------------------------ uncommitted changes

function WipPanel({ view }: { view: RepoView }) {
  const st = view.snapshot.status
  const unstaged = st.filter((e) => e.kind === 'untracked' || (e.kind !== 'unmerged' && e.worktree !== '.'))
  const staged = st.filter((e) => e.kind !== 'untracked' && e.kind !== 'unmerged' && e.index !== '.')
  const conflicted = st.filter((e) => e.kind === 'unmerged')
  const id = view.id

  const stage = (paths: string[]) => run(id, 'Stage', () => api.stagePaths(id, paths), { quiet: true })
  const unstage = (paths: string[]) => run(id, 'Unstage', () => api.unstagePaths(id, paths), { quiet: true })
  const discard = (paths: string[]) => discardFiles(id, paths)

  const unstagedTarget = (e: StatusEntry): DiffTarget => (e.kind === 'untracked' ? { kind: 'untracked', path: e.path } : { kind: 'unstaged', path: e.path })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line px-3 py-2 text-[13px]">
        <span className="font-semibold">{st.length} file {st.length === 1 ? 'change' : 'changes'}</span>
        <span className="text-muted"> on {view.snapshot.head.branch ?? (view.snapshot.head.detached ? 'detached HEAD' : 'a new branch')}</span>
      </div>
      {view.snapshot.operation && (
        <div className="flex items-center justify-between gap-2 border-b border-line bg-warn/10 px-3 py-2 text-[13px]">
          <span><b>{sentence(view.snapshot.operation)}</b> in progress{conflicted.length ? `, ${conflicted.length} conflicted` : ''}</span>
          <Button size="sm" onClick={() => updateRepo(id, { center: { kind: 'conflicts' } })}>Resolve…</Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col" data-testid="unstaged">
          <SectionHeader right={unstaged.length > 0 && (
            <span className="flex gap-1 normal-case">
              <Button size="sm" variant="ghost" onClick={() => void discard(unstaged.map((e) => e.path))} title="Discard all unstaged changes (undoable)">Discard all</Button>
              <Button size="sm" onClick={() => void stage(unstaged.map((e) => e.path))} data-testid="stage-all">Stage all</Button>
            </span>
          )}>Unstaged ({unstaged.length})</SectionHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {unstaged.map((e) => {
              const t = unstagedTarget(e)
              return (
                <FileRow key={e.path} path={e.path} kind={statusKind(e.worktree === '.' ? e.index : e.worktree)} testId="unstaged-file"
                  selected={isOpen(view, t)} onClick={() => openFile(view, t)}
                  menu={<FileMenu view={view} target={t}>
                    <CM.Item onSelect={() => void stage([e.path])}>Stage</CM.Item>
                    <CM.Item onSelect={() => void discard([e.path])}>{e.kind === 'untracked' ? 'Delete (undoable)' : 'Discard changes (undoable)'}</CM.Item>
                    {e.kind === 'untracked' && (
                      <CM.Item onSelect={() => void run(id, `Ignore ${e.path}`, () => api.ignorePaths(id, [e.path]))}>Add to .gitignore</CM.Item>
                    )}
                  </FileMenu>}
                  actions={<>
                    <IconAction title="Discard changes (undoable)" onClick={() => void discard([e.path])}><Undo2 size={12} /></IconAction>
                    <IconAction title="Stage file" onClick={() => void stage([e.path])}><Plus size={12} /></IconAction>
                  </>} />
              )
            })}
            {unstaged.length === 0 && <div className="px-3 py-2 text-xs text-faint">No unstaged changes</div>}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col border-t border-line" data-testid="staged">
          <SectionHeader right={staged.length > 0 && <Button size="sm" onClick={() => void unstage(staged.map((e) => e.path))}>Unstage all</Button>}>
            Staged ({staged.length})
          </SectionHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {staged.map((e) => {
              const t: DiffTarget = { kind: 'staged', path: e.path }
              return (
                <FileRow key={e.path} path={e.path} oldPath={e.origPath} kind={statusKind(e.index)} testId="staged-file"
                  selected={isOpen(view, t)} onClick={() => openFile(view, t)}
                  menu={<FileMenu view={view} target={t}><CM.Item onSelect={() => void unstage([e.path])}>Unstage</CM.Item></FileMenu>}
                  actions={<IconAction title="Unstage file" onClick={() => void unstage([e.path])}><Minus size={12} /></IconAction>} />
              )
            })}
            {staged.length === 0 && <div className="px-3 py-2 text-xs text-faint">Stage files or lines to commit them</div>}
          </div>
        </div>
      </div>
      <CommitBox view={view} stagedCount={staged.length} />
    </div>
  )
}

function IconAction({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} onClick={(e) => { e.stopPropagation(); onClick() }}
      className="flex size-5 items-center justify-center rounded border border-line bg-raised text-muted hover:text-fg">
      {children}
    </button>
  )
}

function CommitBox({ view, stagedCount }: { view: RepoView; stagedCount: number }) {
  const [summary, setSummary] = useState('')
  const [body, setBody] = useState('')
  const [amend, setAmend] = useState(false)
  const id = view.id
  const canCommit = summary.trim().length > 0 && (stagedCount > 0 || amend) && !view.busy

  const toggleAmend = async (on: boolean) => {
    setAmend(on)
    if (on && !summary && !body) {
      const msg = await api.lastCommitMessage(id)
      const [first, ...rest] = msg.split('\n')
      setSummary(first ?? '')
      setBody(rest.join('\n').trim())
    }
  }

  const commit = async () => {
    if (!canCommit) return
    const message = body.trim() ? `${summary.trim()}\n\n${body.trim()}\n` : `${summary.trim()}\n`
    const opts = { amend, signOff: setting('signOff'), gpgSign: setting('gpgSign') }
    const ok = await run(id, amend ? 'Amend commit' : 'Commit', () => api.commit(id, message, opts), { success: amend ? 'Commit amended' : 'Committed' })
    if (ok) {
      setSummary('')
      setBody('')
      setAmend(false)
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void commit()
    }
  }

  return (
    <div className="border-t border-line p-3" data-testid="commit-box">
      <div className="relative">
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={onKey}
          placeholder="Summary"
          style={{ fontFamily: 'var(--gs-code-font)' }}
          data-testid="commit-summary"
          className="h-8 w-full rounded-md border border-line bg-bg px-2 pr-9 text-[13px] outline-none focus:border-accent"
        />
        <span className={`absolute top-2 right-2 text-[10px] ${summary.length > 72 ? 'text-warn' : 'text-faint'}`}>{summary.length}</span>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKey}
        placeholder="Description"
        style={{ fontFamily: 'var(--gs-code-font)', fontSize: 'var(--gs-code-size)' }}
        rows={3}
        className="mt-2 w-full resize-none rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] outline-none focus:border-accent"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={amend} onChange={(e) => void toggleAmend(e.target.checked)} disabled={!view.snapshot.head.hash} />
          Amend previous commit
        </label>
        <Button variant="primary" disabled={!canCommit} onClick={() => void commit()} data-testid="commit-button" title={`Commit (${modName()}+Enter)`}>
          {view.busy === 'Commit' ? <Spinner /> : <Check size={14} />}
          {amend ? 'Amend' : stagedCount ? `Commit ${stagedCount} ${stagedCount === 1 ? 'file' : 'files'}` : 'Commit'}
        </Button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ a commit

// Keyed by hash: a commit's details never change. (Stashes are commits with unique hashes too.)
const detailsCache = new Map<string, CommitDetails>()

function CommitPanel({ view, hash }: { view: RepoView; hash: string }) {
  const [details, setDetails] = useState<CommitDetails | null>(() => detailsCache.get(hash) ?? null)
  const latest = useRef(hash)
  useEffect(() => {
    latest.current = hash
    const cached = detailsCache.get(hash)
    if (cached) {
      setDetails(cached)
      return
    }
    setDetails(null)
    const isStash = view.stashes.some((s) => s.hash === hash)
    api.commitDetails(view.id, hash, { stash: isStash }).then((d) => {
      if (detailsCache.size > 500) detailsCache.clear()
      detailsCache.set(hash, d)
      if (latest.current === hash) setDetails(d)
    }, (e) => reportError('Could not load commit', e))
  }, [hash, view.id])

  if (!details) return <div className="flex flex-1 items-center justify-center text-faint"><Spinner /></div>
  const d = details
  // A stash is a commit too: its first parent is where it was made, so the file list is its changes.
  const stash = view.stashes.find((s) => s.hash === d.hash)
  const adds = d.files.reduce((n, f) => n + f.additions, 0)
  const dels = d.files.reduce((n, f) => n + f.deletions, 0)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {stash && (
        <div className="flex items-center gap-2 border-b border-line bg-accent/10 px-3 py-2 text-[13px]" data-testid="stash-header">
          <span className="min-w-0 flex-1 truncate"><b>Stash</b> {stash.ref}</span>
          <Button size="sm" onClick={() => void stashApply(view.id, stash.index)}>Apply</Button>
          <Button size="sm" variant="primary" onClick={() => {
            // The stash is about to disappear: show the changes it brings back instead.
            updateRepo(view.id, { selected: { kind: 'wip' }, center: { kind: 'graph' } })
            pop(view.id, stash.index)
          }}>Pop</Button>
          <Button size="sm" variant="ghost" onClick={() => {
            updateRepo(view.id, { selected: { kind: 'wip' }, center: { kind: 'graph' } })
            void stashDrop(view.id, stash.index)
          }}>Drop</Button>
        </div>
      )}
      <div className="selectable border-b border-line p-3">
        <div className="text-[14px] leading-snug font-semibold">{stash ? stash.message : d.subject}</div>
        {d.body && <pre className="mt-2 max-h-40 overflow-y-auto font-sans text-[13px] whitespace-pre-wrap text-muted">{d.body}</pre>}
        <div className="mt-3 flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: laneColor(hashColor(d.authorEmail)) }}>
            {initials(d.authorName)}
          </span>
          <div className="min-w-0 text-xs">
            <div className="truncate"><b>{d.authorName}</b> <span className="text-faint">&lt;{d.authorEmail}&gt;</span></div>
            <div className="text-muted">authored {dateTime(d.authorDate)}</div>
            {(d.committerEmail !== d.authorEmail || d.commitDate !== d.authorDate) && (
              <div className="text-faint">committed by {d.committerName}, {dateTime(d.commitDate)}</div>
            )}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted">
          <button className="flex items-center gap-1 hover:text-fg" onClick={() => copy(d.hash, 'Copied SHA')} title="Copy SHA">
            {shortHash(d.hash)} <Copy size={11} />
          </button>
          {d.parents.map((p) => (
            <button key={p} className="hover:text-accent" title="Go to parent"
              onClick={() => { updateRepo(view.id, { selected: { kind: 'commit', hash: p } }); void ensureLoaded(view.id, p) }}>
              parent {shortHash(p)}
            </button>
          ))}
        </div>
      </div>
      <SectionHeader right={<span className="font-mono normal-case"><span className="text-add">+{adds}</span> <span className="text-del">−{dels}</span></span>}>
        {d.files.length} {d.files.length === 1 ? 'file' : 'files'} changed{d.parents.length > 1 && !stash ? ' (vs first parent)' : ''}
      </SectionHeader>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2" data-testid="commit-files">
        {d.files.map((f) => {
          const t: DiffTarget = { kind: 'commit', hash: d.hash, path: f.path }
          return (
            <FileRow key={f.path} path={f.path} oldPath={f.oldPath} kind={f.change} selected={isOpen(view, t)} testId="commit-file"
              onClick={() => openFile(view, t)}
              menu={<FileMenu view={view} target={t} />}
              stats={f.binary ? <span className="text-[11px] text-faint">bin</span> : (
                <span className="shrink-0 font-mono text-[11px]"><span className="text-add">+{f.additions}</span> <span className="text-del">−{f.deletions}</span></span>
              )} />
          )
        })}
      </div>
    </div>
  )
}
