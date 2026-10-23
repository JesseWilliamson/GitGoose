import clsx from 'clsx'
import { KeyRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { pickGitHubRemote, type Identity, type LfsLock, type PushCheck, type PushCheckResult, type ReviewLearning } from '@gitgoose/shared'
import { cleanupCandidates, cloneRepo, confirmAction, deleteBranches, lfsLock, openPull, run, STALE_DAYS } from '../lib/actions'
import { relativeTime } from '../lib/format'
import { COMMANDS, FIXED_KEYS, formatCombo, keymap, modName } from '../lib/keys'
import { api } from '../lib/api'
import { withPushChecks } from '../lib/pushchecks'
import { setting, toast, useStore } from '../lib/store'
import { Button, Modal, ModalFooter, TextField } from './ui'
import { OptionSelect } from './OptionSelect'
import { AiTargetButton } from './AiTargetButton'

export function Dialogs() {
  const dialog = useStore((s) => s.dialog)
  const close = () => useStore.setState({ dialog: null })
  if (!dialog) return null
  if (dialog.kind === 'input') return <InputDialog key={dialog.title} d={dialog} close={close} />
  if (dialog.kind === 'confirm') {
    return (
      <Modal open onClose={close} title={dialog.title}>
        <p className="text-sm text-muted-foreground">{dialog.message}</p>
        <ModalFooter>
          <Button onClick={close}>Cancel</Button>
          <Button autoFocus variant={dialog.danger ? 'danger' : 'primary'} onClick={() => { close(); void dialog.onConfirm() }}>{dialog.confirm}</Button>
        </ModalFooter>
      </Modal>
    )
  }
  if (dialog.kind === 'choice') {
    return (
      <Modal open onClose={() => { close(); dialog.onDismiss?.() }} title={dialog.title} size="md">
        <div className="space-y-3" data-testid="choice-dialog">
          <p className="text-sm text-muted-foreground">{dialog.message}</p>
          {dialog.detail && <pre className="selectable max-h-40 overflow-auto rounded bg-background p-2 font-mono text-2xs whitespace-pre-wrap text-muted-foreground">{dialog.detail}</pre>}
          <ModalFooter>
            {dialog.choices.map((c, i) => (
              <Button key={c.label} autoFocus={i === 0} variant={c.variant ?? 'default'} onClick={() => { close(); void c.run?.() }}>{c.label}</Button>
            ))}
          </ModalFooter>
        </div>
      </Modal>
    )
  }
  if (dialog.kind === 'shortcuts') return <ShortcutsDialog close={close} />
  if (dialog.kind === 'text') return <TextDialog key={dialog.title} d={dialog} close={close} />
  if (dialog.kind === 'cleanup') return <CleanupDialog repoId={dialog.repoId} close={close} />
  if (dialog.kind === 'learnings') return <LearningsDialog repoId={dialog.repoId} close={close} />
  if (dialog.kind === 'push-checks') return <PushChecksDialog d={dialog} close={close} />
  if (dialog.kind === 'push-rules') return <PushRulesDialog repoId={dialog.repoId} close={close} />
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
    <Modal open onClose={close} title={d.title} size="md">
      <textarea autoFocus value={value} onChange={(e) => setValue(e.target.value)} rows={8} data-testid="dialog-text"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
        }}
        style={{ fontFamily: 'var(--gs-code-font)' }}
        className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary" />
      <ModalFooter>
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={!value.trim()} onClick={submit} data-testid="dialog-submit">{d.confirm}</Button>
      </ModalFooter>
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
    <Modal open onClose={close} title="Clean up branches" size="md" onEnter={() => picked.size > 0 && submit()}>
      <p className="text-sm text-muted-foreground">
        Merged branches are already part of {view?.snapshot.head.branch ?? 'HEAD'}. Stale ones have had no commits for {STALE_DAYS} days. Undo brings deleted branches back.
      </p>
      {candidates.length === 0 && <p className="text-sm text-hint">Nothing to clean up.</p>}
      <div className="max-h-72 overflow-y-auto rounded-md border border-border" data-testid="cleanup-list">
        {candidates.map((c) => (
          <label key={c.name} className="flex h-7 items-center gap-2 px-2 text-sm hover:bg-accent">
            <input type="checkbox" checked={picked.has(c.name)} onChange={() => toggle(c.name)} aria-label={c.name} />
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            {c.merged && <span className="text-2xs text-add">merged</span>}
            {c.stale && <span className="text-2xs text-warn">stale</span>}
            {c.date !== undefined && <span className="w-20 text-right text-2xs text-hint">{relativeTime(c.date)}</span>}
          </label>
        ))}
      </div>
      {unmerged > 0 && <p className="text-xs text-warn">{unmerged} of these {unmerged === 1 ? 'is' : 'are'} not merged: {unmerged === 1 ? 'its' : 'their'} commits will only be reachable through undo.</p>}
      <ModalFooter>
        <Button onClick={close}>Cancel</Button>
        <Button variant={unmerged ? 'danger' : 'primary'} disabled={picked.size === 0} onClick={submit} data-testid="dialog-submit">
          Delete {picked.size} branch{picked.size === 1 ? '' : 'es'}
        </Button>
      </ModalFooter>
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
    <Modal open onClose={close} title="Who you commit as" size="md">
      <form onSubmit={submit} className="space-y-3" data-testid="identity-dialog">
        <TextField autoFocus label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="space-y-1 text-sm">
          <label className="flex items-center gap-2"><input type="radio" checked={scope === 'global'} onChange={() => setScope('global')} /> Every repository (your global git config)</label>
          <label className="flex items-center gap-2"><input type="radio" checked={scope === 'local'} onChange={() => setScope('local')} /> Only this repository</label>
        </div>
        {current?.scope === 'local' && current.global.name && (
          <p className="text-xs text-muted-foreground">
            This repository overrides your global identity ({current.global.name} &lt;{current.global.email}&gt;).{' '}
            <button type="button" className="text-primary hover:underline" onClick={() => save('local', null, null)}>Use the global one here</button>
          </p>
        )}
        <ModalFooter>
          <Button type="button" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !email.trim()} data-testid="dialog-submit">Save</Button>
        </ModalFooter>
      </form>
    </Modal>
  )
}

