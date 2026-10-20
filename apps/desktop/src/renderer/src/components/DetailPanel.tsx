import type { ChangedFile, CommitDetails, DiffTarget, StatusEntry } from '@gitgoose/shared'
import type { Identity, Person, Signature } from '@gitgoose/shared'
import { Archive, Check, ChevronDown, Copy, Minus, MoreHorizontal, Plus, ShieldAlert, ShieldCheck, Sparkles, Undo2, X } from 'lucide-react'
import clsx from 'clsx'
import { DropdownMenu } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import { copy, discard as discardFiles, lfsLock, lfsPatternFor, lfsTrack, openDiffTool, openInEditor, pop, restoreFileFrom, run, snapshot, stashApply, stashDrop, stashToBranch, stashWith, stashWithMessage } from '../lib/actions'
import { cancelAi, startAi, useAi, useAiEnabled } from '../lib/ai'
import { api, toUiError } from '../lib/api'
import { dateTime, opName, sentence, shortHash, stashLabel } from '../lib/format'
import { avatarSrc, useAvatarVariant } from '../lib/avatar'
import { addTrailer, isUntouched, splitTemplate } from '../lib/commitMessage'
import { startReview } from '../lib/review'
import { openAsk } from '../lib/ask'
import { useThread } from '../lib/thread'
import { Markdown } from './Markdown'
import { Thread } from './Thread'
import { startWalkthrough } from '../lib/walkthrough'
import { showImpact } from '../lib/impact'
import { chainBase, ensureLoaded, getLog, reportError, selectCommit, setting, toast, updateRepo, useSetting, useStore, type FileMode, type RepoView } from '../lib/store'
import { Avatar } from './Avatar'
import { ChangeHints } from './ChangeHints'
import { FileListTools, FileListView, FileRow, statusKind } from './FileList'
import { modName } from '../lib/keys'
import { Button, CM, DM, SectionHeader, Spinner } from './ui'

