import { SETTINGS, type CommitSummary, type DiffTarget } from '@gitgoose/shared'
import clsx from 'clsx'
import { Command } from 'cmdk'
import { Archive, CornerDownLeft, File, FileDiff, GitBranch, GitCommitHorizontal, Search, Settings2, SquareTerminal, Tag } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { checkout, openInEditor } from '../lib/actions'
import { api } from '../lib/api'
import { commandEntries } from '../lib/commands'
import { relativeTime, shortHash } from '../lib/format'
import { pieces, fuzzy } from '../lib/fuzzy'
import { modName } from '../lib/keys'
import {
  commitSub, KIND_WEIGHT, kindsOf, loadRecent, parseQuery, rankAll, rememberRecent, SCOPE_LABEL, SCOPES,
  splitPath, type OmniEntry, type OmniKind, type OmniResult, type OmniScope,
} from '../lib/omni'
import { ensureLoaded, updateRepo, useStore, type RepoView } from '../lib/store'
import { SectionHeader, Spinner } from './ui'

/**
 * One search for everything, opened with Ctrl+K (or Ctrl+F), like the search on the Next.js
 * docs: commands, branches and tags, commits (by message, author or SHA), files, stashes and
 * settings, ranked together so the best answer is on top, matches highlighted, all from the
 * keyboard. Ctrl+P opens it with ">" (commands only), so it is the command palette as well.
 *
 * Local sources (refs, files, commands, settings) are ranked on every keystroke; commit search
 * asks git, so it waits for typing to pause and its results join when they arrive. The
 * GitKraken-style "grey out everything else" view of the graph is one of the results: "Show all
 * N matching commits in the graph".
 */

const COMMIT_DEBOUNCE_MS = 160
/** A commit found by author or SHA rather than by its message still deserves a place. */
const COMMIT_SCORE = 100
/** Shown with an empty box, after anything recent. */
const SUGGESTED = ['Repository:Fetch all remotes', 'Repository:Pull', 'Repository:Push', 'Repository:New branch', 'Repository:Stash all changes', 'Repository:Show reflog (recover lost commits)']

const ICON: Record<OmniKind, ReactNode> = {
  command: <SquareTerminal size={16} />, branch: <GitBranch size={16} />, tag: <Tag size={16} />, change: <FileDiff size={16} />, file: <File size={16} />,
  stash: <Archive size={16} />, setting: <Settings2 size={16} />, commit: <GitCommitHorizontal size={16} />,
}

interface Group {
  id: string
  label: string
  results: OmniResult[]
  total: number
}

const valueOf = (r: OmniEntry) => `${r.kind}:${r.key}`