/**
 * Open a pull request for a branch. If GitHub does not have the branch's latest commits yet, it
 * is pushed first (to the GitHub remote, under the same name), since a pull request is made of
 * what is on GitHub. Then GitHub's own "new pull request" page opens in the browser with the
 * title, description and base filled in: creating it through the API would need a sign-in,
 * which GitGoose does not have, while the browser usually is signed in already.
 */
function CreatePullDialog({ repoId, branch, close }: { repoId: string; branch: string; close: () => void }) {
  const view = useStore((s) => s.repos[repoId])
  // The same remote main opens the pull request on, so the push lands where GitHub looks.
  const remote = pickGitHubRemote((view?.remotes ?? []).map((r) => ({ name: r.name, url: r.fetchUrl })))?.remote
  const bases = (view?.snapshot.refs ?? []).filter((r) => r.kind === 'remote' && remote && r.shortName.startsWith(`${remote}/`))
    .map((r) => r.shortName.slice(remote!.length + 1)).filter((b) => b !== branch && b !== 'HEAD')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState(() => ['main', 'master', 'develop'].find((b) => bases.includes(b)) ?? bases[0] ?? 'main')
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
    const create = () => void run(repoId, 'Create pull request', async () => {
      if (needsPush) await api.push(repoId, { branch, remote })
      const url = await api.createPullRequest(repoId, { branch, base, title: title.trim(), body: body.trim() })
      toast({ kind: 'success', title: 'Finish the pull request on GitHub, in your browser', action: { label: 'Open again', run: () => openPull(url) } }, 8000)
    }, { quiet: true })
    // The push the pull request needs goes through the same pre-push checks as any other.
    if (needsPush) void withPushChecks(repoId, branch, create)
    else create()
  }
  return (
    <Modal open onClose={close} title={`Pull request for ${branch}`} size="md">
      <form onSubmit={submit} className="space-y-3" data-testid="create-pr">
        <TextField autoFocus label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Description</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder="What this changes and why"
            className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary" />
        </label>
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-2">Into
            <OptionSelect value={base} onChange={setBase} aria-label="Base branch" className="px-2 data-[size=default]:h-input"
              options={(bases.length ? bases : [base]).map((b) => ({ value: b, label: b }))} />
          </label>
        </div>
        {needsPush && <p className="text-xs text-muted-foreground">{branch} will be pushed to {remote} first.</p>}
        <ModalFooter>
          <Button type="button" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!title.trim() || !remote} data-testid="dialog-submit">Continue on GitHub</Button>
        </ModalFooter>
      </form>
    </Modal>
  )
}

