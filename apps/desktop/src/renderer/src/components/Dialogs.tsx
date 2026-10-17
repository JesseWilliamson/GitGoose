import clsx from 'clsx'
import { KeyRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { parseGitHubRemote, type Identity, type LfsLock } from '@gitsquid/shared'
import { cleanupCandidates, cloneRepo, confirmAction, deleteBranches, lfsLock, loadPulls, openPull, run, STALE_DAYS } from '../lib/actions'
import { relativeTime } from '../lib/format'
import { COMMANDS, FIXED_KEYS, formatCombo, keymap, modName } from '../lib/keys'
import { api } from '../lib/api'
import { dismissToast, setting, toast, useStore } from '../lib/store'
import { Button, Modal, TextField } from './ui'

export function Dialogs() {
  const dialog = useStore((s) => s.dialog)
  const close = () => useStore.setState({ dialog: null })
  if (!dialog) return null
  if (dialog.kind === 'input') return <InputDialog key={dialog.title} d={dialog} close={close} />
  if (dialog.kind === 'confirm') {
    return (
      <Modal open onClose={close} title={dialog.title}>
        <p className="mb-4 text-[13px] text-muted">{dialog.message}</p>
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button autoFocus variant={dialog.danger ? 'danger' : 'primary'} onClick={() => { close(); void dialog.onConfirm() }}>{dialog.confirm}</Button>
        </div>
      </Modal>
    )
  }
  if (dialog.kind === 'choice') {
    return (
      <Modal open onClose={close} title={dialog.title} width={500}>
        <div data-testid="choice-dialog">
          <p className="mb-3 text-[13px] text-muted">{dialog.message}</p>
          {dialog.detail && <pre className="selectable mb-4 max-h-40 overflow-auto rounded bg-bg p-2 font-mono text-[11px] whitespace-pre-wrap text-muted">{dialog.detail}</pre>}
          <div className="flex flex-wrap justify-end gap-2">
            {dialog.choices.map((c, i) => (
              <Button key={c.label} autoFocus={i === 0} variant={c.variant ?? 'default'} onClick={() => { close(); void c.run?.() }}>{c.label}</Button>
            ))}
          </div>
        </div>
      </Modal>
    )
  }
  if (dialog.kind === 'shortcuts') return <ShortcutsDialog close={close} />
  if (dialog.kind === 'text') return <TextDialog key={dialog.title} d={dialog} close={close} />
  if (dialog.kind === 'cleanup') return <CleanupDialog repoId={dialog.repoId} close={close} />
  if (dialog.kind === 'create-pr') return <CreatePullDialog repoId={dialog.repoId} branch={dialog.branch} close={close} />
  if (dialog.kind === 'lfs-locks') return <LfsLocksDialog repoId={dialog.repoId} close={close} />
  if (dialog.kind === 'pick') return <PickDialog key={dialog.title} d={dialog} close={close} />
  if (dialog.kind === 'identity') return <IdentityDialog repoId={dialog.repoId} onSaved={dialog.onSaved} close={close} />
  return <CloneDialog close={close} />
}

/** Multi-line text (a commit message): Ctrl/Cmd+Enter submits. */
function TextDialog({ d, close }: { d: Extract<NonNullable<ReturnType<typeof useStore.getState>['dialog']>, { kind: 'text' }>; close: () => void }) {
  const [value, setValue] = useState(d.initial)
  const submit = () => {
    if (!value.trim()) return
    close()
    d.onSubmit(value)
  }
  return (
    <Modal open onClose={close} title={d.title} width={560}>
      <textarea autoFocus value={value} onChange={(e) => setValue(e.target.value)} rows={8} data-testid="dialog-text"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
        }}
        style={{ fontFamily: 'var(--gs-code-font)' }}
        className="w-full resize-y rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] outline-none focus:border-accent" />
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={!value.trim()} onClick={submit} data-testid="dialog-submit">{d.confirm}</Button>
      </div>
    </Modal>
  )
}

/**
 * Branch cleanup (Tower): branches already merged into HEAD are ticked, stale ones are offered but
 * left unticked. Deleting unmerged branches needs force, so the button says so before it happens.
 */
