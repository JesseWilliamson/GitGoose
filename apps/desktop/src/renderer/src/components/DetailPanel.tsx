import type { ChangedFile, CommitDetails, DiffTarget, StatusEntry } from '@gitgoose/shared'
import type { Identity, Person, Signature } from '@gitgoose/shared'
import { Archive, Check, ChevronDown, Copy, MessagesSquare, Minus, MoreHorizontal, Plus, ShieldAlert, ShieldCheck, Sparkles, Undo2, X } from 'lucide-react'
import clsx from 'clsx'
import { DropdownMenu } from 'radix-ui'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { openFile as openFileIn, copy, discard as discardFiles, lfsLock, lfsPatternFor, lfsTrack, openDiffTool, openInEditor, pop, restoreFileFrom, run, snapshot, stashApply, stashDrop, stashToBranch, stashWith, stashWithMessage } from '../lib/actions'
import { cancelAi, openInPanel, startAi, useAi, useAiEnabled } from '../lib/ai'
import { api } from '../lib/api'
import { dateTime, opName, relativeTime, sentence, shortHash, stashLabel } from '../lib/format'
import { avatarSrc } from '../lib/avatar'
import { addTrailer, isUntouched, splitTemplate } from '../lib/commitMessage'
import { composeAction, impactAction, reviewAction, walkthroughAction } from '../lib/aiActions'
import { openAsk } from '../lib/ask'
import { closeExplanation, explainCommit, useExplanation } from '../lib/explain'
import { Markdown } from './Markdown'
import { chainBase, ensureLoaded, getLog, reportError, selectCommit, setting, toast, updateRepo, useSetting, useStore, type FileMode, type RepoView } from '../lib/store'
import { Avatar } from './Avatar'
import { actOn, clickFile, NO_FILES, pruneFiles, type FileSelection } from '../lib/fileSelection'
import { ChangeHints } from './ChangeHints'
import { FileView } from './DiffView'
import { isShown } from '../lib/openFile'
import { setFirstFile, useShownFile } from '../lib/shownFile'
import { isPaneVisible } from '@gitgoose/shared'
import { FileListTools, FileListView, FileRow, statusKind } from './FileList'
import { modName } from '../lib/keys'
import { Button, CM, DM, SectionHeader, Spinner } from './ui'
import { firstReason, whyNotAi, whyNotWithoutStaged } from '../lib/menuRules'
import { AiTargetButton } from './AiTargetButton'

/** The commit box's request (one object, so its Prompt panel does not rebuild every render). */
const COMMIT_TASK = { kind: 'commit-message' } as const

const isMac = window.gitgoose?.platform === 'darwin'

/**
 * The selection's details over the file it shows (ADR-011): the open file when it belongs to the
 * selection, else the selection's first file, which the panel reports with useFirstFile. The
 * details take what they need, up to half the pane; the file takes the rest. Lists inside the
 * details shrink first; when even their least (the working copy's two lists and the commit box)
 * does not fit, the top half scrolls rather than spill over the file. When the file has a place of
 * its own (the Diff pane on screen, or the centre while reading wide), Details is the details only,
 * full height.
 */
export function DetailPanel({ view }: { view: RepoView }) {
  const layout = useSetting('layout')
  const elsewhere = view.diffWide || isPaneVisible(layout, 'diff')
  const shown = useShownFile(view)
  const file = elsewhere ? null : shown
  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-card" data-testid="detail-panel">
      <div className={clsx('flex min-h-0 flex-col overflow-y-auto', file ? 'max-h-1/2 shrink-0' : 'flex-1')} data-testid="details-top">
        {view.selected.kind === 'wip' ? <WipPanel view={view} />
          : view.selected.kind === 'commits' ? <MultiPanel view={view} hashes={view.selected.hashes} />
          : view.selected.kind === 'compare' ? <ComparePanel view={view} sel={view.selected} />
          : <CommitPanel view={view} hash={view.selected.hash} />}
      </div>
      {file && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-border bg-background">
          <FileView view={view} target={file.target} mode={file.mode} />
        </div>
      )}
    </aside>
  )
}

/** A panel says which file is its selection's first (null: none, or not loaded yet). Returns it, for isShown. */
function useFirstFile(repoId: string, first: DiffTarget | null): DiffTarget | null {
  const key = JSON.stringify(first)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- by content: `first` is a new object every render
  useEffect(() => setFirstFile(repoId, first), [repoId, key])
  return first
}

function openFile(view: RepoView, target: DiffTarget, mode: FileMode = 'diff') {
  openFileIn(view.id, target, mode)
}