/** What this repository's reviews have been told to accept (saved from dismissed findings). */
function LearningsDialog({ repoId, close }: { repoId: string; close: () => void }) {
  const [list, setList] = useState<ReviewLearning[] | null>(null)
  useEffect(() => {
    void api.reviewLearnings(repoId).then(setList)
  }, [repoId])
  const remove = async (i: number) => {
    const next = list!.filter((_, n) => n !== i)
    await api.setReviewLearnings(repoId, next)
    setList(next)
  }
  return (
    <Modal open onClose={close} title="Review learnings" size="md">
      <p className="text-sm text-muted-foreground">Sent with every review of this repository. They come from "Don't flag again" on findings.</p>
      {list?.length === 0 && <p className="text-sm text-hint">None yet.</p>}
      <div className="max-h-72 overflow-y-auto" data-testid="learnings">
        {list?.map((l, i) => (
          <div key={i} className="flex items-center gap-2 border-b border-border/60 py-1.5 text-sm">
            <span className="min-w-0 flex-1">{l.text}{l.path && <span className="ml-2 font-mono text-2xs text-hint">{l.path}</span>}</span>
            <Button size="sm" variant="ghost" onClick={() => void remove(i)}>Remove</Button>
          </div>
        ))}
      </div>
      <ModalFooter><Button autoFocus onClick={close}>Close</Button></ModalFooter>
    </Modal>
  )
}

const VERDICT: Record<PushCheckResult['verdict'], { icon: string; className: string; label: string }> = {
  pass: { icon: '✓', className: 'text-add', label: 'passed' },
  fail: { icon: '✗', className: 'text-destructive', label: 'failed' },
  inconclusive: { icon: '?', className: 'text-warn', label: 'could not tell' },
}
const SOURCE: Record<PushCheckResult['source'], string> = { builtin: 'built in', repo: '.coderabbit.yaml', settings: 'yours' }