export function DetailPanel({ view }: { view: RepoView }) {
  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-panel" data-testid="detail-panel">
      {view.selected.kind === 'wip' ? <WipPanel view={view} />
        : view.selected.kind === 'commits' ? <MultiPanel view={view} hashes={view.selected.hashes} />
        : view.selected.kind === 'compare' ? <ComparePanel view={view} sel={view.selected} />
        : <CommitPanel view={view} hash={view.selected.hash} />}
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
  const st = view.snapshot.status
  const unstaged = st.filter((e) => e.kind === 'untracked' || (e.kind !== 'unmerged' && e.worktree !== '.'))
  const staged = st.filter((e) => e.kind !== 'untracked' && e.kind !== 'unmerged' && e.index !== '.')
  const conflicted = st.filter((e) => e.kind === 'unmerged')
  const id = view.id

  const stage = (paths: string[]) => run(id, 'Stage', () => api.stagePaths(id, paths), { quiet: true })
  const unstage = (paths: string[]) => run(id, 'Unstage', () => api.unstagePaths(id, paths), { quiet: true })
  const discard = (paths: string[]) => discardFiles(id, paths)

  const [filter, setFilter] = useState('')
  const unstagedTarget = (e: StatusEntry): DiffTarget => (e.kind === 'untracked' ? { kind: 'untracked', path: e.path } : { kind: 'unstaged', path: e.path })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold">{st.length} file {st.length === 1 ? 'change' : 'changes'}</span>
          <span className="text-muted"> on {view.snapshot.head.branch ?? (view.snapshot.head.detached ? 'detached HEAD' : 'a new branch')}</span>
        </span>
        {st.length > 0 && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button size="sm" variant="ghost" data-testid="review-menu" title="Review, explain or assess these changes"><Sparkles size={12} /> Review</Button>
            </DropdownMenu.Trigger>
            <DM.Content align="end">
              {aiOn && (
                <>
                  <DM.Item onSelect={() => startReview(id, { kind: 'working' })}>Review all uncommitted changes</DM.Item>
                  <DM.Item disabled={!staged.length} onSelect={() => startReview(id, { kind: 'staged' })}>Review staged changes</DM.Item>
                  <DM.Item onSelect={() => startWalkthrough(id, { kind: 'working' })}>Walk me through these changes</DM.Item>
                  <DM.Separator />
                </>
              )}
              <DM.Item onSelect={() => showImpact(id, { kind: 'working' })}>What could these changes affect?</DM.Item>
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
              <DM.Item disabled={!staged.length} onSelect={() => void stashWith(id, { staged: true })}>Stash only the staged changes</DM.Item>
              <DM.Item disabled={!staged.length} onSelect={() => void stashWith(id, { keepIndex: true })}>Stash all, keep the staged changes in place</DM.Item>
            </DM.Content>
          </DropdownMenu.Root>
        )}
      </div>
      {st.length > 0 && <FileListTools filter={filter} onFilter={setFilter} />}
      {view.snapshot.operation && (
        <div className="flex items-center justify-between gap-2 border-b border-line bg-warn/10 px-3 py-2 text-[13px]">
          <span><b>{sentence(opName(view.snapshot.operation))}</b> in progress{conflicted.length ? `, ${conflicted.length} conflicted` : ''}</span>
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
            <FileListView items={unstaged} pathOf={(e) => e.path} filter={filter} testId="unstaged"
              folderActions={(paths) => <>
                <IconAction title="Discard changes in this folder (undoable)" onClick={() => void discard(paths)}><Undo2 size={12} /></IconAction>
                <IconAction title="Stage folder" onClick={() => void stage(paths)}><Plus size={12} /></IconAction>
              </>}
              renderFile={(e, layout) => {
              const t = unstagedTarget(e)
              return (
                <FileRow key={e.path} {...layout} path={e.path} kind={statusKind(e.worktree === '.' ? e.index : e.worktree)} testId="unstaged-file"
                  drag={{ kind: 'files', rev: 'worktree', paths: [e.path] }}
                  selected={isOpen(view, t)} onClick={() => openFile(view, t)}
                  menu={<FileMenu view={view} target={t}>
                    <CM.Item onSelect={() => void stage([e.path])}>Stage</CM.Item>
                    <CM.Item onSelect={() => void stashWith(id, { paths: [e.path] })}>Stash this file</CM.Item>
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
            }} />
            {unstaged.length === 0 && <div className="px-3 py-2 text-xs text-faint">No unstaged changes</div>}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col border-t border-line" data-testid="staged">
          <SectionHeader right={staged.length > 0 && <Button size="sm" onClick={() => void unstage(staged.map((e) => e.path))}>Unstage all</Button>}>
            Staged ({staged.length})
          </SectionHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <FileListView items={staged} pathOf={(e) => e.path} filter={filter} testId="staged"
              folderActions={(paths) => <IconAction title="Unstage folder" onClick={() => void unstage(paths)}><Minus size={12} /></IconAction>}
              renderFile={(e, layout) => {
              const t: DiffTarget = { kind: 'staged', path: e.path }
              return (
                <FileRow key={e.path} {...layout} path={e.path} oldPath={e.origPath} kind={statusKind(e.index)} testId="staged-file"
                  drag={{ kind: 'files', rev: 'worktree', paths: [e.path] }}
                  selected={isOpen(view, t)} onClick={() => openFile(view, t)}
                  menu={<FileMenu view={view} target={t}>
                    <CM.Item onSelect={() => void unstage([e.path])}>Unstage</CM.Item>
                    <CM.Item onSelect={() => void stashWith(id, { paths: [e.path] })}>Stash this file</CM.Item>
                  </FileMenu>}
                  actions={<IconAction title="Unstage file" onClick={() => void unstage([e.path])}><Minus size={12} /></IconAction>} />
              )
            }} />
            {staged.length === 0 && <div className="px-3 py-2 text-xs text-faint">Stage files or lines to commit them</div>}
          </div>
        </div>
      </div>
      <ChangeHints view={view} />
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
    <div className="border-t border-line p-3" data-testid="commit-box">
      <button onClick={() => useStore.setState({ dialog: { kind: 'identity', repoId: id, onSaved: () => setIdentityTick((t) => t + 1) } })}
        title={identity?.scope === 'local' ? 'Set for this repository' : identity?.scope === 'global' ? 'Your global identity' : 'No identity set: git will refuse to commit'}
        className={clsx('mb-2 block max-w-full truncate text-left text-[11px] hover:text-fg', identity && !identity.scope ? 'text-warn' : 'text-faint')} data-testid="commit-identity">
        {identity ? (identity.name || identity.email ? `as ${identity.name ?? '?'} <${identity.email ?? '?'}>${identity.scope === 'local' ? ' · this repository' : ''}` : 'Set who you commit as…') : '\u00a0'}
      </button>
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
        placeholder={hint || 'Description'}
        style={{ fontFamily: 'var(--gs-code-font)', fontSize: 'var(--gs-code-size)' }}
        rows={3}
        data-testid="commit-body"
        className="mt-2 w-full resize-none rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] outline-none focus:border-accent"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted" title="Amend the previous commit instead of making a new one">
            <input type="checkbox" checked={amend} onChange={(e) => void toggleAmend(e.target.checked)} disabled={!view.snapshot.head.hash} />
            Amend
          </label>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button size="sm" variant="ghost" title="Commit options" aria-label="Commit options" data-testid="commit-options">
                <MoreHorizontal size={14} />{noVerify && <span className="text-[10px] text-warn">no hooks</span>}
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
            <Button size="sm" variant="ghost" onClick={() => void writeMessage()} disabled={!writing && stagedCount === 0} data-testid="ai-commit-message"
              title={writing ? 'Stop' : 'Write the message with AI, from the staged changes'}>
              {writing ? <><Spinner /> Stop</> : <><Sparkles size={13} /> Write</>}
            </Button>
          )}
        </div>
        <Button variant="primary" disabled={!canCommit} onClick={() => void commit()} data-testid="commit-button" title={`Commit (${modName()}+Enter)`}>
          {view.busy === 'Commit' ? <Spinner /> : <Check size={14} />}
          {amend ? 'Amend' : stagedCount ? `Commit ${stagedCount} ${stagedCount === 1 ? 'file' : 'files'}` : 'Commit'}
        </Button>
      </div>
    </div>
  )
}