/** Right-click menu for a file in any list. Extra items (stage, discard...) come from the caller. */
function FileMenu({ view, target, children }: { view: RepoView; target: DiffTarget; children?: React.ReactNode }) {
  const abs = `${view.snapshot.path}/${target.path}`
  /** The revision the listed file is at, when it is not the working copy. */
  const rev = target.kind === 'commit' ? target.hash : target.kind === 'range' ? target.to : null
  return (
    <CM.Content>
      <CM.Label>{target.path}</CM.Label>
      {children}
      {children && <CM.Separator />}
      <CM.Item onSelect={() => openFile(view, target, 'diff')}>Show changes</CM.Item>
      {target.kind !== 'untracked' && <CM.Item onSelect={() => void openDiffTool(view.id, target)}>Open in diff tool</CM.Item>}
      {/* Flat, not a submenu: this menu sits at the window's right edge, where submenus open leftwards and are fiddly. */}
      {view.lfs?.installed && (target.kind === 'unstaged' || target.kind === 'untracked' || target.kind === 'staged') && (
        <>
          <CM.Separator />
          {!view.lfs.files.some((f) => f.path === target.path) && <CM.Item onSelect={() => lfsTrack(view.id, lfsPatternFor(target.path))}>Track {lfsPatternFor(target.path)} with Git LFS</CM.Item>}
          {view.lfs.used && <CM.Item onSelect={() => void lfsLock(view.id, target.path, true)}>Lock with Git LFS</CM.Item>}
          {view.lfs.used && <CM.Item onSelect={() => void lfsLock(view.id, target.path, false)}>Unlock (Git LFS)</CM.Item>}
        </>
      )}
      {target.kind !== 'untracked' && <CM.Item onSelect={() => openFile(view, target, 'history')}>File history</CM.Item>}
      {target.kind !== 'untracked' && <CM.Item onSelect={() => openFile(view, target, 'blame')}>Blame</CM.Item>}
      {rev && (
        <>
          <CM.Separator />
          <CM.Item onSelect={() => void api.openFileAt(view.id, rev, target.path).catch((e) => reportError('Could not open the file', e))}>Open this version</CM.Item>
          <CM.Item onSelect={() => void api.saveFileAt(view.id, rev, target.path).catch((e) => reportError('Could not save the file', e))}>Save this version as…</CM.Item>
          <CM.Item onSelect={() => void restoreFileFrom(view.id, target.path, rev)}>{view.stashes.some((s) => s.hash === rev) ? 'Take this file from the stash' : 'Restore the working copy to this version'}</CM.Item>
          {target.kind === 'commit' && !view.stashes.some((s) => s.hash === rev) && (
            <CM.Item onSelect={() => void run(view.id, `Restore ${target.path}`, () => api.restoreFile(view.id, target.path, `${target.hash}^`))}>Restore the working copy to before this commit</CM.Item>
          )}
        </>
      )}
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
  const aiOn = useAiEnabled()
  const aiWhy = aiOn ? undefined : whyNotAi(undefined)
  const st = view.snapshot.status
  const unstaged = st.filter((e) => e.kind === 'untracked' || (e.kind !== 'unmerged' && e.worktree !== '.'))
  const staged = st.filter((e) => e.kind !== 'untracked' && e.kind !== 'unmerged' && e.index !== '.')
  const conflicted = st.filter((e) => e.kind === 'unmerged')
  const id = view.id

  const stage = (paths: string[]) => run(id, 'Stage', () => api.stagePaths(id, paths), { quiet: true })
  const unstage = (paths: string[]) => run(id, 'Unstage', () => api.unstagePaths(id, paths), { quiet: true })
  const discard = (paths: string[]) => discardFiles(id, paths)

  const [filter, setFilter] = useState('')
  // Several files selected with Shift- and Ctrl/Cmd-click, in one section at a time (a file can
  // be in both, partly staged, and an action on the selection must mean one thing).
  const [picked, setPicked] = useState<{ repoId: string; section: 'unstaged' | 'staged' } & FileSelection>({ repoId: id, section: 'unstaged', ...NO_FILES })
  const active = picked.repoId === id ? picked : { repoId: id, section: 'unstaged' as const, ...NO_FILES }
  const sel = { ...active, ...pruneFiles(active, (active.section === 'unstaged' ? unstaged : staged).map((e) => e.path)) }
  const onFileClick = (section: 'unstaged' | 'staged', order: string[], path: string, t: DiffTarget, e: React.MouseEvent) => {
    const mods = { range: e.shiftKey, toggle: isMac ? e.metaKey : e.ctrlKey }
    const next = clickFile(sel.section === section ? sel : NO_FILES, order, path, mods)
    setPicked({ repoId: id, section, ...next })
    // The diff follows the click, unless the click took the file out of the selection.
    if (next.paths.includes(path)) openFile(view, t)
  }
  const unstagedTarget = (e: StatusEntry): DiffTarget => (e.kind === 'untracked' ? { kind: 'untracked', path: e.path } : { kind: 'unstaged', path: e.path })
  const first = useFirstFile(view.id, unstaged[0] ? unstagedTarget(unstaged[0]) : staged[0] ? { kind: 'staged', path: staged[0].path } : null)
  const isSelected = (section: 'unstaged' | 'staged', path: string, t: DiffTarget) =>
    sel.section === section && sel.paths.length > 0 ? sel.paths.includes(path) : isShown(view, first, t)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold">{st.length} file {st.length === 1 ? 'change' : 'changes'}</span>
          <span className="text-muted-foreground"> on {view.snapshot.head.branch ?? (view.snapshot.head.detached ? 'detached HEAD' : 'a new branch')}</span>
        </span>
        {st.length > 0 && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button size="sm" variant="ghost" data-testid="review-menu" title="Review, explain or assess these changes"><Sparkles size={12} /> Review</Button>
            </DropdownMenu.Trigger>
            <DM.Content align="end">
              <DM.Item reason={aiWhy} onSelect={() => composeAction(id, reviewAction({ kind: 'working' }))}>Review all uncommitted changes…</DM.Item>
              <DM.Item reason={firstReason(aiWhy, whyNotWithoutStaged(staged.length))} onSelect={() => composeAction(id, reviewAction({ kind: 'staged' }))}>Review staged changes…</DM.Item>
              <DM.Item reason={aiWhy} onSelect={() => composeAction(id, walkthroughAction({ kind: 'working' }))}>Walk me through these changes…</DM.Item>
              <DM.Separator />
              <DM.Item onSelect={() => composeAction(id, impactAction({ kind: 'working' }))}>What could these changes affect?…</DM.Item>
            </DM.Content>
          </DropdownMenu.Root>
        )}
        {st.length > 0 && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button size="sm" variant="ghost" data-testid="stash-menu"><Archive size={12} /> Stash <ChevronDown size={12} /></Button>
            </DropdownMenu.Trigger>
            <DM.Content align="end">
              <DM.Item onSelect={() => void stashWith(id, {})}>Stash all changes</DM.Item>
              <DM.Item onSelect={() => stashWithMessage(id)}>Stash with a message…</DM.Item>
              <DM.Item onSelect={() => void snapshot(id)}>Save a snapshot (changes stay as they are)</DM.Item>
              <DM.Separator />
              <DM.Item reason={whyNotWithoutStaged(staged.length)} onSelect={() => void stashWith(id, { staged: true })}>Stash only the staged changes</DM.Item>
              <DM.Item reason={whyNotWithoutStaged(staged.length)} onSelect={() => void stashWith(id, { keepIndex: true })}>Stash all, keep the staged changes in place</DM.Item>
            </DM.Content>
          </DropdownMenu.Root>
        )}
      </div>
      {st.length > 0 && <FileListTools filter={filter} onFilter={setFilter} />}
      {view.snapshot.operation && (
        <div className="flex items-center justify-between gap-2 border-b border-border bg-warn/10 px-3 py-2 text-sm">
          <span><b>{sentence(opName(view.snapshot.operation))}</b> in progress{conflicted.length ? `, ${conflicted.length} conflicted` : ''}</span>
          <Button size="sm" onClick={() => updateRepo(id, { center: { kind: 'conflicts' } })}>Resolve…</Button>
        </div>
      )}
      {/* No min-h-0: the lists stop shrinking at their least (FitSection's three rows each), so with
          a file under them the commit box stays below them and the top of Details scrolls instead. */}
      <div className="flex flex-1 flex-col">
        <FitSection testId="unstaged" header={
          <SectionHeader right={unstaged.length > 0 && (
            <span className="flex gap-1 normal-case">
              <Button size="sm" variant="ghost" onClick={() => void discard(unstaged.map((e) => e.path))} title="Discard all unstaged changes">Discard all</Button>
              <Button size="sm" onClick={() => void stage(unstaged.map((e) => e.path))} data-testid="stage-all">Stage all</Button>
            </span>
          )}>Unstaged ({unstaged.length})</SectionHeader>
        }>
            <FileListView items={unstaged} pathOf={(e) => e.path} filter={filter} testId="unstaged"
              folderActions={(paths) => <>
                <IconAction title="Discard changes in this folder" onClick={() => void discard(paths)}><Undo2 size={12} /></IconAction>
                <IconAction title="Stage folder" onClick={() => void stage(paths)}><Plus size={12} /></IconAction>
              </>}
              renderFile={(e, { order, ...layout }) => {
              const t = unstagedTarget(e)
              // On a row that is part of a selection of several files, every action takes them all.
              const paths = sel.section === 'unstaged' ? actOn(sel, e.path) : [e.path]
              const n = paths.length > 1 ? ` ${paths.length} files` : ''
              return (
                <FileRow key={e.path} {...layout} path={e.path} kind={statusKind(e.worktree === '.' ? e.index : e.worktree)} testId="unstaged-file"
                  drag={{ kind: 'files', rev: 'worktree', paths }}
                  selected={isSelected('unstaged', e.path, t)} onClick={(ev) => onFileClick('unstaged', order, e.path, t, ev)}
                  menu={<FileMenu view={view} target={t}>
                    <CM.Item onSelect={() => void stage(paths)}>Stage{n}</CM.Item>
                    <CM.Item onSelect={() => void stashWith(id, { paths })}>{n ? `Stash${n}` : 'Stash this file'}</CM.Item>
                    <CM.Item onSelect={() => void discard(paths)}>{n ? `Discard changes in${n}` : e.kind === 'untracked' ? 'Delete' : 'Discard changes'}</CM.Item>
                    {e.kind === 'untracked' && (
                      <CM.Item onSelect={() => void run(id, `Ignore ${e.path}`, () => api.ignorePaths(id, [e.path]))}>Add to .gitignore</CM.Item>
                    )}
                  </FileMenu>}
                  actions={<>
                    <IconAction title={n ? `Discard changes in${n}` : 'Discard changes'} onClick={() => void discard(paths)}><Undo2 size={12} /></IconAction>
                    <IconAction title={n ? `Stage${n}` : 'Stage file'} onClick={() => void stage(paths)}><Plus size={12} /></IconAction>
                  </>} />
              )
            }} />
            {unstaged.length === 0 && <div className="px-3 py-1 text-xs text-hint">No unstaged changes</div>}
        </FitSection>
        <FitSection testId="staged" headerClassName="border-t border-border" header={
          <SectionHeader right={staged.length > 0 && <Button size="sm" onClick={() => void unstage(staged.map((e) => e.path))}>Unstage all</Button>}>
            Staged ({staged.length})
          </SectionHeader>
        }>
            <FileListView items={staged} pathOf={(e) => e.path} filter={filter} testId="staged"
              folderActions={(paths) => <IconAction title="Unstage folder" onClick={() => void unstage(paths)}><Minus size={12} /></IconAction>}
              renderFile={(e, { order, ...layout }) => {
              const t: DiffTarget = { kind: 'staged', path: e.path }
              const paths = sel.section === 'staged' ? actOn(sel, e.path) : [e.path]
              const n = paths.length > 1 ? ` ${paths.length} files` : ''
              return (
                <FileRow key={e.path} {...layout} path={e.path} oldPath={e.origPath} kind={statusKind(e.index)} testId="staged-file"
                  drag={{ kind: 'files', rev: 'worktree', paths }}
                  selected={isSelected('staged', e.path, t)} onClick={(ev) => onFileClick('staged', order, e.path, t, ev)}
                  menu={<FileMenu view={view} target={t}>
                    <CM.Item onSelect={() => void unstage(paths)}>Unstage{n}</CM.Item>
                    <CM.Item onSelect={() => void stashWith(id, { paths })}>{n ? `Stash${n}` : 'Stash this file'}</CM.Item>
                  </FileMenu>}
                  actions={<IconAction title={n ? `Unstage${n}` : 'Unstage file'} onClick={() => void unstage(paths)}><Minus size={12} /></IconAction>} />
              )
            }} />
            {staged.length === 0 && <div className="px-3 py-1 text-xs text-hint">Nothing staged</div>}
        </FitSection>
      </div>
      <ChangeHints view={view} />
      <CommitBox view={view} stagedCount={staged.length} />
    </div>
  )
}