/** Pre-push results that need a decision. Cancel is the default; pushing past a blocking failure says so. */
function PushChecksDialog({ d, close }: { d: Extract<NonNullable<ReturnType<typeof useStore.getState>['dialog']>, { kind: 'push-checks' }>; close: () => void }) {
  const failed = d.results.filter((r) => r.verdict === 'fail').length
  return (
    <Modal open onClose={close} title={d.outcome === 'block' ? 'A pre-push check failed' : 'Pre-push checks'} size="md">
      <p className="text-sm text-muted-foreground">
        {d.label}. {failed ? `${failed} of ${d.results.length} check${d.results.length === 1 ? '' : 's'} failed.` : 'A blocking check could not be judged.'}
        {d.outcome === 'block' ? ' Nothing was pushed.' : ''}
      </p>
      <div className="max-h-80 overflow-y-auto" data-testid="push-checks">
        {d.results.map((r, i) => (
          <div key={i} className="border-b border-border/60 py-2 text-sm" data-testid="push-check" data-verdict={r.verdict}>
            <div className="flex items-center gap-2">
              <span className={clsx('w-4 text-center font-bold', VERDICT[r.verdict].className)} aria-label={VERDICT[r.verdict].label}>{VERDICT[r.verdict].icon}</span>
              <span className="min-w-0 flex-1 font-semibold">{r.name}</span>
              <span className="text-2xs text-hint">{SOURCE[r.source]}</span>
              <span className={clsx('rounded px-1 text-2xs uppercase', r.mode === 'block' ? 'bg-destructive/15 text-destructive' : 'bg-accent text-muted-foreground')}>{r.mode === 'block' ? 'blocks' : 'warns'}</span>
            </div>
            <p className="selectable mt-1 pl-6 text-muted-foreground">{r.reason}</p>
            {r.evidence.length > 0 && <p className="selectable mt-0.5 pl-6 font-mono text-2xs text-hint">{r.evidence.map((e) => `${e.path}:${e.line}`).join('  ')}</p>}
          </div>
        ))}
      </div>
      <ModalFooter>
        <Button variant="ghost" onClick={() => useStore.setState({ dialog: { kind: 'push-rules', repoId: d.repoId } })}>Edit checks…</Button>
        {/* For the next push: the checks above were judged already. */}
        <AiTargetButton area="push-checks" />
        <span className="flex-1" />
        <Button autoFocus onClick={close}>Cancel</Button>
        <Button variant={d.outcome === 'block' ? 'danger' : 'primary'} onClick={() => { close(); d.onPush() }} data-testid="push-anyway">
          {d.outcome === 'block' ? 'Push anyway' : 'Push'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

/** This repository's own pre-push checks (saved in settings), next to the ones its .coderabbit.yaml defines. */
function PushRulesDialog({ repoId, close }: { repoId: string; close: () => void }) {
  const [repo, setRepo] = useState<PushCheck[]>([])
  const [mine, setMine] = useState<PushCheck[] | null>(null)
  useEffect(() => {
    void api.pushCheckRules(repoId).then((r) => {
      setRepo(r.repo)
      setMine(r.mine)
    })
  }, [repoId])
  const edit = (i: number, patch: Partial<PushCheck>) => setMine((m) => m!.map((c, n) => (n === i ? { ...c, ...patch } : c)))
  const save = async () => {
    await api.setPushChecks(repoId, mine!.map((c) => ({ ...c, name: c.name.trim(), instructions: c.instructions.trim() })).filter((c) => c.name && c.instructions))
    close()
  }
  return (
    <Modal open onClose={close} title="Pre-push checks" size="md">
      <p className="text-sm text-muted-foreground">
        Rules in plain words, checked by the AI against the commits you push. A failing Block check stops the push (you can still push anyway); Warn only tells you.
      </p>
      {repo.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-hint">From .coderabbit.yaml (edit the file to change these)</div>
          {repo.map((c, i) => (
            <div key={i} className="mb-1 rounded border border-border/60 px-2 py-1 text-xs"><span className="font-semibold">{c.name}</span> · {c.mode === 'block' ? 'blocks' : 'warns'}<div className="text-muted-foreground">{c.instructions}</div></div>
          ))}
        </div>
      )}
      <div>
      <div className="mb-1 text-xs text-hint">Yours, for this repository</div>
      <div className="max-h-72 space-y-2 overflow-y-auto" data-testid="push-rules">
        {mine?.length === 0 && <p className="text-sm text-hint">None yet.</p>}
        {mine?.map((c, i) => (
          <div key={i} className="rounded-md border border-border p-2">
            <div className="mb-1 flex gap-2">
              <input value={c.name} onChange={(e) => edit(i, { name: e.target.value })} placeholder="Name (e.g. No debug logging)" aria-label="Check name"
                className="h-input min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary" />
              <OptionSelect value={c.mode} onChange={(v) => edit(i, { mode: v as PushCheck['mode'] })} aria-label="When it fails" className="px-2 data-[size=default]:h-input"
                options={[{ value: 'warn', label: 'Warn' }, { value: 'block', label: 'Block' }]} />
              <Button size="sm" variant="ghost" onClick={() => setMine((m) => m!.filter((_, n) => n !== i))}>Remove</Button>
            </div>
            <textarea value={c.instructions} onChange={(e) => edit(i, { instructions: e.target.value })} rows={2} aria-label="What to check"
              placeholder="What to check, in plain words (e.g. No console.log calls in src/; logging goes through logger.ts)"
              className="w-full resize-y rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary" />
          </div>
        ))}
      </div>
      </div>
      <ModalFooter>
        <Button onClick={() => setMine((m) => [...(m ?? []), { name: '', instructions: '', mode: 'warn' }])} data-testid="push-rule-add">Add check</Button>
        <span className="flex-1" />
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={!mine} onClick={() => void save()} data-testid="push-rules-save">Save</Button>
      </ModalFooter>
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
    <Modal open onClose={close} title="Git LFS locks" size="md">
      {error ? <p className="text-sm text-destructive">{error}</p>
        : locks === null ? <p className="text-sm text-hint">Asking the server…</p>
        : locks.length === 0 ? <p className="text-sm text-hint">No files are locked.</p>
        : (
          <div className="max-h-72 overflow-y-auto rounded-md border border-border" data-testid="lfs-locks">
            {locks.map((l) => (
              <div key={l.id} className="flex h-8 items-center gap-2 px-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{l.path}</span>
                <span className="text-xs text-muted-foreground">{l.owner}</span>
                <Button size="sm" variant="ghost" onClick={() => unlock(l)}>Unlock</Button>
              </div>
            ))}
          </div>
        )}
      <ModalFooter><Button autoFocus onClick={close}>Close</Button></ModalFooter>
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
        className="h-input w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary" />
      <div className="max-h-72 overflow-y-auto" role="listbox">
        {shown.map((i, n) => (
          <div key={i.value} role="option" aria-selected={n === at} onMouseEnter={() => setAt(n)} onClick={() => pick(i.value)} data-testid="pick-item"
            className={clsx('flex h-8 cursor-default items-center gap-2 rounded px-2 text-sm', n === at && 'bg-primary text-primary-foreground')}>
            <span className="truncate">{i.label}</span>
            {i.detail && <span className={clsx('truncate text-xs', n === at ? 'text-primary-foreground/80' : 'text-hint')}>{i.detail}</span>}
          </div>
        ))}
        {shown.length === 0 && <div className="px-2 py-2 text-xs text-hint">Nothing matches</div>}
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
        <ModalFooter>
          <Button type="button" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!value.trim()} data-testid="dialog-submit">{d.confirm}</Button>
        </ModalFooter>
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
    <Modal open onClose={close} title="Clone a repository" size="md">
      <form onSubmit={submit} className="space-y-3">
        <TextField autoFocus label="URL" placeholder="https://github.com/owner/repo.git" value={url} onChange={(e) => setUrl(e.target.value)} />
        <div className="flex items-end gap-2">
          <div className="flex-1"><TextField label="Into folder" value={dir} readOnly placeholder="Choose a parent folder" /></div>
          <Button type="button" onClick={async () => setDir((await api.pickDirectory()) ?? dir)}>Choose…</Button>
        </div>
        {progress && <div className="truncate font-mono text-xs text-muted-foreground">{progress}</div>}
        <ModalFooter>
          <Button type="button" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!url.trim() || !dir || !!progress}>Clone</Button>
        </ModalFooter>
      </form>
    </Modal>
  )
}