/**
 * Explain grows into a conversation: the explanation was the first turn of a thread, and the
 * follow-ups go to the same agent session, so "and why not X?" needs no repeating of the diff.
 */
function ExplainFollowUp({ repoId, hash, threadId }: { repoId: string; hash: string; threadId: string }) {
  const thread = useThread(repoId, { kind: 'explain', hash }, threadId)
  if (!thread) return null
  return (
    <Thread thread={thread} repoId={repoId} hideFeature testids={{ root: 'explain-thread' }} placeholder="Ask a follow-up (Enter sends)"
      className={clsx('mt-2 -mx-2 -mb-2 border-t border-line', thread.turns.some((t) => !t.feature) && 'max-h-[60vh]')} />
  )
}

/** Questions asked about this commit's code (Ask about lines), each reopening its thread. */
function CommitQuestions({ view, hash }: { view: RepoView; hash: string }) {
  const threads = view.askThreads.filter((t) => t.rev === hash)
  if (!threads.length) return null
  return (
    <div className="border-b border-line px-3 py-2" data-testid="commit-questions">
      <div className="mb-1 text-[11px] font-semibold text-muted uppercase">Questions ({threads.length})</div>
      {threads.map((t) => (
        <button key={t.id} className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-[12px] hover:bg-hover"
          onClick={() => { updateRepo(view.id, { center: { kind: 'file', target: { kind: 'commit', hash, path: t.path }, mode: 'diff' } }); openAsk(view.id, t) }}>
          <span className="shrink-0 font-mono text-[11px] text-faint">{t.path.split('/').pop()}:{t.startLine}</span>
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
  R: { text: 'Signed with a revoked key', tone: 'text-del' },
  B: { text: 'Bad signature: the commit changed after it was signed', tone: 'text-del' },
  E: { text: 'Signed, but the signature cannot be checked (missing key or tool)', tone: 'text-muted' },
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
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="compare-panel">
      <div className="border-b border-line p-3">
        <div className="text-[14px] font-semibold">Comparing</div>
        <div className="mt-1 flex items-center gap-2 font-mono text-xs">
          <span className="truncate rounded bg-hover px-1.5 py-0.5" title={sel.from}>{sel.fromLabel}</span>
          <span className="text-faint">→</span>
          <span className="truncate rounded bg-hover px-1.5 py-0.5" title={sel.to ?? 'working tree'}>{sel.toLabel}</span>
        </div>
        <div className="mt-2 flex gap-2">
          {sel.to && (
            <Button size="sm" onClick={() => updateRepo(view.id, { selected: { ...sel, from: sel.to!, to: sel.from, fromLabel: sel.toLabel, toLabel: sel.fromLabel } })}
              data-testid="compare-swap">Swap</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => selectCommit(view.id, view.snapshot.head.hash ?? sel.from)}>Close</Button>
        </div>
      </div>
      <SectionHeader right={<span className="font-mono normal-case"><span className="text-add">+{adds}</span> <span className="text-del">−{dels}</span></span>}>
        {files ? `${files.length} ${files.length === 1 ? 'file' : 'files'} differ` : 'Comparing…'}
      </SectionHeader>
      {files && files.length > 1 && <FileListTools filter={fileFilter} onFilter={setFileFilter} />}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {!files ? <div className="p-3"><Spinner /></div> : files.length === 0 ? <div className="p-3 text-sm text-faint">No differences.</div> : <FileListView items={files} pathOf={(f) => f.path} filter={fileFilter} testId="compare" renderFile={(f, layout) => {
          const t: DiffTarget = { kind: 'range', from: sel.from, to: sel.to, path: f.path, oldPath: f.oldPath }
          return (
            <FileRow key={f.path} {...layout} path={f.path} oldPath={f.oldPath} kind={f.change} selected={isOpen(view, t)} testId="compare-file"
              onClick={() => openFile(view, t)} menu={<FileMenu view={view} target={t} />}
              stats={f.binary ? <span className="text-[11px] text-faint">bin</span> : (
                <span className="shrink-0 font-mono text-[11px]"><span className="text-add">+{f.additions}</span> <span className="text-del">−{f.deletions}</span></span>
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
  const avatarVariant = useAvatarVariant()
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
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="multi-panel">
      <div className="border-b border-line px-3 pt-3 pb-2">
        <div className="text-[14px] font-semibold">{hashes.length} commits selected</div>
        <div className="mt-0.5 text-xs text-muted">Right-click the selection for what you can do with them. Shift-click selects a range, {modName()}-click adds or removes one.</div>
      </div>
      <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-line py-1" data-testid="multi-commits">
        {commits.map((c) => (
          <button key={c.hash} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover" data-testid="multi-commit"
            onClick={() => selectCommit(view.id, c.hash)} title="Select only this commit">
            <Avatar name={c.authorName} email={c.authorEmail} src={avatarSrc(c.authorEmail, avatarSource, avatarVariant)} size={24} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">{c.subject}</div>
              <div className="truncate text-[11px] text-muted">{dateTime(c.authorDate)} by {c.authorName}</div>
            </div>
            <span className="shrink-0 self-start font-mono text-xs text-faint">{shortHash(c.hash)}</span>
          </button>
        ))}
      </div>
      <SectionHeader right={list ? <span className="font-mono normal-case"><span className="text-add">+{adds}</span> <span className="text-del">−{dels}</span></span> : undefined}>
        {base !== undefined ? 'Combined changes' : 'Files they touch'}
      </SectionHeader>
      {list && list.length > 0 && (
        <div className="px-3 pb-1 text-xs text-muted" data-testid="multi-summary">
          {[...counts].map(([kind, n]) => `${n} ${kind}`).join(' · ')}
          {base === undefined && <div className="text-faint">Not consecutive, so there is no single diff: a file shows the newest selected commit's change.</div>}
        </div>
      )}
      {list && list.length > 1 && <FileListTools filter={fileFilter} onFilter={setFileFilter} />}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {list === undefined ? <div className="p-3"><Spinner /></div>
          : list === null ? <div className="p-3 text-sm text-faint">Too many commits that do not follow each other to gather their files.</div>
          : list.length === 0 ? <div className="p-3 text-sm text-faint">No file changes.</div>
          : <FileListView items={list} pathOf={(f) => f.path} filter={fileFilter} testId="multi" renderFile={(f, layout) => (
            <FileRow key={f.path} {...layout} path={f.path} oldPath={f.oldPath} kind={f.change} selected={isOpen(view, f.target)} testId="multi-file"
              onClick={() => openFile(view, f.target)} menu={<FileMenu view={view} target={f.target} />}
              stats={f.binary ? <span className="text-[11px] text-faint">bin</span> : (
                <span className="shrink-0 font-mono text-[11px]">
                  {f.commits > 1 && <span className="mr-1 text-faint" title={`Touched by ${f.commits} of the selected commits`}>×{f.commits}</span>}
                  <span className="text-add">+{f.additions}</span> <span className="text-del">−{f.deletions}</span>
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
  const avatarVariant = useAvatarVariant()
  const [details, setDetails] = useState<CommitDetails | null>(() => detailsCache.get(hash) ?? null)
  const [fileFilter, setFileFilter] = useState('')
  const latest = useRef(hash)
  const aiOn = useAiEnabled()
  const [explained, setExplained] = useState<{ hash: string; text: string; requestId: string | null; error: string | null; threadId?: string } | null>(null)
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

  if (!details) return <div className="flex flex-1 items-center justify-center text-faint"><Spinner /></div>
  const d = details
  const explanation = explained?.hash === d.hash ? explained : null
  const explain = () => {
    if (explanation?.requestId) return cancelAi(explanation.requestId)
    const target = d.hash
    const update = (patch: Partial<NonNullable<typeof explained>>) =>
      setExplained((e) => (e && e.hash === target ? { ...e, ...patch } : e))
    const r = startAi(view.id, { kind: 'explain-commit', hash: target }, (text) => update({ text }), { keepThread: true })
    setExplained({ hash: target, text: '', requestId: r.requestId, error: null })
    r.done.then(
      (res) => (res ? update({ text: res.text, requestId: null, threadId: res.threadId }) : setExplained((e) => (e?.hash === target && !e.text ? null : e && { ...e, requestId: null }))),
      (e) => update({ requestId: null, error: toUiError(e).message }),
    )
  }
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
          <Button size="sm" variant="ghost" title="A new branch where the stash was made, with the stash applied" onClick={() => stashToBranch(view.id, stash.index)}>Branch…</Button>
        </div>
      )}
      <div className="selectable border-b border-line p-3">
        <div className="text-[14px] leading-snug font-semibold">{stash ? stashLabel(stash.message) : d.subject}</div>
        {d.body && <pre className="mt-2 max-h-40 overflow-y-auto font-sans text-[13px] whitespace-pre-wrap text-muted">{d.body}</pre>}
        {aiOn && !stash && (
          <div className="mt-2">
            {!explanation ? (
              <Button size="sm" variant="ghost" onClick={explain} data-testid="ai-explain-commit"><Sparkles size={12} /> Explain</Button>
            ) : (
              <div className="rounded-md border border-line bg-bg/60 p-2 text-[13px]" data-testid="ai-explanation">
                <div className="mb-1 flex items-center gap-1 text-[11px] text-faint">
                  <Sparkles size={11} /> <span className="flex-1">AI explanation</span>
                  {explanation.requestId && <Button size="sm" variant="ghost" onClick={explain}>Stop</Button>}
                  <button title="Close" className="rounded p-0.5 hover:bg-hover" onClick={() => {
                    if (explanation.requestId) cancelAi(explanation.requestId)
                    setExplained(null)
                  }}><X size={12} /></button>
                </div>
                <div data-testid="ai-explanation-text">
                  {explanation.text ? <Markdown text={explanation.text} /> : (explanation.requestId ? <span className="flex items-center gap-2 text-muted"><Spinner /> Thinking…</span> : null)}
                </div>
                {explanation.error && <div className="mt-1 text-xs text-del">{explanation.error}</div>}
                {explanation.threadId && <ExplainFollowUp repoId={view.id} hash={explanation.hash} threadId={explanation.threadId} />}
              </div>
            )}
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Avatar name={d.authorName} email={d.authorEmail} src={avatarSrc(d.authorEmail, avatarSource, avatarVariant)} size={28} />
          <div className="min-w-0 text-xs">
            <div className="truncate"><b>{d.authorName}</b> <span className="text-faint">&lt;{d.authorEmail}&gt;</span></div>
            <div className="text-muted">authored {dateTime(d.authorDate)}</div>
            {(d.committerEmail !== d.authorEmail || d.commitDate !== d.authorDate) && (
              <div className="text-faint">committed by {d.committerName}, {dateTime(d.commitDate)}</div>
            )}
          </div>
        </div>
        {d.signature && <SignatureBadge sig={d.signature} />}
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
      <CommitQuestions view={view} hash={d.hash} />
      {d.files.length > 1 && <FileListTools filter={fileFilter} onFilter={setFileFilter} />}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2" data-testid="commit-files">
        <FileListView items={d.files} pathOf={(f) => f.path} filter={fileFilter} testId="commit" renderFile={(f, layout) => {
          const t: DiffTarget = { kind: 'commit', hash: d.hash, path: f.path }
          return (
            <FileRow key={f.path} {...layout} path={f.path} oldPath={f.oldPath} kind={f.change} selected={isOpen(view, t)} testId="commit-file"
              drag={{ kind: 'files', rev: d.hash, paths: [f.path], stash: !!stash }}
              onClick={() => openFile(view, t)}
              menu={<FileMenu view={view} target={t} />}
              stats={f.binary ? <span className="text-[11px] text-faint">bin</span> : (
                <span className="shrink-0 font-mono text-[11px]"><span className="text-add">+{f.additions}</span> <span className="text-del">−{f.deletions}</span></span>
              )} />
          )
        }} />
      </div>
    </div>
  )
}
