import { countConflicts } from '@gitgoose/shared'
import clsx from 'clsx'
import { Copy, ShieldQuestion, Sparkles, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import { run } from '../lib/actions'
import { answerPermission, cancelAi, useAi } from '../lib/ai'
import { api, toUiError } from '../lib/api'
import { fileDiffRows } from '../lib/diffLayout'
import { acceptFix } from '../lib/review'
import { toast, useStore } from '../lib/store'
import { RecomposeDialog } from './RecomposeDialog'
import { Button, Modal, Spinner } from './ui'
import { ModelPicker } from './ModelPicker'
import { PromptButton } from './PromptPanel'

/** Every AI modal: consent, login, tool permission, streamed answers, conflict proposals. */
export function AiDialogs() {
  return (
    <>
      <ConsentDialog />
      <LoginDialog />
      <PermissionDialog />
      <OutputDialog />
      <ProposalDialog />
      <FixDialog />
      <RecomposeDialog />
    </>
  )
}

function ConsentDialog() {
  const c = useAi((s) => s.consent)
  if (!c) return null
  const answer = (ok: boolean) => {
    useAi.setState({ consent: null })
    c.resolve(ok)
  }
  return (
    <Modal open onClose={() => answer(false)} title={`Send to ${c.label}?`}>
      <div className="text-[13px]" data-testid="ai-consent">
        <p className="text-muted">
          To do this, GitGoose sends {c.what} to <b className="text-fg">{c.label}</b>.
          {c.label === 'Anthropic API' ? ' It goes to Anthropic with your API key.' : ' The agent runs on this computer with its own login, and may send it to its provider.'}
        </p>
        <p className="mt-2 text-xs text-faint">You are asked once for each agent or provider. Settings → AI turns AI features off.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => answer(false)}>Cancel</Button>
          <Button variant="primary" autoFocus onClick={() => answer(true)} data-testid="ai-consent-ok">Continue</Button>
        </div>
      </div>
    </Modal>
  )
}

function LoginDialog() {
  const l = useAi((s) => s.login)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!l) return null
  const done = (ok: boolean) => {
    useAi.setState({ login: null })
    setError(null)
    l.resolve(ok)
  }
  const viaAgent = async (methodId: string) => {
    setBusy(methodId)
    setError(null)
    try {
      await api.aiAuthenticate(methodId, l.target)
      done(true)
    } catch (e) {
      setError(toUiError(e).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <Modal open onClose={() => done(false)} title={`Log in to ${l.agent}`} width={500}>
      <div className="space-y-3 text-[13px]" data-testid="ai-login">
        <p className="text-muted">The agent needs you to log in. It keeps its own credentials; GitGoose never sees them.</p>
        {l.methods.map((m) => (
          <div key={m.id} className="rounded-md border border-line p-2.5">
            <div className="font-medium">{m.name}</div>
            {m.description && <div className="text-xs text-muted">{m.description}</div>}
            {m.terminalCommand ? (
              <>
                <pre className="selectable mt-2 overflow-x-auto rounded bg-bg p-2 font-mono text-[11px]">{m.terminalCommand}</pre>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => void navigator.clipboard.writeText(m.terminalCommand!)}><Copy size={12} /> Copy command</Button>
                  {l.repoId && <Button size="sm" onClick={() => void api.openTerminal(l.repoId!)}><SquareTerminal size={12} /> Open terminal</Button>}
                  <Button size="sm" variant="primary" onClick={() => done(true)}>I have logged in</Button>
                </div>
              </>
            ) : (
              <Button size="sm" variant="primary" className="mt-2" disabled={!!busy} onClick={() => void viaAgent(m.id)} data-testid={`ai-login-${m.id}`}>
                {busy === m.id ? <Spinner /> : null} Log in
              </Button>
            )}
          </div>
        ))}
        {error && <div className="text-xs text-del">{error}</div>}
        <div className="flex justify-end"><Button onClick={() => done(false)}>Cancel</Button></div>
      </div>
    </Modal>
  )
}