export function OmniSearch() {
  const omni = useStore((s) => s.omni)
  const close = () => useStore.setState({ omni: null })
  return (
    <Dialog.Root open={!!omni} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-[9vh] left-1/2 z-50 w-[680px] max-w-[94vw] -translate-x-1/2 outline-none" aria-describedby={undefined} data-testid="omni">
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          {omni && <OmniPanel initial={omni.query} close={close} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function OmniPanel({ initial, close }: { initial: string; close: () => void }) {
  const view = useStore((s) => (s.active ? s.repos[s.active] ?? null : null))
  const [raw, setRaw] = useState(initial)
  // Ctrl+P while it is open (or Ctrl+K) starts over with that mode's text.
  useEffect(() => setRaw(initial), [initial])
  const [chip, setChip] = useState<OmniScope>('all')
  const { query, scope } = parseQuery(raw, chip)
  const local = useDeferredValue(query)
  const inScope = (k: OmniKind) => kindsOf(scope).includes(k)

  // Files: listed once per opening, the first time they are wanted.
  const [files, setFiles] = useState<string[] | null>(null)
  const wantFiles = !!view && !!query && inScope('file')
  useEffect(() => {
    if (wantFiles && files === null) void api.listFiles(view!.id).then(setFiles, () => setFiles([]))
  }, [wantFiles, files, view])

  // Commits: git does the searching (message, author, SHA, branch and tag names).
  const [commits, setCommits] = useState<{ query: string; total: number; list: CommitSummary[] } | null>(null)
  const [searching, setSearching] = useState(false)
  const wantCommits = !!view && query.length >= 2 && inScope('commit')
  useEffect(() => {
    if (!wantCommits) {
      setSearching(false)
      return
    }
    let live = true
    setSearching(true)
    const t = setTimeout(() => {
      api.searchCommits(view!.id, 'all', query, scope === 'commit' ? 50 : 8)
        .then((r) => live && setCommits({ query, total: r.total, list: r.commits }), () => live && setCommits({ query, total: 0, list: [] }))
        .finally(() => live && setSearching(false))
    }, COMMIT_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [wantCommits, query, scope, view?.id])

  // Built once per opening: the commands for the state the app was in when it opened.
  const commands = useMemo(() => commandEntries(), [])
  const sources = useMemo(() => localSources(view, commands, files), [view, commands, files])

  const groups = useMemo<Group[]>(() => {
    if (!local) return emptyGroups(view, sources, scope)
    const ranked: Group[] = rankAll(local, sources, scope).map((g) => ({ id: g.kind, label: g.label, results: g.results, total: g.total }))
    if (inScope('commit') && commits && commits.query === query && commits.list.length) {
      // Git's order (newest first) is kept inside the group; the group goes where its best match ranks.
      const results = commits.list.map((c): OmniResult => {
        const m = fuzzy(query, c.subject)
        return { kind: 'commit', key: c.hash, title: c.subject, sub: commitSub(shortHash(c.hash), relativeTime(c.authorDate)), score: m?.score ?? COMMIT_SCORE, ranges: m?.ranges ?? [] }
      })
      const best = Math.max(...results.map((r) => r.score)) + KIND_WEIGHT.commit
      const at = ranked.findIndex((g) => (g.results[0]?.score ?? 0) + KIND_WEIGHT[g.id as OmniKind] < best)
      ranked.splice(at < 0 ? ranked.length : at, 0, { id: 'commit', label: 'Commits', results, total: commits.total })
    }
    return ranked
  }, [local, sources, scope, commits, query, view])

  // Results arrive in stages (files and commits are asynchronous). Until the user moves the
  // highlight with the keys, it follows the top result, so Enter always means "the best match
  // so far"; once they have moved it, it stays on their row while that row is still there.
  const all = groups.flatMap((g) => g.results)
  const [selected, setSelected] = useState('')
  const moved = useRef(false)
  useEffect(() => {
    moved.current = false
  }, [query, scope])
  useEffect(() => {
    if (!moved.current || !all.some((r) => valueOf(r) === selected)) setSelected(all[0] ? valueOf(all[0]) : '')
  }, [groups])
  const current = all.find((r) => valueOf(r) === selected)

  const activate = (r: OmniResult, alt: boolean) => {
    close()
    rememberRecent(r)
    void runResult(r, alt, view, query)
  }

  // The local results trail the typing by a frame (useDeferredValue keeps typing smooth in big
  // repositories). Enter pressed in that frame waits for the results of what was typed, instead
  // of acting on the list for the previous text.
  const pendingEnter = useRef<boolean | null>(null)
  useEffect(() => {
    if (pendingEnter.current === null || local !== query) return
    const alt = pendingEnter.current
    pendingEnter.current = null
    if (all[0]) activate(all[0], alt)
  }, [groups, local, query])

  const input = useRef<HTMLInputElement>(null)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) moved.current = true
    if (e.key === 'Enter' && local !== query) {
      e.preventDefault()
      pendingEnter.current = e.ctrlKey || e.metaKey
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (current) activate(current, true)
    } else if (e.key === 'Tab' && !raw.startsWith('>')) {
      e.preventDefault()
      const i = SCOPES.indexOf(chip)
      setChip(SCOPES[(i + (e.shiftKey ? SCOPES.length - 1 : 1)) % SCOPES.length]!)
    }
  }

  return (
    <Command shouldFilter={false} loop value={selected} onValueChange={setSelected} onKeyDown={onKeyDown} label="Search"
      className="overflow-hidden rounded-xl border border-border bg-popover shadow-2xl shadow-black/50">
      <div className="flex h-13 items-center gap-3 border-b border-border px-4">
        <Search size={18} className="shrink-0 text-hint" />
        <Command.Input ref={input} autoFocus value={raw} onValueChange={setRaw} data-testid="palette-input"
          placeholder={chip === 'all' ? 'Search commits, branches, files, commands…' : `Search ${SCOPE_LABEL[chip].toLowerCase()}…`}
          className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-hint" />
        {searching && <Spinner className="text-hint" />}
        <kbd className="rounded border border-border px-1.5 py-0.5 text-2xs text-hint">Esc</kbd>
      </div>
      <div className="flex items-center gap-1 border-b border-border px-3 py-2" role="tablist" aria-label="Search in">
        {SCOPES.map((s) => (
          <button key={s} role="tab" aria-selected={scope === s} onClick={() => { setChip(s); if (raw.startsWith('>')) setRaw(raw.slice(1).trimStart()); input.current?.focus() }}
            data-testid={`omni-scope-${s}`}
            className={clsx('rounded-full px-2.5 py-0.5 text-xs', scope === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
            {SCOPE_LABEL[s]}
          </button>
        ))}
      </div>
      <Command.List className="max-h-[min(58vh,520px)] overflow-y-auto overscroll-contain p-2" data-testid="omni-results">
        {groups.length === 0 && (
          <div className="px-3 py-10 text-center text-sm text-hint" data-testid="omni-empty">
            {searching ? 'Searching history…' : query ? <>No results for “<span className="text-foreground">{query}</span>”</> : 'Type to search'}
          </div>
        )}
        {groups.map((g) => (
          <Command.Group key={g.id} heading={<GroupHeading label={g.label} shown={g.results.length} total={g.total} />}
            className="mb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1">
            {g.results.map((r) => (
              <ResultRow key={valueOf(r)} r={r} value={valueOf(r)} onSelect={() => activate(r, false)} />
            ))}
          </Command.Group>
        ))}
      </Command.List>
      <Footer current={current} />
    </Command>
  )
}

/**
 * One result, one 28 px line: the kind's icon, the title, and, only when it says something, a
 * quiet second part at the right: a command's shortcut, a file's folder, a commit's hash and date.
 */
function ResultRow({ r, value, onSelect }: { r: OmniResult; value: string; onSelect: () => void }) {
  const isPath = r.kind === 'file' || r.kind === 'change'
  const path = isPath ? splitPath(r.title, r.ranges) : null
  return (
    <Command.Item value={value} onSelect={onSelect} data-testid="omni-item" data-kind={r.kind}
      className="group flex h-row-lg cursor-default items-center gap-2 rounded-md px-2 data-[selected=true]:bg-accent">
      <span className="flex shrink-0 text-muted-foreground group-data-[selected=true]:text-foreground" data-testid="omni-icon">{ICON[r.kind]}</span>
      <span className={clsx('max-w-[70%] min-w-0 shrink-0 truncate text-sm', isPath && 'font-mono text-xs')}>
        {path ? <Highlight text={path.name} ranges={path.nameRanges} /> : <Highlight text={r.title} ranges={r.ranges} />}
      </span>
      {path?.dir ? (
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-hint" data-testid="omni-sub"><Highlight text={path.dir} ranges={path.dirRanges} /></span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-right text-2xs text-hint" data-testid={r.sub ? 'omni-sub' : undefined}>{r.sub}</span>
      )}
      <CornerDownLeft size={12} className="shrink-0 text-hint opacity-0 group-data-[selected=true]:opacity-100" />
    </Command.Item>
  )
}

function GroupHeading({ label, shown, total }: { label: string; shown: number; total: number }) {
  return (
    <SectionHeader className="h-row px-0" right={total > shown ? <span className="font-normal text-hint">{shown} of {total.toLocaleString()} · Tab to narrow</span> : undefined}>
      {label}
    </SectionHeader>
  )
}

/** The text with matched characters marked. */
function Highlight({ text, ranges }: { text: string; ranges: [number, number][] }) {
  return (
    <>
      {pieces(text, ranges).map((p, i) => p.hit
        ? <mark key={i} className="bg-transparent font-semibold text-primary">{p.text}</mark>
        : <span key={i}>{p.text}</span>)}
    </>
  )
}

function Footer({ current }: { current: OmniResult | undefined }) {
  const alt = current?.kind === 'branch' ? 'check out' : current?.kind === 'file' || current?.kind === 'change' ? 'open in editor' : null
  const Key = ({ children }: { children: ReactNode }) => <kbd className="rounded border border-border bg-background px-1 text-2xs">{children}</kbd>
  return (
    <div className="flex h-9 items-center gap-4 border-t border-border px-4 text-2xs text-hint" data-testid="omni-footer">
      <span className="flex items-center gap-1"><Key>↑</Key><Key>↓</Key> move</span>
      <span className="flex items-center gap-1"><Key>↵</Key> {current ? openLabel(current) : 'open'}</span>
      {alt && <span className="flex items-center gap-1"><Key>{modName()}</Key><Key>↵</Key> {alt}</span>}
      <span className="flex items-center gap-1"><Key>Tab</Key> filter</span>
      <span className="ml-auto flex items-center gap-1"><Key>&gt;</Key> commands only</span>
    </div>
  )
}

function openLabel(r: OmniResult): string {
  switch (r.kind) {
    case 'command': return 'run'
    case 'branch': case 'tag': case 'stash': case 'commit': return 'show in graph'
    case 'change': return 'show changes'
    case 'file': return 'show history'
    case 'setting': return 'open settings'
  }
}

// ------------------------------------------------------------------ sources

function localSources(view: RepoView | null, commands: ReturnType<typeof commandEntries>, files: string[] | null): Partial<Record<OmniKind, OmniEntry[]>> {
  const out: Partial<Record<OmniKind, OmniEntry[]>> = {
    command: commands.map((c) => ({ kind: 'command', key: c.id, title: c.label, sub: c.hint })),
    setting: Object.entries(SETTINGS).flatMap(([key, spec]) => spec.kind === 'internal' ? []
      : [{ kind: 'setting' as const, key, title: spec.label, sub: `${spec.section}${'keywords' in spec && spec.keywords ? ` · ${spec.keywords}` : ''}` }]),
  }
  if (!view) return out
  const snap = view.snapshot
  // HEAD's branch first, then local branches, then remote ones.
  const refs = [...snap.refs].sort((a, b) => Number(b.shortName === snap.head.branch) - Number(a.shortName === snap.head.branch))
  out.branch = refs.filter((r) => r.kind === 'local' || r.kind === 'remote').map((r) => ({
    kind: 'branch', key: r.name, title: r.shortName,
    // Only what the name and the icon do not already say: that it is checked out, or what it tracks.
    sub: r.kind === 'local' ? (r.shortName === snap.head.branch ? 'Checked out' : r.upstream ? `tracks ${r.upstream.replace('refs/remotes/', '')}` : undefined) : undefined,
  }))
  out.tag = snap.refs.filter((r) => r.kind === 'tag').reverse().map((r) => ({ kind: 'tag', key: r.name, title: r.shortName }))
  out.stash = view.stashes.map((s) => ({ kind: 'stash', key: s.hash, title: s.message, sub: `${s.ref} · ${relativeTime(s.date)}` }))
  out.change = snap.status.map((e) => ({
    kind: 'change', key: e.path, title: e.path,
    sub: e.kind === 'untracked' ? 'New file, not staged' : e.kind === 'unmerged' ? 'Conflict' : e.worktree !== '.' ? 'Changed, not staged' : 'Staged',
  }))
  if (files) {
    const changed = new Set(snap.status.map((e) => e.path))
    out.file = files.filter((p) => !changed.has(p)).map((p) => ({ kind: 'file', key: p, title: p }))
  }
  return out
}

/** With nothing typed: what you picked lately, a few common commands, and what you are changing. */
function emptyGroups(view: RepoView | null, sources: Partial<Record<OmniKind, OmniEntry[]>>, scope: OmniScope): Group[] {
  const as = (e: OmniEntry): OmniResult => ({ ...e, score: 0, ranges: [] })
  const groups: Group[] = []
  if (scope === 'all') {
    // A command is shown as it is now (its second line was once its group, "Repository").
    const recent = loadRecent().filter((e) => e.kind !== 'command' || sources.command?.some((c) => c.key === e.key))
      .map((e) => e.kind === 'command' ? sources.command!.find((c) => c.key === e.key)! : e)
    if (recent.length) groups.push({ id: 'recent', label: 'Recent', results: recent.map(as), total: recent.length })
    const suggested = (sources.command ?? []).filter((c) => SUGGESTED.includes(c.key) && !recent.some((r) => r.kind === 'command' && r.key === c.key))
    if (suggested.length) groups.push({ id: 'suggested', label: 'Suggestions', results: suggested.map(as), total: suggested.length })
    if (view && sources.change?.length) groups.push({ id: 'change', label: 'Changed files', results: sources.change.slice(0, 5).map(as), total: sources.change.length })
    return groups
  }
  // A scope with nothing typed lists what it has (commits need a query: there are too many).
  for (const kind of kindsOf(scope)) {
    const list = sources[kind]
    if (list?.length) groups.push({ id: kind, label: kind === 'command' ? 'Commands' : kind[0]!.toUpperCase() + kind.slice(1) + 's', results: list.slice(0, 50).map(as), total: list.length })
  }
  return groups
}

// ------------------------------------------------------------------ what choosing does

async function runResult(r: OmniResult, alt: boolean, view: RepoView | null, query: string): Promise<void> {
  if (r.kind === 'command') return void commandEntries().find((c) => c.id === r.key)?.run()
  if (r.kind === 'setting') return void useStore.setState({ page: 'settings', settingsQuery: r.title })
  if (!view) return
  const id = view.id
  const show = async (hash: string) => {
    updateRepo(id, { selected: { kind: 'commit', hash }, center: { kind: 'graph' } })
    await ensureLoaded(id, hash)
  }
  switch (r.kind) {
    case 'branch': {
      const ref = view.snapshot.refs.find((x) => x.name === r.key)
      if (!ref) return
      return alt ? void checkout(id, ref.name) : show(ref.hash)
    }
    case 'tag': {
      const ref = view.snapshot.refs.find((x) => x.name === r.key)
      return ref ? show(ref.hash) : undefined
    }
    case 'stash':
      // With stashes off the graph, a stash is never in the log: looking for it there would page
      // through the whole history. Select it anyway; the detail panel shows it.
      if (!useStore.getState().settings?.showStashes) return updateRepo(id, { selected: { kind: 'commit', hash: r.key }, center: { kind: 'graph' } })
      return show(r.key)
    case 'commit':
      return show(r.key)
    case 'change': {
      if (alt) return openInEditor(`${view.snapshot.path}/${r.key}`)
      const e = view.snapshot.status.find((x) => x.path === r.key)
      const target: DiffTarget = !e || e.kind === 'untracked' ? { kind: 'untracked', path: r.key } : e.worktree !== '.' ? { kind: 'unstaged', path: r.key } : { kind: 'staged', path: r.key }
      return updateRepo(id, { center: { kind: 'file', target, mode: 'diff' } })
    }
    case 'file': {
      if (alt || !view.snapshot.head.hash) return openInEditor(`${view.snapshot.path}/${r.key}`)
      return updateRepo(id, { center: { kind: 'file', target: { kind: 'commit', hash: view.snapshot.head.hash, path: r.key }, mode: 'history' } })
    }
  }
}
