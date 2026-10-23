import { SECTIONS, SETTINGS, type Section, type SettingKey, type SettingSpec, type Settings } from '@gitgoose/shared'
import clsx from 'clsx'
import { RotateCcw, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { COMMANDS, comboOf, conflicts, formatCombo } from '../lib/keys'
import { saveSettings, useStore } from '../lib/store'
import { OptionSelect } from './OptionSelect'
import { AiPanel } from './AiPanel'
import { SettingsRow, SwitchSlot } from './SettingsRow'
import { Kbd, SectionHeader } from './ui'

/**
 * The settings page, generated from the SETTINGS table in packages/shared/src/settings.ts.
 * Each entry renders by its kind; sections can also add their own panels (AI agents)
 * through SECTION_PANELS, shown after the section's generated rows. Every row, generated or
 * not, is a SettingsRow: a label column and one 360 px control column.
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

  // The nav follows the page: the section that overlaps the top quarter of the scroll area is
  // the one in view. When two overlap it, the later one has just arrived and wins.
  const sectionKey = sections.join()
  useEffect(() => {
    const root = scroller.current
    if (!root) return
    const order = sectionKey ? (sectionKey.split(',') as Section[]) : []
    const inBand = new Set<Section>()
    let io: IntersectionObserver | null = null
    // rootMargin percentages are relative to the root's width (per the spec), so the bottom
    // margin is computed in pixels from the height; a resize rebuilds the observer.
    const observe = () => {
      io?.disconnect()
      inBand.clear()
      io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          const s = (e.target as HTMLElement).dataset.section as Section
          if (e.isIntersecting) inBand.add(s)
          else inBand.delete(s)
        }
        const current = [...order].reverse().find((s) => inBand.has(s))
        if (current) setSection(current)
      }, { root, rootMargin: `0px 0px -${Math.round(root.clientHeight * 0.75)}px 0px` })
      root.querySelectorAll('[data-section]').forEach((el) => io!.observe(el))
    }
    observe()
    let height = root.clientHeight
    const ro = new ResizeObserver(() => {
      if (root.clientHeight !== height) {
        height = root.clientHeight
        observe()
      }
    })
    ro.observe(root)
    return () => {
      ro.disconnect()
      io?.disconnect()
    }
  }, [sectionKey])

  if (!settings) return null
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="settings-page">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
        <h1 className="text-base font-semibold">Settings</h1>
        <div className="flex-1" />
        <button onClick={() => useStore.setState({ page: null })} title="Close (Esc)" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" data-testid="settings-close">
          <X size={16} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
          <div className="relative p-3">
            <Search size={13} className="pointer-events-none absolute top-1/2 left-5.5 -translate-y-1/2 text-hint" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search settings"
              className="h-input bg-background pl-7 text-sm md:text-sm dark:bg-background" data-testid="settings-search" />
          </div>
          {sections.map((s) => (
            <button key={s} onClick={() => jump(s)} data-testid={`settings-nav-${s}`} aria-current={section === s ? 'true' : undefined}
              className={clsx('block w-full px-4 py-1.5 text-left text-sm', section === s ? 'bg-select text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
              {s}
            </button>
          ))}
        </nav>
        {/* The bottom padding lets the last sections scroll up to the top, where the nav picks them. */}
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-8 pb-[50vh]" data-testid="settings-scroll">
          <div className="mx-auto max-w-[960px]">
            {sections.length === 0 && <p className="py-8 text-center text-sm text-hint">No settings match “{query}”.</p>}
            {sections.map((s) => {
              const Panel = SECTION_PANELS[s]
              return (
                <section key={s} data-section={s} className="mt-6 scroll-mt-6">
                  <SectionHeader as="h2" className="h-8 border-b border-border px-0">{s}</SectionHeader>
                  {shown.filter((v) => v.spec.section === s).map((v) => (
                    <SettingRow key={v.key} k={v.key} spec={v.spec} value={settings[v.key]} />
                  ))}
                  {Panel && !q && <Panel />}
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
    <SettingsRow testid={`setting-${k}`} label={spec.label} description={spec.description}
      labelExtra={modified && (
        <button onClick={() => set(spec.default)} title="Reset to default" className="text-hint hover:text-primary" data-testid={`reset-${k}`}>
          <RotateCcw size={11} />
        </button>
      )}>
      {spec.kind === 'boolean' && <SwitchSlot><Switch checked={value as boolean} onCheckedChange={set} aria-label={spec.label} /></SwitchSlot>}
      {spec.kind === 'number' && <NumberControl spec={spec} value={value as number} onChange={set} />}
      {spec.kind === 'choice' && <ChoiceControl spec={spec} value={value as string} onChange={set} />}
      {spec.kind === 'text' && <TextControl spec={spec} value={value as string} onChange={set} />}
    </SettingsRow>
  )
}

function NumberControl({ spec, value, onChange }: { spec: Extract<SettingSpec, { kind: 'number' }>; value: number; onChange: (v: number) => void }) {
  // Sliders send many events while dragging; show the value live, save when released.
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])
  const label = spec.format === 'percent' ? `${Math.round(local * 100)}%` : `${local}`
  return (
    <div className="flex w-full items-center gap-3">
      <input type="range" min={spec.min} max={spec.max} step={spec.step} value={local} aria-label={spec.label}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={() => onChange(local)} onKeyUp={() => onChange(local)}
        className="min-w-0 flex-1 accent-[var(--gs-accent)]" />
      {/* A fixed 72 px slot, value and unit on one line ("8192 tokens"). */}
      <span className="flex w-[72px] shrink-0 items-baseline justify-end gap-1 font-mono text-xs whitespace-nowrap text-foreground" data-testid="number-value">
        {label}
        {spec.unit && <span className="text-muted-foreground">{spec.unit}</span>}
      </span>
    </div>
  )
}