/**
 * Unstaged and Staged share the panel's height by content, not half and half: a list of three
 * files takes the height of three files (and its header), and the other section gets the rest.
 * Two long lists still split the height evenly.
 *
 * How: both sections may grow equally (`flex-1 basis-0`), but each is capped at its natural
 * height (the header plus the whole list, measured), so a short list stops growing and the
 * space it does not want goes to the other one. The cap is a measurement, not a guess, because
 * folders, long names and the empty message change the height. A list never shrinks below
 * three rows (or its whole height, if that is less), so a long one next to a short one does
 * not squeeze the short one into a sliver.
 */
const MIN_LIST = 72
function FitSection({ testId, header, headerClassName, children }: { testId: string; header: React.ReactNode; headerClassName?: string; children: React.ReactNode }) {
  const head = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [nat, setNat] = useState<{ head: number; list: number } | null>(null)
  useLayoutEffect(() => {
    const h = head.current
    const l = list.current
    if (!h || !l) return
    const measure = () => setNat((n) => (n && n.head === h.offsetHeight && n.list === l.offsetHeight ? n : { head: h.offsetHeight, list: l.offsetHeight }))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(h)
    ro.observe(l)
    return () => ro.disconnect()
  }, [])
  return (
    <div className="flex min-h-0 flex-1 basis-0 flex-col" data-testid={testId}
      style={nat ? { maxHeight: nat.head + nat.list, minHeight: nat.head + Math.min(nat.list, MIN_LIST) } : undefined}>
      <div ref={head} className={headerClassName}>{header}</div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div ref={list}>{children}</div>
      </div>
    </div>
  )
}