function CleanupDialog({ repoId, close }: { repoId: string; close: () => void }) {
  const view = useStore((s) => s.repos[repoId])
  const candidates = view ? cleanupCandidates(view) : []
  const [picked, setPicked] = useState(() => new Set(candidates.filter((c) => c.merged).map((c) => c.name)))
  const unmerged = candidates.filter((c) => picked.has(c.name) && !c.merged).length
  const toggle = (name: string) => setPicked((p) => {
    const next = new Set(p)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    return next
  })
  const submit = () => {
    close()
    void deleteBranches(repoId, candidates.filter((c) => picked.has(c.name)).map((c) => c.name), unmerged > 0)
  }
  return (
    <Modal open onClose={close} title="Clean up branches" width={520}>
      <p className="mb-3 text-[13px] text-muted">
        Merged branches are already part of {view?.snapshot.head.branch ?? 'HEAD'}. Stale ones have had no commits for {STALE_DAYS} days. Undo brings deleted branches back.
      </p>
      {candidates.length === 0 && <p className="mb-3 text-[13px] text-faint">Nothing to clean up.</p>}
      <div className="mb-3 max-h-72 overflow-y-auto rounded-md border border-line" data-testid="cleanup-list">
        {candidates.map((c) => (
          <label key={c.name} className="flex h-7 items-center gap-2 px-2 text-[13px] hover:bg-hover">
            <input type="checkbox" checked={picked.has(c.name)} onChange={() => toggle(c.name)} aria-label={c.name} />
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            {c.merged && <span className="text-[10px] text-add">merged</span>}
            {c.stale && <span className="text-[10px] text-warn">stale</span>}
            {c.date !== undefined && <span className="w-20 text-right text-[11px] text-faint">{relativeTime(c.date)}</span>}
          </label>
        ))}
      </div>
      {unmerged > 0 && <p className="mb-3 text-[12px] text-warn">{unmerged} of these {unmerged === 1 ? 'is' : 'are'} not merged: {unmerged === 1 ? 'its' : 'their'} commits will only be reachable through undo.</p>}
      <div className="flex justify-end gap-2">
        <Button onClick={close}>Cancel</Button>
        <Button variant={unmerged ? 'danger' : 'primary'} disabled={picked.size === 0} onClick={submit} data-testid="dialog-submit">
          Delete {picked.size} branch{picked.size === 1 ? '' : 'es'}
        </Button>
      </div>
    </Modal>
  )
}

/**
 * Who commits are made as. Git reads user.name / user.email from the repository's own config
 * first, then the user's global config; this edits either, and can drop the repository's
 * override so the global identity applies again.
 */