function PermissionDialog() {
  const p = useAi((s) => s.permissions[0])
  if (!p) return null
  const reject = p.options.find((o) => o.kind === 'reject_once') ?? p.options.find((o) => o.kind === 'reject_always')
  const deny = () => answerPermission(p.permissionId, reject?.optionId ?? null)
  const label = (kind: string, name: string) =>
    kind === 'allow_once' ? 'Allow once' : kind === 'allow_always' ? 'Allow for this session' : name
  return (
    <Modal open onClose={deny} title="The agent wants to use a tool" width={500}>
      <div className="text-[13px]" data-testid="ai-permission">
        <div className="flex items-start gap-2">
          <ShieldQuestion size={18} className="mt-0.5 shrink-0 text-warn" />
          <div className="min-w-0">
            <div className="font-medium">{p.title}</div>
            <div className="text-xs text-muted">Kind: {p.kind}</div>
            {p.paths.map((path) => <div key={path} className="selectable truncate font-mono text-xs text-muted" title={path}>{path}</div>)}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button onClick={deny} autoFocus data-testid="ai-permission-deny">Deny</Button>
          {p.options.filter((o) => o.kind.startsWith('allow')).map((o) => (
            <Button key={o.optionId} variant={o.kind === 'allow_once' ? 'primary' : 'default'} onClick={() => answerPermission(p.permissionId, o.optionId)}
              data-testid={`ai-permission-${o.kind}`}>
              {label(o.kind, o.name)}
            </Button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

function OutputDialog() {
  const o = useAi((s) => s.output)
  if (!o) return null
  const close = () => {
    if (o.requestId) cancelAi(o.requestId)
    useAi.setState({ output: null })
  }
  return (
    <Modal open onClose={close} title={o.title} width={560}>
      <div data-testid="ai-output">
        <div className="selectable max-h-[50vh] min-h-16 overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap" data-testid="ai-output-text">
          {o.text || (o.requestId ? <span className="flex items-center gap-2 text-muted"><Spinner /> Thinking…</span> : null)}
        </div>
        {o.error && <div className="mt-2 text-xs text-del" data-testid="ai-output-error">{o.error}</div>}
        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-[11px] text-faint"><Sparkles size={11} /> AI-written; check it before acting on it.</span>
          <div className="flex items-center gap-2">
            <ModelPicker area="error" />
            <PromptButton area="error" repoId={null} task={null} />
            {o.requestId && <Button onClick={() => cancelAi(o.requestId!)}>Stop</Button>}
            <Button variant="primary" onClick={close}>Close</Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** Fix with AI: the proposed file as a diff against the current one. Nothing is written until Use. */
function FixDialog() {
  const fix = useAi((s) => s.fix)
  if (!fix) return null
  const close = () => {
    if (fix.requestId) cancelAi(fix.requestId)
    useAi.setState({ fix: null })
  }
  const rows = fix.before !== null && fix.after !== null ? fileDiffRows(fix.before, fix.after) : []
  return (
    <Modal open onClose={close} title={`Fix: ${fix.title}`} width={760}>
      <div className="text-[13px]" data-testid="ai-fix">
        {fix.requestId && <p className="flex items-center gap-2 text-muted"><Spinner /> Asking for a fix to {fix.path}…</p>}
        {fix.error && <p className="text-del">{fix.error}</p>}
        {fix.note && <p className="mb-2 text-muted">{fix.note}</p>}
        {fix.after !== null && (
          <>
            {rows.length === 0 ? <p className="text-faint">The proposal is the same as the file: nothing to change.</p> : (
              <pre className="selectable max-h-[55vh] overflow-auto rounded border border-line bg-bg py-1 font-mono text-[12px]" data-testid="ai-fix-diff">
                {rows.map((r, i) => r.kind === 'skip'
                  ? <div key={i} className="px-2 text-faint">⋯ {r.count} unchanged line{r.count === 1 ? '' : 's'}</div>
                  : <div key={i} className={clsx('px-2', r.kind === '+' && 'bg-add-bg', r.kind === '-' && 'bg-del-bg')}>{r.kind} {r.text}</div>)}
              </pre>
            )}
            <p className="mt-2 text-xs text-faint">Nothing has been written. Use writes {fix.path}; it is refused if the file changes meanwhile.</p>
          </>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={close} data-testid="ai-fix-discard">{fix.after !== null ? 'Discard' : 'Cancel'}</Button>
          {fix.after !== null && <Button variant="primary" disabled={!rows.length} onClick={() => void acceptFix()} data-testid="ai-fix-accept">Use this fix</Button>}
        </div>
      </div>
    </Modal>
  )
}

function ProposalDialog() {
  const p = useAi((s) => s.proposal)
  const repoOpen = useStore((s) => (p ? !!s.repos[p.repoId] : false))
  if (!p) return null
  const markers = countConflicts(p.content)
  const close = () => useAi.setState({ proposal: null })
  const accept = async () => {
    close()
    const ok = await run(p.repoId, `Resolve ${p.path}`, () => api.resolveConflict(p.repoId, p.path, { content: p.content }), { quiet: true })
    if (ok) toast({ kind: 'success', title: `Resolved ${p.path} with the agent's version` })
  }
  return (
    <Modal open onClose={close} title={`Proposed resolution for ${p.path}`} width={720}>
      <div className="text-[13px]" data-testid="ai-proposal">
        {p.note && <p className="mb-2 text-muted">{p.note}</p>}
        <pre className="selectable max-h-[50vh] overflow-auto rounded border border-line bg-bg p-2 font-mono text-[12px]" data-testid="ai-proposal-content">{p.content}</pre>
        <p className="mt-2 text-xs text-faint">
          Nothing has been written yet. Use it to write this file and mark it resolved, or discard it and keep resolving by hand.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={close} data-testid="ai-proposal-discard">Discard</Button>
          <Button variant="primary" disabled={markers > 0 || !repoOpen} onClick={() => void accept()} data-testid="ai-proposal-accept"
            title={markers ? 'The proposal still has conflict markers' : undefined}>
            Use this resolution
          </Button>
        </div>
      </div>
    </Modal>
  )
}
