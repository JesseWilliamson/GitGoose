import { SECTIONS, SETTINGS, type Section, type SettingKey, type SettingSpec, type Settings } from '@gitgoose/shared'
import clsx from 'clsx'
import { RotateCcw, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { COMMANDS, comboOf, conflicts, formatCombo } from '../lib/keys'
import { saveSettings, useStore } from '../lib/store'
import { AiPanel } from './AiPanel'

/**
 * The settings page, generated from the SETTINGS table in packages/shared/src/settings.ts.
 * Each entry renders by its kind; sections can also add their own panels (AI agents)
 * through SECTION_PANELS.
 */
export const SECTION_PANELS: Partial<Record<Section, ComponentType>> = { AI: AiPanel }

type Visible = { key: SettingKey; spec: Exclude<SettingSpec, { kind: 'internal' }> }

function visibleSettings(): Visible[] {
  return (Object.entries(SETTINGS) as [SettingKey, SettingSpec][])
    .filter((e): e is [SettingKey, Visible['spec']] => e[1].kind !== 'internal')
    .map(([key, spec]) => ({ key, spec }))
}

export function SettingsPage() {
  const settings = useStore((s) => s.settings)
  // The omni search can open this page on a setting it found.
  const [query, setQuery] = useState(() => useStore.getState().settingsQuery)
  useEffect(() => () => useStore.setState({ settingsQuery: '' }), [])
  const [section, setSection] = useState<Section>('Appearance')
  const all = useMemo(visibleSettings, [])
  const q = query.trim().toLowerCase()
  const matches = (v: Visible) => !q || `${v.spec.label} ${v.spec.description ?? ''} ${v.spec.keywords ?? ''} ${v.spec.section}`.toLowerCase().includes(q)
  const shown = all.filter(matches)
  const sections = SECTIONS.filter((s) => shown.some((v) => v.spec.section === s) || (!q && SECTION_PANELS[s]))
  const scroller = useRef<HTMLDivElement>(null)

  const jump = (s: Section) => {
    setSection(s)
    scroller.current?.querySelector(`[data-section="${s}"]`)?.scrollIntoView({ block: 'start' })
  }

  if (!settings) return null
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="settings-page">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
        <h1 className="text-[15px] font-semibold">Settings</h1>
        <div className="flex h-8 w-80 items-center rounded-md border border-line bg-bg px-2 focus-within:border-accent">
          <Search size={13} className="text-faint" />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search settings"
            className="h-full flex-1 bg-transparent px-2 text-[13px] outline-none" data-testid="settings-search" />
        </div>
        <div className="flex-1" />
        <button onClick={() => useStore.setState({ page: null })} title="Close (Esc)" className="rounded p-1 text-muted hover:bg-hover hover:text-fg" data-testid="settings-close">
          <X size={16} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav className="w-48 shrink-0 border-r border-line bg-panel py-2">
          {sections.map((s) => (
            <button key={s} onClick={() => jump(s)}
              className={clsx('block w-full px-4 py-1.5 text-left text-[13px]', section === s ? 'bg-select text-fg' : 'text-muted hover:bg-hover hover:text-fg')}>
              {s}
            </button>
          ))}
        </nav>
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-8 py-4">
          <div className="mx-auto max-w-3xl">
            {sections.length === 0 && <p className="py-8 text-center text-sm text-faint">No settings match “{query}”.</p>}
            {sections.map((s) => {
              const Panel = SECTION_PANELS[s]
              return (
                <section key={s} data-section={s} className="mb-8 scroll-mt-4">
                  <h2 className="mb-2 border-b border-line pb-1 text-[12px] font-semibold tracking-wide text-muted uppercase">{s}</h2>
                  {Panel && !q && <Panel />}
                  {shown.filter((v) => v.spec.section === s).map((v) => (
                    <SettingRow key={v.key} k={v.key} spec={v.spec} value={settings[v.key]} />
                  ))}
                </section>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function SettingRow({ k, spec, value }: { k: SettingKey; spec: Visible['spec']; value: Settings[SettingKey] }) {
  const set = (v: unknown) => void saveSettings({ [k]: v } as Partial<Settings>)
  const modified = JSON.stringify(value) !== JSON.stringify(spec.default)
  if (spec.kind === 'keybindings') return <KeybindingsEditor value={value as Record<string, string>} onChange={set} />
  return (
    <div className="flex items-start gap-6 border-b border-line/40 py-3" data-testid={`setting-${k}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          {spec.label}
          {modified && (
            <button onClick={() => set(spec.default)} title="Reset to default" className="text-faint hover:text-accent" data-testid={`reset-${k}`}>
              <RotateCcw size={11} />
            </button>
          )}
        </div>
        {spec.description && <p className="mt-0.5 text-xs text-muted">{spec.description}</p>}
      </div>
      <div className="flex shrink-0 items-center">
        {spec.kind === 'boolean' && <Toggle checked={value as boolean} onChange={set} />}
        {spec.kind === 'number' && <NumberControl spec={spec} value={value as number} onChange={set} />}
        {spec.kind === 'choice' && <ChoiceControl spec={spec} value={value as string} onChange={set} />}
        {spec.kind === 'text' && <TextControl spec={spec} value={value as string} onChange={set} />}
      </div>
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className={clsx('relative h-5 w-9 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line')}>
      <span className={clsx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]', checked ? 'left-[18px]' : 'left-0.5')} />
    </button>
  )
}

function NumberControl({ spec, value, onChange }: { spec: Extract<SettingSpec, { kind: 'number' }>; value: number; onChange: (v: number) => void }) {
  // Sliders send many events while dragging; show the value live, save when released.
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])
  const label = spec.format === 'percent' ? `${Math.round(local * 100)}%` : `${local}${spec.unit ? ` ${spec.unit}` : ''}`
  return (
    <div className="flex items-center gap-3">
      <input type="range" min={spec.min} max={spec.max} step={spec.step} value={local}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={() => onChange(local)} onKeyUp={() => onChange(local)}
        className="w-40 accent-[var(--gs-accent)]" />
      <span className="w-20 text-right font-mono text-xs text-muted" data-testid="number-value">{label}</span>
    </div>
  )
}

function ChoiceControl({ spec, value, onChange }: { spec: Extract<SettingSpec, { kind: 'choice' }>; value: string; onChange: (v: string) => void }) {
  if (spec.options.length <= 3) {
    return (
      <div className="flex rounded-md border border-line p-0.5">
        {spec.options.map((o) => (
          <button key={o.value} onClick={() => onChange(o.value)}
            className={clsx('rounded px-2.5 py-1 text-xs', value === o.value ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg')}>
            {o.label}
          </button>
        ))}
      </div>
    )
  }
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-8 rounded-md border border-line bg-bg px-2 text-[13px]">
      {spec.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function TextControl({ spec, value, onChange }: { spec: Extract<SettingSpec, { kind: 'text' }>; value: string; onChange: (v: string) => void }) {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])
  const commit = () => { if (local !== value) onChange(local) }
  return (
    <input value={local} placeholder={spec.placeholder} onChange={(e) => setLocal(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
      className="h-8 w-72 rounded-md border border-line bg-bg px-2 font-mono text-xs outline-none focus:border-accent" />
  )
}

function KeybindingsEditor({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const [recording, setRecording] = useState<string | null>(null)
  const clash = conflicts(value)

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording(null)
      if (e.key === 'Backspace') {
        const next = { ...value }
        delete next[recording]
        onChange(next)
        return setRecording(null)
      }
      const combo = comboOf(e)
      if (!combo) return // wait for a modifier combination
      onChange({ ...value, [recording]: combo })
      setRecording(null)
    }
    // Capture phase, so the app's own shortcut handler does not run while recording.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, value, onChange])

  return (
    <div data-testid="setting-keybindings">
      <p className="mb-2 text-xs text-muted">{SETTINGS.keybindings.description}</p>
      <table className="w-full text-[13px]">
        <tbody>
          {COMMANDS.map((c) => {
            const combos = value[c.id] === undefined ? c.defaults : value[c.id] ? [value[c.id]!] : []
            const conflicted = combos.some((k) => (clash.get(k)?.length ?? 0) > 1)
            return (
              <tr key={c.id} className="border-b border-line/40">
                <td className="py-1.5">{c.label}</td>
                <td className="py-1.5 text-right">
                  <button onClick={() => setRecording(c.id)} data-testid={`keybinding-${c.id}`}
                    className={clsx('min-w-28 rounded border px-2 py-0.5 font-mono text-xs',
                      recording === c.id ? 'border-accent text-accent' : conflicted ? 'border-del text-del' : 'border-line text-muted hover:text-fg')}>
                    {recording === c.id ? 'Press keys…' : combos.length ? combos.map(formatCombo).join(', ') : 'none'}
                  </button>
                  {conflicted && <span className="ml-2 text-xs text-del">conflict</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