function IdentityDialog({ repoId, onSaved, close }: { repoId: string; onSaved?: () => void; close: () => void }) {
  const [current, setCurrent] = useState<Identity | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [scope, setScope] = useState<'local' | 'global'>('global')
  useEffect(() => {
    void api.identity(repoId).then((i) => {
      setCurrent(i)
      setName(i.name ?? '')
      setEmail(i.email ?? '')
      setScope(i.scope === 'local' ? 'local' : 'global')
    })
  }, [repoId])
  const save = (s: 'local' | 'global', n: string | null, e: string | null) => {
    close()
    void run(repoId, 'Change identity', () => api.setIdentity(repoId, s, n, e), { success: n ? `Committing as ${n}` : 'Using your global identity here' }).then(() => onSaved?.())
  }
  const submit = (ev: React.FormEvent) => {
    ev.preventDefault()
    if (name.trim() && email.trim()) save(scope, name.trim(), email.trim())
  }
  return (
    <Modal open onClose={close} title="Who you commit as" width={460}>
      <form onSubmit={submit} className="space-y-3" data-testid="identity-dialog">
        <TextField autoFocus label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="space-y-1 text-[13px]">
          <label className="flex items-center gap-2"><input type="radio" checked={scope === 'global'} onChange={() => setScope('global')} /> Every repository (your global git config)</label>
          <label className="flex items-center gap-2"><input type="radio" checked={scope === 'local'} onChange={() => setScope('local')} /> Only this repository</label>
        </div>
        {current?.scope === 'local' && current.global.name && (
          <p className="text-xs text-muted">
            This repository overrides your global identity ({current.global.name} &lt;{current.global.email}&gt;).{' '}
            <button type="button" className="text-accent hover:underline" onClick={() => save('local', null, null)}>Use the global one here</button>
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !email.trim()} data-testid="dialog-submit">Save</Button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * Open a pull request for a branch. If GitHub does not have the branch's latest commits yet, it
 * is pushed first (to the GitHub remote, under the same name), since a pull request is made of
 * what is on GitHub.
 */
function CreatePullDialog({ repoId, branch, close }: { repoId: string; branch: string; close: () => void }) {
  const view = useStore((s) => s.repos[repoId])
  const remote = view?.remotes.find((r) => parseGitHubRemote(r.fetchUrl))?.name
  const bases = (view?.snapshot.refs ?? []).filter((r) => r.kind === 'remote' && remote && r.shortName.startsWith(`${remote}/`))
    .map((r) => r.shortName.slice(remote!.length + 1)).filter((b) => b !== branch && b !== 'HEAD')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState(() => ['main', 'master', 'develop'].find((b) => bases.includes(b)) ?? bases[0] ?? 'main')
  const [draft, setDraft] = useState(false)
  const local = view?.snapshot.refs.find((r) => r.name === `refs/heads/${branch}`)
  useEffect(() => {
    if (local) void api.commitDetails(repoId, local.hash).then((d) => setTitle((t) => t || d.subject), () => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, local?.hash])
  // GitHub needs the branch with its latest commits: tracked on the GitHub remote, nothing unpushed.
  const needsPush = !local?.upstream || local.upstream !== `refs/remotes/${remote}/${branch}` || local.upstreamGone || (local.ahead ?? 0) > 0
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !remote) return
    close()
    void run(repoId, 'Create pull request', async () => {
      if (needsPush) await api.push(repoId, { branch, remote })
      const pr = await api.createPullRequest(repoId, { branch, base, title: title.trim(), body: body.trim(), draft })
      toast({ kind: 'success', title: `Opened pull request #${pr.number}`, action: { label: 'Open', run: () => openPull(pr.url) } }, 8000)
      void loadPulls(repoId)
    }, { quiet: true })
  }
  return (
    <Modal open onClose={close} title={`Pull request for ${branch}`} width={520}>
      <form onSubmit={submit} className="space-y-3" data-testid="create-pr">
        <TextField autoFocus label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Description</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder="What this changes and why"
            className="w-full resize-y rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] outline-none focus:border-accent" />
        </label>
        <div className="flex items-center gap-3 text-[13px]">
          <label className="flex items-center gap-2">Into
            <select value={base} onChange={(e) => setBase(e.target.value)} aria-label="Base branch" className="h-7 rounded-md border border-line bg-bg px-1 text-[13px]">
              {(bases.length ? bases : [base]).map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft</label>
        </div>
        {needsPush && <p className="text-xs text-muted">{branch} will be pushed to {remote} first.</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!title.trim() || !remote} data-testid="dialog-submit">Create pull request</Button>
        </div>
      </form>
    </Modal>
  )
}

/** Locks on the LFS server: who holds what. Asking is a network call, made when this opens. */
function LfsLocksDialog({ repoId, close }: { repoId: string; close: () => void }) {
  const [locks, setLocks] = useState<LfsLock[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => api.lfsLocks(repoId).then(setLocks, (e) => setError(e instanceof Error ? e.message : String(e)))
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId])
  const unlock = (l: LfsLock) => {
    const go = (force: boolean) => void lfsLock(repoId, l.path, false, force).then(() => load())
    // Releasing someone else's lock needs --force; say so first.
    confirmAction(`Unlock ${l.path}?`, `${l.owner || 'Someone'} holds this lock. If it is not yours, unlocking forces it and they may lose work.`, 'Unlock', () => go(true))
  }
  return (
    <Modal open onClose={close} title="Git LFS locks" width={560}>
      {error ? <p className="mb-3 text-[13px] text-del">{error}</p>
        : locks === null ? <p className="mb-3 text-[13px] text-faint">Asking the server…</p>
        : locks.length === 0 ? <p className="mb-3 text-[13px] text-faint">No files are locked.</p>
        : (
          <div className="mb-3 max-h-72 overflow-y-auto rounded-md border border-line" data-testid="lfs-locks">
            {locks.map((l) => (
              <div key={l.id} className="flex h-8 items-center gap-2 px-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{l.path}</span>
                <span className="text-xs text-muted">{l.owner}</span>
                <Button size="sm" variant="ghost" onClick={() => unlock(l)}>Unlock</Button>
              </div>
            ))}
          </div>
        )}
      <div className="flex justify-end"><Button onClick={close}>Close</Button></div>
    </Modal>
  )
}

/** Choose one item from a filterable list: type to narrow, arrows to move, Enter to pick. */
function PickDialog({ d, close }: { d: Extract<NonNullable<ReturnType<typeof useStore.getState>['dialog']>, { kind: 'pick' }>; close: () => void }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const f = q.trim().toLowerCase()
  const shown = d.items.filter((i) => !f || i.label.toLowerCase().includes(f) || i.detail?.toLowerCase().includes(f))
  const pick = (value: string) => {
    close()
    d.onPick(value)
  }
  return (
    <Modal open onClose={close} title={d.title}>
      <input autoFocus value={q} placeholder={d.placeholder ?? 'Filter'} data-testid="pick-filter"
        onChange={(e) => { setQ(e.target.value); setAt(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setAt((a) => Math.min(a + 1, shown.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)) }
          else if (e.key === 'Enter' && shown[at]) { e.preventDefault(); pick(shown[at]!.value) }
        }}
        className="mb-2 h-8 w-full rounded-md border border-line bg-bg px-2 text-[13px] outline-none focus:border-accent" />
      <div className="max-h-72 overflow-y-auto" role="listbox">
        {shown.map((i, n) => (
          <div key={i.value} role="option" aria-selected={n === at} onMouseEnter={() => setAt(n)} onClick={() => pick(i.value)} data-testid="pick-item"
            className={clsx('flex h-8 cursor-default items-center gap-2 rounded px-2 text-[13px]', n === at && 'bg-accent text-accent-fg')}>
            <span className="truncate">{i.label}</span>
            {i.detail && <span className={clsx('truncate text-xs', n === at ? 'text-accent-fg/80' : 'text-faint')}>{i.detail}</span>}
          </div>
        ))}
        {shown.length === 0 && <div className="px-2 py-2 text-xs text-faint">Nothing matches</div>}
      </div>
    </Modal>
  )
}

function InputDialog({ d, close }: { d: Extract<NonNullable<ReturnType<typeof useStore.getState>['dialog']>, { kind: 'input' }>; close: () => void }) {
  const [value, setValue] = useState(d.initial ?? '')
  const [extra, setExtra] = useState(d.extra?.initial ?? '')
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!value.trim()) return
    close()
    void d.onSubmit(value, extra)
  }
  return (
    <Modal open onClose={close} title={d.title}>
      <form onSubmit={submit} className="space-y-3">
        <TextField autoFocus label={d.label} placeholder={d.placeholder} value={value} onChange={(e) => setValue(e.target.value)} data-testid="dialog-input" />
        {d.extra && <TextField label={d.extra.label} placeholder={d.extra.placeholder} value={extra} onChange={(e) => setExtra(e.target.value)} />}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!value.trim()} data-testid="dialog-submit">{d.confirm}</Button>
        </div>
      </form>
    </Modal>
  )
}

