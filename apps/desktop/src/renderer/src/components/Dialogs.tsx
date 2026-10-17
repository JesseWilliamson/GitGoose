import { KeyRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cloneRepo } from '../lib/actions'
import { modName, SHORTCUT_HELP } from '../lib/keys'
import { api } from '../lib/api'
import { dismissToast, saveSettings, useStore } from '../lib/store'
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
  if (dialog.kind === 'settings') return <SettingsDialog close={close} />
  if (dialog.kind === 'shortcuts') return <ShortcutsDialog close={close} />
  return <CloneDialog close={close} />
}

function InputDialog({ d, close }: { d: Extract<NonNullable<ReturnType<typeof useStore.getState>['dialog']>, { kind: 'input' }>; close: () => void }) {
  const [value, setValue] = useState(d.initial ?? '')
  const [extra, setExtra] = useState('')
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

function SettingsDialog({ close }: { close: () => void }) {
  const settings = useStore((s) => s.settings)
  const [gitPath, setGitPath] = useState(settings?.gitPath ?? 'git')
  if (!settings) return null
  return (
    <Modal open onClose={close} title="Settings">
      <div className="space-y-4 text-[13px]">
        <div>
          <span className="mb-1 block text-xs text-muted">Theme</span>
          <div className="flex gap-1">
            {(['system', 'dark', 'light'] as const).map((t) => (
              <Button key={t} size="sm" variant={settings.theme === t ? 'primary' : 'default'} onClick={() => void saveSettings({ theme: t })} className="capitalize">{t}</Button>
            ))}
          </div>
        </div>
        <div>
          <span className="mb-1 block text-xs text-muted">Font size: {settings.fontSize}px</span>
          <input type="range" min={11} max={16} value={settings.fontSize} onChange={(e) => void saveSettings({ fontSize: Number(e.target.value) })} className="w-full" />
        </div>
        <div className="flex items-end gap-2">
          <div className="flex-1"><TextField label="Git executable" value={gitPath} onChange={(e) => setGitPath(e.target.value)} placeholder="git" /></div>
          <Button onClick={() => void saveSettings({ gitPath: gitPath.trim() || 'git' })} disabled={gitPath === settings.gitPath}>Save</Button>
        </div>
        <p className="text-xs text-faint">A new git path applies to repositories opened after saving.</p>
        <div className="flex justify-end"><Button variant="primary" onClick={close}>Done</Button></div>
      </div>
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
          {SHORTCUT_HELP.map((s) => (
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
    <div className="pointer-events-none fixed right-4 bottom-8 z-50 flex w-96 flex-col gap-2" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} role="status" data-kind={t.kind}
          className={`pointer-events-auto rounded-lg border bg-raised p-3 text-[13px] shadow-xl shadow-black/30 ${t.kind === 'error' ? 'border-del/60' : 'border-line'}`}>
          <div className="flex items-start gap-2">
            <span className={`mt-1 size-2 shrink-0 rounded-full ${t.kind === 'error' ? 'bg-del' : t.kind === 'success' ? 'bg-add' : 'bg-accent'}`} />
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