function IconAction({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} onClick={(e) => { e.stopPropagation(); onClick() }}
      className="flex size-5 items-center justify-center rounded border border-border bg-popover text-muted-foreground hover:text-foreground">
      {children}
    </button>
  )
}

function CommitBox({ view, stagedCount }: { view: RepoView; stagedCount: number }) {
  const [summary, setSummary] = useState('')
  const [body, setBody] = useState('')
  const [amend, setAmend] = useState(false)
  /** Skip the pre-commit and commit-msg hooks for the next commit (it resets after committing). */
  const [noVerify, setNoVerify] = useState(false)
  const id = view.id
  const [identity, setIdentity] = useState<Identity | null>(null)
  /** Co-authored-by trailers credit the people who wrote the change with you (GitHub shows them). */
  const pickCoAuthor = async () => {
    const people: Person[] = await api.recentAuthors(id).catch(() => [])
    const others = people.filter((p) => p.email !== identity?.email)
    if (!others.length) return toast({ kind: 'info', title: 'No other authors in this repository yet' })
    useStore.setState({
      dialog: {
        kind: 'pick', title: 'Add a co-author', placeholder: 'Name or email',
        items: others.map((p) => ({ label: p.name, detail: p.email, value: `${p.name} <${p.email}>` })),
        onPick: (who) => setBody((b) => addTrailer(b, `Co-authored-by: ${who}`)),
      },
    })
  }
  // Who we commit as; re-read after undo / redo (they can change it) and after the dialog saves.
  const [identityTick, setIdentityTick] = useState(0)
  const undoKey = `${view.undo[0]?.id}|${view.redo.length}`
  useEffect(() => {
    let live = true
    void api.identity(id).then((i) => live && setIdentity(i), () => {})
    return () => {
      live = false
    }
  }, [id, identityTick, undoKey])
  // commit.template: prefill what is not a comment, show the comments as guidance.
  const template = useRef<{ summary: string; body: string; hint: string } | null>(null)
  const [hint, setHint] = useState('')
  useEffect(() => {
    let live = true
    void api.commitTemplate(id).then((t) => {
      if (!live || !t) return
      const parts = splitTemplate(t)
      template.current = parts
      setHint(parts.hint)
      setSummary((s) => s || parts.summary)
      setBody((b) => b || parts.body)
    }, () => {})
    return () => {
      live = false
    }
  }, [id])
  // A message that is still exactly the template has not been written.
  const canCommit = summary.trim().length > 0 && (stagedCount > 0 || amend) && !view.busy && !(template.current && isUntouched(summary, body, template.current))
  const aiOn = useAiEnabled()
  // After a squash merge (or a merge stopped before its commit) git prepares a message: offer it.
  const prepared = useRef('')
  const opKey = `${view.snapshot.operation}|${stagedCount}`
  useEffect(() => {
    let live = true
    void api.preparedMessage(id).then((m) => {
      if (!live || !m || m === prepared.current) return
      prepared.current = m
      const [first, ...rest] = m.split('\n')
      setSummary((s) => s || (first ?? ''))
      setBody((b) => b || rest.join('\n').trim())
    }, () => {})
    return () => {
      live = false
    }
  }, [id, opKey])
  /** The AI request writing the message, while it runs. */
  const [writing, setWriting] = useState<string | null>(null)
  // A commit message applied from a chat (lib/artifacts.ts) replaces the draft; Undo puts it back.
  const incoming = useAi((s) => (s.draft?.repoId === id ? s.draft : null))
  useEffect(() => {
    if (!incoming) return
    useAi.setState({ draft: null })
    const before = { summary, body }
    const [first, ...rest] = incoming.message.split('\n')
    setSummary(first ?? '')
    setBody(rest.join('\n').trim())
    toast({ kind: 'success', title: 'Commit message from the chat', action: { label: 'Undo', run: () => { setSummary(before.summary); setBody(before.body) } } })
    // Only a new message matters; the draft at that moment is what Undo restores.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.nonce])

  const writeMessage = async () => {
    if (writing) return cancelAi(writing)
    // Stream into the fields: first line is the summary, the rest the description.
    const fill = (text: string) => {
      const [first, ...rest] = text.replace(/^\s+/, '').split('\n')
      setSummary(first ?? '')
      setBody(rest.join('\n').replace(/^\n+/, ''))
    }
    const r = startAi(id, { kind: 'commit-message' }, fill)
    setWriting(r.requestId)
    try {
      const res = await r.done
      if (res) fill(res.text)
    } catch (e) {
      reportError('Could not write a commit message', e)
    } finally {
      setWriting(null)
    }
  }

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
    const opts = { amend, signOff: setting('signOff'), gpgSign: setting('gpgSign'), noVerify }
    const ok = await run(id, amend ? 'Amend commit' : 'Commit', () => api.commit(id, message, opts), { success: amend ? 'Commit amended' : 'Committed' })
    if (ok) {
      setSummary(template.current?.summary ?? '')
      setBody(template.current?.body ?? '')
      setAmend(false)
      setNoVerify(false)
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void commit()
    }
  }

  return (
    <div className="border-t border-border p-3" data-testid="commit-box">
      <div className="relative">
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={onKey}
          placeholder="Summary"
          style={{ fontFamily: 'var(--gs-code-font)' }}
          data-testid="commit-summary"
          className="h-input w-full rounded-md border border-border bg-background px-2 pr-9 text-sm outline-none focus:border-primary"
        />
        <span className={`absolute top-2 right-2 text-2xs ${summary.length > 72 ? 'text-warn' : 'text-hint'}`}>{summary.length}</span>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKey}
        placeholder={hint || 'Description'}
        style={{ fontFamily: 'var(--gs-code-font)', fontSize: 'var(--gs-code-size)' }}
        rows={3}
        data-testid="commit-body"
        className="mt-2 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
      />
      {/* One control row: what the commit will be (amend, options) and who writes its message, with
          the commit itself at the right edge. Three half-empty rows were taller than the fields. */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground" title="Amend the previous commit instead of making a new one">
            <input type="checkbox" checked={amend} onChange={(e) => void toggleAmend(e.target.checked)} disabled={!view.snapshot.head.hash} />
            Amend
          </label>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button size="sm" variant="ghost" title="Commit options" aria-label="Commit options" data-testid="commit-options">
                <MoreHorizontal size={14} />{noVerify && <span className="text-2xs text-warn">no hooks</span>}
              </Button>
            </DropdownMenu.Trigger>
            <DM.Content>
              <DM.Check checked={noVerify} onChange={setNoVerify} testId="skip-hooks">Skip hooks for this commit (--no-verify)</DM.Check>
              <DM.Item onSelect={() => void pickCoAuthor()}>Add co-author…</DM.Item>
              <DM.Separator />
              <DM.Item onSelect={() => useStore.setState({ dialog: { kind: 'identity', repoId: id, onSaved: () => setIdentityTick((t) => t + 1) } })}>Change who you commit as…</DM.Item>
            </DM.Content>
          </DropdownMenu.Root>
          {aiOn && (
            <>
              <AiTargetButton area="commit" />
              <Button size="sm" variant="ghost" className="shrink-0" onClick={() => void writeMessage()} disabled={!writing && stagedCount === 0} data-testid="ai-commit-message"
                title={writing ? 'Stop' : 'Write the message with AI, from the staged changes'}>
                {writing ? <><Spinner /> Stop</> : <><Sparkles size={13} /> Write</>}
              </Button>
            </>
          )}
        </div>
        <Button variant="primary" className="shrink-0" disabled={!canCommit} onClick={() => void commit()} data-testid="commit-button" title={`Commit (${modName()}+Enter)`}>
          {view.busy === 'Commit' ? <Spinner /> : <Check size={14} />}
          {amend ? 'Amend' : stagedCount ? `Commit ${stagedCount} ${stagedCount === 1 ? 'file' : 'files'}` : 'Commit'}
        </Button>
      </div>
      {/* Who the commit is by: information about the commit, so it follows the fields and the
          buttons instead of leading them. */}
      <button onClick={() => useStore.setState({ dialog: { kind: 'identity', repoId: id, onSaved: () => setIdentityTick((t) => t + 1) } })}
        title={identity?.scope === 'local' ? 'Set for this repository' : identity?.scope === 'global' ? 'Your global identity' : 'No identity set: git will refuse to commit'}
        className={clsx('mt-2 block max-w-full truncate text-left text-2xs hover:text-foreground', identity && !identity.scope ? 'text-warn' : 'text-muted-foreground')} data-testid="commit-identity">
        {identity ? (identity.name || identity.email ? `as ${identity.name ?? '?'} <${identity.email ?? '?'}>${identity.scope === 'local' ? ' · this repository' : ''}` : 'Set who you commit as…') : '\u00a0'}
      </button>
    </div>
  )
}

/** Questions asked about this commit's code (Ask about lines), each reopening its thread. */
function CommitQuestions({ view, hash }: { view: RepoView; hash: string }) {
  const threads = view.askThreads.filter((t) => t.rev === hash)
  if (!threads.length) return null
  return (
    <div className="border-b border-border px-3 py-2" data-testid="commit-questions">
      <div className="mb-1 text-2xs font-semibold text-muted-foreground uppercase">Questions ({threads.length})</div>
      {threads.map((t) => (
        <button key={t.id} className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
          onClick={() => { openFile(view, { kind: 'commit', hash, path: t.path }); openAsk(view.id, t) }}>
          <span className="shrink-0 font-mono text-2xs text-hint">{t.path.split('/').pop()}:{t.startLine}</span>
          <span className="min-w-0 flex-1 truncate">{t.messages.find((m) => m.role === 'user')?.text}</span>
        </button>
      ))}
    </div>
  )
}

/** What git said about a commit's signature, in words, with the signer and key on hover. */
const SIGNATURE: Record<Signature['status'], { text: string; tone: string }> = {
  G: { text: 'Verified signature', tone: 'text-add' },
  U: { text: 'Good signature from a key you have not marked as trusted', tone: 'text-add' },
  X: { text: 'Signature has expired', tone: 'text-warn' },
  Y: { text: 'Signed with a key that has expired', tone: 'text-warn' },
  R: { text: 'Signed with a revoked key', tone: 'text-destructive' },
  B: { text: 'Bad signature: the commit changed after it was signed', tone: 'text-destructive' },
  E: { text: 'Signed, but the signature cannot be checked (missing key or tool)', tone: 'text-muted-foreground' },
}

function SignatureBadge({ sig }: { sig: Signature }) {
  const s = SIGNATURE[sig.status]
  return (
    <div className={clsx('mt-2 flex items-center gap-1.5 text-xs', s.tone)} data-testid="signature" data-status={sig.status}
      title={[sig.signer && `Signer: ${sig.signer}`, sig.key && `Key: ${sig.key}`].filter(Boolean).join('\n') || undefined}>
      {sig.status === 'B' || sig.status === 'R' ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
      <span>{s.text}{sig.signer && (sig.status === 'G' || sig.status === 'U') ? ` · ${sig.signer}` : ''}</span>
    </div>
  )
}

// ------------------------------------------------------------------ comparing

function ComparePanel({ view, sel }: { view: RepoView; sel: Extract<RepoView['selected'], { kind: 'compare' }> }) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null)
  const [fileFilter, setFileFilter] = useState('')
  // The working tree side changes as files do; two revisions never change.
  const reloadOn = sel.to ? 0 : view.worktreeTick
  useEffect(() => {
    let live = true
    setFiles(null)
    api.compareFiles(view.id, sel.from, sel.to).then((f) => live && setFiles(f), (e) => reportError('Could not compare', e))
    return () => {
      live = false
    }
  }, [view.id, sel.from, sel.to, reloadOn])
  const adds = files?.reduce((n, f) => n + f.additions, 0) ?? 0
  const dels = files?.reduce((n, f) => n + f.deletions, 0) ?? 0
  const first = useFirstFile(view.id, files?.[0] ? { kind: 'range', from: sel.from, to: sel.to, path: files[0].path, oldPath: files[0].oldPath } : null)
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="compare-panel">
      <div className="border-b border-border p-3">
        <div className="text-base font-semibold">Comparing</div>
        <div className="mt-1 flex items-center gap-2 font-mono text-xs">
          <span className="truncate rounded bg-accent px-1.5 py-0.5" title={sel.from}>{sel.fromLabel}</span>
          <span className="text-hint">→</span>
          <span className="truncate rounded bg-accent px-1.5 py-0.5" title={sel.to ?? 'working tree'}>{sel.toLabel}</span>
        </div>
        <div className="mt-2 flex gap-2">
          {sel.to && (
            <Button size="sm" onClick={() => updateRepo(view.id, { selected: { ...sel, from: sel.to!, to: sel.from, fromLabel: sel.toLabel, toLabel: sel.fromLabel } })}
              data-testid="compare-swap">Swap</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => selectCommit(view.id, view.snapshot.head.hash ?? sel.from)}>Close</Button>
        </div>
      </div>
      <SectionHeader right={<span className="font-mono normal-case"><span className="text-add">+{adds}</span> <span className="text-destructive">−{dels}</span></span>}>
        {files ? `${files.length} ${files.length === 1 ? 'file' : 'files'} differ` : 'Comparing…'}
      </SectionHeader>
      {files && files.length > 1 && <FileListTools filter={fileFilter} onFilter={setFileFilter} />}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {!files ? <div className="p-3"><Spinner /></div> : files.length === 0 ? <div className="p-3 text-sm text-hint">No differences.</div> : <FileListView items={files} pathOf={(f) => f.path} filter={fileFilter} testId="compare" renderFile={(f, layout) => {
          const t: DiffTarget = { kind: 'range', from: sel.from, to: sel.to, path: f.path, oldPath: f.oldPath }
          return (
            <FileRow key={f.path} {...layout} path={f.path} oldPath={f.oldPath} kind={f.change} selected={isShown(view, first, t)} testId="compare-file"
              onClick={() => openFile(view, t)} menu={<FileMenu view={view} target={t} />}
              stats={f.binary ? <span className="text-2xs text-hint">bin</span> : (
                <span className="shrink-0 font-mono text-2xs"><span className="text-add">+{f.additions}</span> <span className="text-destructive">−{f.deletions}</span></span>
              )} />
          )
        }} />}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ several commits

/** A file in the several-commits list, and where clicking it shows its changes. */
type MultiFile = ChangedFile & { target: DiffTarget; commits: number }

/** Beyond this many commits that do not follow each other, the panel does not gather their files. */
const MAX_GATHERED = 100

/**
 * Shift- or Ctrl-click selected several commits: what they are and what they change. What can be
 * done with them lives in the right-click menu, like for one commit.
 */
function MultiPanel({ view, hashes }: { view: RepoView; hashes: string[] }) {
  const avatarSource = useSetting('avatars')
  const [fileFilter, setFileFilter] = useState('')
  const log = getLog(view.id)
  const commits = hashes.map((h) => log.commits[log.index.get(h) ?? -1]).filter((c): c is NonNullable<typeof c> => !!c)
  const base = chainBase(view.id, hashes)
  const key = hashes.join()
  const [files, setFiles] = useState<{ key: string; list: MultiFile[] | null } | null>(null)
  useEffect(() => {
    let live = true
    const done = (list: MultiFile[] | null) => live && setFiles({ key, list })
    const fail = (e: unknown) => reportError('Could not load the changes', e)
    if (base !== undefined) {
      // Consecutive commits: one diff from before the oldest to the newest, as if they were one commit.
      const to = hashes[0]!
      api.compareFiles(view.id, base, to).then((f) => done(f.map((x) => ({ ...x, commits: 1, target: { kind: 'range', from: base, to, path: x.path, oldPath: x.oldPath } }))), fail)
    } else if (hashes.length <= MAX_GATHERED) {
      // Not a chain: no single diff holds them, so list every file any of them touched. A click shows
      // the newest selected commit's change to it; the count says how many touched it.
      const isStash = (h: string) => view.stashes.some((st) => st.hash === h)
      Promise.all(hashes.map((h) => detailsCache.get(h) ?? api.commitDetails(view.id, h, { stash: isStash(h) }).then((d) => {
        detailsCache.set(h, d)
        return d
      }))).then((all) => {
        const byPath = new Map<string, MultiFile>()
        for (const d of all) {
          for (const f of d.files) {
            const seen = byPath.get(f.path)
            if (seen) {
              seen.commits++
              seen.additions += f.additions
              seen.deletions += f.deletions
            } else byPath.set(f.path, { ...f, commits: 1, target: { kind: 'commit', hash: d.hash, path: f.path } })
          }
        }
        done([...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)))
      }, fail)
    } else done(null)
    return () => {
      live = false
    }
  }, [view.id, key, base])
  const list = files?.key === key ? files.list : undefined
  const counts = new Map<string, number>()
  for (const f of list ?? []) counts.set(f.change, (counts.get(f.change) ?? 0) + 1)
  const adds = list?.reduce((n, f) => n + f.additions, 0) ?? 0
  const dels = list?.reduce((n, f) => n + f.deletions, 0) ?? 0
  const first = useFirstFile(view.id, list?.[0]?.target ?? null)
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="multi-panel">
      <div className="border-b border-border px-3 pt-3 pb-2">
        <div className="text-base font-semibold">{hashes.length} commits selected</div>
        <div className="mt-0.5 text-xs text-muted-foreground">Right-click the selection for what you can do with them. Shift-click selects a range, {modName()}-click adds or removes one.</div>
      </div>
      <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-border py-1" data-testid="multi-commits">
        {commits.map((c) => (
          <button key={c.hash} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent" data-testid="multi-commit"
            onClick={() => selectCommit(view.id, c.hash)} title="Select only this commit">
            <Avatar name={c.authorName} email={c.authorEmail} src={avatarSrc(c.authorEmail, avatarSource)} size={24} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{c.subject}</div>
              <div className="truncate text-2xs text-muted-foreground">{dateTime(c.authorDate)} by {c.authorName}</div>
            </div>
            <span className="shrink-0 self-start font-mono text-xs text-hint">{shortHash(c.hash)}</span>
          </button>
        ))}
      </div>
      <SectionHeader right={list ? <span className="font-mono normal-case"><span className="text-add">+{adds}</span> <span className="text-destructive">−{dels}</span></span> : undefined}>
        {base !== undefined ? 'Combined changes' : 'Files they touch'}
      </SectionHeader>
      {list && list.length > 0 && (
        <div className="px-3 pb-1 text-xs text-muted-foreground" data-testid="multi-summary">
          {[...counts].map(([kind, n]) => `${n} ${kind}`).join(' · ')}
          {base === undefined && <div className="text-hint">Not consecutive: each file shows the newest selected commit's change.</div>}
        </div>
      )}
      {list && list.length > 1 && <FileListTools filter={fileFilter} onFilter={setFileFilter} />}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {list === undefined ? <div className="p-3"><Spinner /></div>
          : list === null ? <div className="p-3 text-sm text-hint">Too many commits that do not follow each other to gather their files.</div>
          : list.length === 0 ? <div className="p-3 text-sm text-hint">No file changes.</div>
          : <FileListView items={list} pathOf={(f) => f.path} filter={fileFilter} testId="multi" renderFile={(f, layout) => (
            <FileRow key={f.path} {...layout} path={f.path} oldPath={f.oldPath} kind={f.change} selected={isShown(view, first, f.target)} testId="multi-file"
              onClick={() => openFile(view, f.target)} menu={<FileMenu view={view} target={f.target} />}
              stats={f.binary ? <span className="text-2xs text-hint">bin</span> : (
                <span className="shrink-0 font-mono text-2xs">
                  {f.commits > 1 && <span className="mr-1 text-hint" title={`Touched by ${f.commits} of the selected commits`}>×{f.commits}</span>}
                  <span className="text-add">+{f.additions}</span> <span className="text-destructive">−{f.deletions}</span>
                </span>
              )} />
          )} />}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ a commit

// Keyed by hash: a commit's details never change. (Stashes are commits with unique hashes too.)
const detailsCache = new Map<string, CommitDetails>()

function CommitPanel({ view, hash }: { view: RepoView; hash: string }) {
  const avatarSource = useSetting('avatars')
  const [details, setDetails] = useState<CommitDetails | null>(() => detailsCache.get(hash) ?? null)
  const [fileFilter, setFileFilter] = useState('')
  const latest = useRef(hash)
  const aiOn = useAiEnabled()
  const explanation = useExplanation(view.id, hash, aiOn)
  useEffect(() => {
    latest.current = hash
    const cached = detailsCache.get(hash)
    if (cached) {
      setDetails(cached)
      return
    }
    // The previous commit's panel stays up while this one loads, so the two swap in one frame
    // (a reorder reselects the moved commit, whose details are new). Only a slow load spins:
    // half a second, so a large commit's file list arriving just after the swap does not blink.
    const spinner = setTimeout(() => setDetails(null), 500)
    const isStash = view.stashes.some((s) => s.hash === hash)
    api.commitDetails(view.id, hash, { stash: isStash }).then((d) => {
      if (detailsCache.size > 500) detailsCache.clear()
      detailsCache.set(hash, d)
      if (latest.current !== hash) return
      clearTimeout(spinner)
      setDetails(d)
    }, (e) => reportError('Could not load commit', e))
    return () => clearTimeout(spinner)
  }, [hash, view.id])
  // Its own first file only: while the previous commit's details are still up, none.
  const first = useFirstFile(view.id, details?.hash === hash && details.files[0] ? { kind: 'commit', hash, path: details.files[0].path } : null)

  if (!details) return <div className="flex flex-1 items-center justify-center text-hint"><Spinner /></div>
  const d = details
  // The panel can show the previous commit while this one loads: only its own explanation.
  const shown = d.hash === hash ? explanation : null
  // Not while the panel still shows the previous commit: that would ask again about it.
  const loading = d.hash !== hash
  const explain = () => (loading ? undefined : shown?.requestId ? cancelAi(shown.requestId) : explainCommit(view.id, d.hash))
  // A stash is a commit too: its first parent is where it was made, so the file list is its changes.
  const stash = view.stashes.find((s) => s.hash === d.hash)
  const adds = d.files.reduce((n, f) => n + f.additions, 0)
  const dels = d.files.reduce((n, f) => n + f.deletions, 0)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {stash && (
        <div className="flex items-center gap-2 border-b border-border bg-primary/10 px-3 py-2 text-sm" data-testid="stash-header">
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
          <Button size="sm" variant="ghost" title="A new branch where the stash was made, with the stash applied" onClick={() => stashToBranch(view.id, stash.index)}>Branch…</Button>
        </div>
      )}
      <div className="selectable border-b border-border p-3">
        <div className="text-base leading-snug font-semibold">{stash ? stashLabel(stash.message) : d.subject}</div>
        {d.body && <pre className="mt-2 max-h-40 overflow-y-auto font-sans text-sm whitespace-pre-wrap text-muted-foreground">{d.body}</pre>}
        {aiOn && !stash && (
          <div className="mt-2">
            {!shown ? (
              <span className="flex min-w-0 items-center gap-2">
                <Button size="sm" variant="ghost" onClick={explain} disabled={loading} data-testid="ai-explain-commit"><Sparkles size={12} /> Explain</Button>
                <AiTargetButton area="explain" />
              </span>
            ) : (
              <div className="rounded-md border border-border bg-background/60 p-2 text-sm" data-testid="ai-explanation">
                <div className="mb-1 flex items-center gap-1 text-2xs text-hint">
                  <Sparkles size={11} /> <span className="flex-1">AI explanation</span>
                  {shown.requestId && <Button size="sm" variant="ghost" onClick={explain}>Stop</Button>}
                  {shown.threadId && !shown.requestId && (
                    <button title="Ask a follow-up in the AI pane" data-testid="open-chat" className="rounded p-0.5 hover:bg-accent"
                      onClick={() => openInPanel(view.id, shown.threadId!)}><MessagesSquare size={12} /></button>
                  )}
                  <button title="Close" className="rounded p-0.5 hover:bg-accent" onClick={() => closeExplanation(view.id, d.hash)}><X size={12} /></button>
                </div>
                <div data-testid="ai-explanation-text">
                  {shown.text ? <Markdown text={shown.text} /> : (shown.requestId ? <span className="flex items-center gap-2 text-muted-foreground"><Spinner /> Thinking…</span> : null)}
                </div>
                {shown.error && <div className="mt-1 text-xs text-destructive">{shown.error}</div>}
              </div>
            )}
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Avatar name={d.authorName} email={d.authorEmail} src={avatarSrc(d.authorEmail, avatarSource)} size={28} />
          <div className="min-w-0 text-xs">
            {/* Name and date are the content; the address is for the person who needs it, on hover. */}
            <div className="truncate" data-testid="details-author"><b title={`${d.authorName} <${d.authorEmail}>`}>{d.authorName}</b></div>
            <div className="text-muted-foreground" title={dateTime(d.authorDate)} data-testid="details-date">{relativeTime(d.authorDate)}</div>
            {(d.committerEmail !== d.authorEmail || d.commitDate !== d.authorDate) && (
              <div className="text-hint">committed by {d.committerName}, {dateTime(d.commitDate)}</div>
            )}
          </div>
        </div>
        {d.signature && <SignatureBadge sig={d.signature} />}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
          <button className="flex items-center gap-1 hover:text-foreground" onClick={() => copy(d.hash, 'Copied SHA')} title="Copy SHA">
            {shortHash(d.hash)} <Copy size={11} />
          </button>
          {d.parents.map((p) => (
            <button key={p} className="hover:text-primary" title="Go to parent"
              onClick={() => { updateRepo(view.id, { selected: { kind: 'commit', hash: p } }); void ensureLoaded(view.id, p) }}>
              parent {shortHash(p)}
            </button>
          ))}
        </div>
      </div>
      <SectionHeader right={<span className="font-mono normal-case"><span className="text-add">+{adds}</span> <span className="text-destructive">−{dels}</span></span>}>
        {d.files.length} {d.files.length === 1 ? 'file' : 'files'} changed{d.parents.length > 1 && !stash ? ' (vs first parent)' : ''}
      </SectionHeader>
      <CommitQuestions view={view} hash={d.hash} />
      {d.files.length > 1 && <FileListTools filter={fileFilter} onFilter={setFileFilter} />}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2" data-testid="commit-files">
        <FileListView items={d.files} pathOf={(f) => f.path} filter={fileFilter} testId="commit" renderFile={(f, layout) => {
          const t: DiffTarget = { kind: 'commit', hash: d.hash, path: f.path }
          return (
            <FileRow key={f.path} {...layout} path={f.path} oldPath={f.oldPath} kind={f.change} selected={isShown(view, first, t)} testId="commit-file"
              drag={{ kind: 'files', rev: d.hash, paths: [f.path], stash: !!stash }}
              onClick={() => openFile(view, t)}
              menu={<FileMenu view={view} target={t} />}
              stats={f.binary ? <span className="text-2xs text-hint">bin</span> : (
                <span className="shrink-0 font-mono text-2xs"><span className="text-add">+{f.additions}</span> <span className="text-destructive">−{f.deletions}</span></span>
              )} />
          )
        }} />
      </div>
    </div>
  )
}