function CloneDialog({ close }: { close: () => void }) {
  const [url, setUrl] = useState('')
  const [dir, setDir] = useState('')
  const progress = useStore((s) => s.cloneProgress)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim() || !dir) return
    if (await cloneRepo(url.trim(), dir)) close()
  }
  return (
    <Modal open onClose={close} title="Clone a repository" width={520}>
      <form onSubmit={submit} className="space-y-3">
        <TextField autoFocus label="URL" placeholder="https://github.com/owner/repo.git" value={url} onChange={(e) => setUrl(e.target.value)} />
        <div className="flex items-end gap-2">
          <div className="flex-1"><TextField label="Into folder" value={dir} readOnly placeholder="Choose a parent folder" /></div>
          <Button type="button" onClick={async () => setDir((await api.pickDirectory()) ?? dir)}>Choose…</Button>
        </div>
        {progress && <div className="truncate font-mono text-xs text-muted">{progress}</div>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!url.trim() || !dir || !!progress}>Clone</Button>
        </div>
      </form>
    </Modal>
  )
}

function ShortcutsDialog({ close }: { close: () => void }) {
  const mod = modName()
  return (
    <Modal open onClose={close} title="Keyboard shortcuts" width={520}>
      <table className="w-full text-[13px]" data-testid="shortcuts">
        <tbody>
          {/* The live bindings, so rebinding in Settings → Keyboard shows up here too. */}
          {COMMANDS.map((c) => {
            const combos = [...keymap(setting('keybindings'))].filter(([, id]) => id === c.id).map(([k]) => formatCombo(k))
            return combos.length ? (
              <tr key={c.id} className="border-b border-line/50">
                <td className="py-1.5 pr-4 font-mono text-xs whitespace-nowrap text-muted">{combos.join('  or  ')}</td>
                <td className="py-1.5">{c.label}</td>
              </tr>
            ) : null
          })}
          {FIXED_KEYS.map((s) => (
            <tr key={s.what} className="border-b border-line/50 last:border-0">
              <td className="py-1.5 pr-4 font-mono text-xs whitespace-nowrap text-muted">{s.keys.replaceAll('mod', mod)}</td>
              <td className="py-1.5">{s.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  )
}

/** A credential prompt from git or ssh, relayed by the askpass trampoline in the main process. */
export function PromptDialog() {
  const prompt = useStore((s) => s.prompt)
  const [value, setValue] = useState('')
  useEffect(() => setValue(''), [prompt?.promptId])
  if (!prompt) return null
  const answer = (a: string | null) => {
    useStore.setState({ prompt: null })
    void api.respondPrompt(prompt.promptId, a)
  }
  return (
    <Modal open onClose={() => answer(null)} title="Git needs your credentials">
      <form onSubmit={(e) => { e.preventDefault(); answer(value) }} className="space-y-3">
        <div className="flex items-start gap-2 text-[13px] text-muted"><KeyRound size={16} className="mt-0.5 shrink-0" />{prompt.message.trim()}</div>
        <TextField autoFocus type={prompt.secret ? 'password' : 'text'} value={value} onChange={(e) => setValue(e.target.value)} data-testid="prompt-input" />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={() => answer(null)}>Cancel</Button>
          <Button type="submit" variant="primary">Continue</Button>
        </div>
      </form>
    </Modal>
  )
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const [expanded, setExpanded] = useState<number | null>(null)
  return (
    // Bottom centre, over the graph: bottom right would cover the Commit button for 5 seconds.
    <div className="pointer-events-none fixed bottom-8 left-1/2 z-50 flex w-96 max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-2" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} role="status" data-kind={t.kind}
          className="pointer-events-auto rounded-lg border border-line bg-raised p-3 text-[13px] shadow-xl shadow-black/30">
          <div className="flex items-start gap-2">
            <span className={`mt-1 size-2 shrink-0 rounded-full ${t.kind === 'success' ? 'bg-add' : 'bg-accent'}`} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t.title}</div>
              {t.detail && (
                <pre onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                  className={`selectable mt-1 cursor-pointer font-mono text-[11px] whitespace-pre-wrap text-muted ${expanded === t.id ? 'max-h-64 overflow-auto' : 'line-clamp-3'}`}>{t.detail}</pre>
              )}
            </div>
            {t.action && (
              <Button size="sm" onClick={() => { dismissToast(t.id); t.action!.run() }} data-testid="toast-action">{t.action.label}</Button>
            )}
            <button onClick={() => dismissToast(t.id)} className="text-faint hover:text-fg" title="Dismiss">✕</button>
          </div>
        </div>
      ))}
    </div>
  )
}