/** The longest option label that still fits one line in a three-way segmented control in the 360 px column. */
const SEGMENTED_MAX_LABEL = 16

function ChoiceControl({ spec, value, onChange }: { spec: Extract<SettingSpec, { kind: 'choice' }>; value: string; onChange: (v: string) => void }) {
  const segmented = spec.options.length <= 3 && spec.options.every((o) => o.label.length <= SEGMENTED_MAX_LABEL)
  if (segmented) {
    return (
      <Tabs value={value} onValueChange={onChange} className="w-full">
        <TabsList aria-label={spec.label} className="h-8 w-full rounded-md border border-border bg-background p-0.5 dark:bg-background">
          {spec.options.map((o) => (
            <TabsTrigger key={o.value} value={o.value}
              className="h-full rounded text-xs text-muted-foreground hover:text-foreground data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-primary dark:data-[state=active]:text-primary-foreground">
              {o.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    )
  }
  return <OptionSelect value={value} onChange={onChange} options={spec.options} aria-label={spec.label} className="w-full" />
}

function TextControl({ spec, value, onChange }: { spec: Extract<SettingSpec, { kind: 'text' }>; value: string; onChange: (v: string) => void }) {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])
  const commit = () => { if (local !== value) onChange(local) }
  return (
    <Input value={local} placeholder={spec.placeholder} aria-label={spec.label} onChange={(e) => setLocal(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
      className="h-8 bg-background font-mono text-xs md:text-xs dark:bg-background" />
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
      <p className="border-b border-border py-3 text-xs text-muted-foreground">{SETTINGS.keybindings.description}</p>
      {COMMANDS.map((c) => {
        const combos = value[c.id] === undefined ? c.defaults : value[c.id] ? [value[c.id]!] : []
        const conflicted = combos.some((k) => (clash.get(k)?.length ?? 0) > 1)
        return (
          <SettingsRow key={c.id} label={c.label} description={conflicted ? <span className="text-destructive">conflict</span> : undefined}>
            {/* The whole control column is the button, so every shortcut is edited the same way. */}
            <button onClick={() => setRecording(c.id)} data-testid={`keybinding-${c.id}`}
              className={clsx('flex h-8 w-full items-center justify-end gap-1 rounded-md border bg-background px-2 text-xs',
                recording === c.id ? 'border-primary text-primary' : conflicted ? 'border-destructive text-destructive' : 'border-border text-muted-foreground hover:text-foreground')}>
              {recording === c.id ? 'Press keys…' : combos.length ? combos.map((k) => <Kbd key={k}>{formatCombo(k)}</Kbd>) : 'none'}
            </button>
          </SettingsRow>
        )
      })}
    </div>
  )
}