function ShortcutsDialog({ close }: { close: () => void }) {
  const mod = modName()
  return (
    <Modal open onClose={close} title="Keyboard shortcuts" size="md">
      <table className="w-full text-sm" data-testid="shortcuts">
        <tbody>
          {/* The live bindings, so rebinding in Settings → Keyboard shows up here too. */}
          {COMMANDS.map((c) => {
            const combos = [...keymap(setting('keybindings'))].filter(([, id]) => id === c.id).map(([k]) => formatCombo(k))
            return combos.length ? (
              <tr key={c.id} className="border-b border-border/50">
                <td className="py-1.5 pr-4 font-mono text-xs whitespace-nowrap text-muted-foreground">{combos.join('  or  ')}</td>
                <td className="py-1.5">{c.label}</td>
              </tr>
            ) : null
          })}
          {FIXED_KEYS.map((s) => (
            <tr key={s.what} className="border-b border-border/50 last:border-0">
              <td className="py-1.5 pr-4 font-mono text-xs whitespace-nowrap text-muted-foreground">{s.keys.replaceAll('mod', mod)}</td>
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
        <div className="flex items-start gap-2 text-sm text-muted-foreground"><KeyRound size={16} className="mt-0.5 shrink-0" />{prompt.message.trim()}</div>
        <TextField autoFocus type={prompt.secret ? 'password' : 'text'} value={value} onChange={(e) => setValue(e.target.value)} data-testid="prompt-input" />
        <ModalFooter>
          <Button type="button" onClick={() => answer(null)}>Cancel</Button>
          <Button type="submit" variant="primary">Continue</Button>
        </ModalFooter>
      </form>
    </Modal>
  )
}
