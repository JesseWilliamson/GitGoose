import {
  DEFAULT_PROMPTS, effectivePrompt, promptKindsOf,
  type AiArea, type PromptKind, type PromptSource, type PromptText,
} from '@gitgoose/shared'
import clsx from 'clsx'
import { FileText, RotateCcw } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import { draftSaved, publishDraft } from '../lib/ai'
import { reportError, setSettingEntry, useStore } from '../lib/store'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SettingsRow } from './SettingsRow'
import { Button } from './ui'

/**
 * The prompt's editable words, where they are used. The "Prompt" button beside an area's model
 * picker opens them: the system prompt and instructions, remembered for this area. The parts the
 * user cannot change (the answer format GitGoose parses, the context built per request) are not
 * shown. Settings → AI edits the defaults with the same editor (PromptEditor).
 */
export function PromptButton({ area, className }: {
  area: AiArea
  className?: string
}) {
  const kinds = promptKindsOf(area)
  const [kind, setKind] = useState<PromptKind>(kinds[0]!)
  const [open, setOpen] = useState(false)
  const settings = useStore((s) => s.settings)
  if (!settings) return null
  const source = effectivePrompt(kind, settings).source
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className={clsx('inline-flex h-6 items-center gap-1 rounded-md border border-border px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground', className)}
          title="Show and edit the prompt" data-testid={`prompt-button-${area}`}>
          <FileText size={12} /> Prompt{source === 'area' ? ' (edited)' : ''}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={12}
          className="z-50 flex max-h-[min(75vh,var(--radix-popover-content-available-height))] w-[min(620px,92vw)] flex-col overflow-hidden rounded-lg border border-border bg-popover text-sm shadow-2xl shadow-black/40"
          data-testid={`prompt-panel-${area}`}
          // Keys typed here are the panel's (Recompose's Ctrl+Z must not step its plan).
          onKeyDown={(e) => e.stopPropagation()}>
          {kinds.length > 1 && (
            <div className="flex shrink-0 gap-1 border-b border-border px-3 pt-2">
              {kinds.map((k) => (
                <button key={k} onClick={() => setKind(k)}
                  className={clsx('rounded-t px-2 py-1 text-xs', k === kind ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground')}>{DEFAULT_PROMPTS[k].label}</button>
              ))}
            </div>
          )}
          {/* Keyed: switching prompt kinds starts that kind's draft fresh. */}
          <AreaPrompt key={kind} kind={kind} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** One kind's words as this area uses them, saved as the area's edit. */
function AreaPrompt({ kind }: { kind: PromptKind }) {
  const settings = useStore((s) => s.settings)!
  const used = effectivePrompt(kind, settings)
  const fallback = effectivePrompt(kind, settings, { area: false })
  const [draft, setDraft] = useState<PromptText>({ system: used.system, instructions: used.instructions })
  // Requests see a draft the moment it is typed (publishDraft); the settings catch up when the save lands.
  const save = useDebouncedSave((text: PromptText | null) => setPromptEdit(kind, text).then(() => draftSaved(kind, text)))

  const change = (next: PromptText) => {
    setDraft(next)
    // The same words as the default are no edit: nothing to remember, and Reset has nothing to do.
    const edit = sameWords(next, fallback) ? null : next
    publishDraft(kind, edit)
    save(edit)
  }
  const reset = () => {
    setDraft({ system: fallback.system, instructions: fallback.instructions })
    publishDraft(kind, null)
    save(null, true)
  }

  return (
    <div className="min-h-0 overflow-y-auto p-3">
      <PromptEditor kind={kind} value={draft} onChange={change}
        source={sameWords(draft, fallback) ? fallback.source : 'area'} onReset={used.source === 'area' || !sameWords(draft, fallback) ? reset : undefined}
        resetLabel={fallback.source === 'settings' ? 'Reset to Settings' : 'Reset to built-in'} />
    </div>
  )
}

function sameWords(a: PromptText, b: PromptText): boolean {
  return a.system === b.system && a.instructions === b.instructions
}

const SOURCE_LABEL: Record<PromptSource, string> = {
  area: 'Edited here: used by this area only',
  settings: 'From Settings → AI',
  'built-in': 'Built-in',
}

/**
 * The editable words of one prompt. Used by the area panel and by Settings → AI → Prompts.
 */
export function PromptEditor({ kind, value, onChange, source, onReset, resetLabel = 'Reset to built-in' }: {
  kind: PromptKind
  value: PromptText
  onChange: (v: PromptText) => void
  source: PromptSource
  onReset?: () => void
  resetLabel?: string
}) {
  const def = DEFAULT_PROMPTS[kind]
  const vars = Object.entries(def.vars)
  const area = 'w-full resize-y rounded-md border border-border bg-background px-2 py-1 font-mono text-xs leading-relaxed outline-none focus:border-primary'
  return (
    <div data-testid={`prompt-editor-${kind}`}>
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="flex-1 text-muted-foreground/70" data-testid="prompt-source">{SOURCE_LABEL[source]}</span>
        {onReset && <Button size="sm" variant="ghost" onClick={onReset} data-testid="prompt-reset"><RotateCcw size={11} /> {resetLabel}</Button>}
      </div>
      <label className="mb-1 block text-2xs font-semibold tracking-wide text-muted-foreground uppercase">System</label>
      <textarea value={value.system} onChange={(e) => onChange({ ...value, system: e.target.value })} rows={2} spellCheck={false}
        className={clsx(area, 'mb-3')} data-testid="prompt-system" />
      <label className="mb-1 block text-2xs font-semibold tracking-wide text-muted-foreground uppercase">Instructions</label>
      <textarea value={value.instructions} onChange={(e) => onChange({ ...value, instructions: e.target.value })} rows={Math.min(12, value.instructions.split('\n').length + 2)} spellCheck={false}
        className={area} data-testid="prompt-instructions" />
      {vars.length > 0 && (
        <p className="mt-1 text-2xs text-muted-foreground/70">
          Filled in when sent: {vars.map(([name, what], i) => <span key={name}>{i ? ', ' : ''}<code className="text-muted-foreground">{`{${name}}`}</code> ({what})</span>)}.
        </p>
      )}
    </div>
  )
}

/**
 * Save at most every 400 ms while typing, and for certain when the panel closes. A save that
 * fails is reported (a toast with the reason): the draft on screen is not saved, and the user
 * must hear that now rather than find the old words when the panel next opens.
 */
function useDebouncedSave<T>(save: (v: T) => void | Promise<void>): (v: T, now?: boolean) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<{ v: T } | null>(null)
  const fn = useRef(save)
  fn.current = save
  const run = (v: T) => Promise.resolve().then(() => fn.current(v)).catch((e) => reportError('Could not save the prompt', e))
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    if (pending.current) void run(pending.current.v)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (v, now = false) => {
    pending.current = { v }
    if (timer.current) clearTimeout(timer.current)
    const flush = () => {
      timer.current = null
      const p = pending.current
      pending.current = null
      if (p) void run(p.v)
    }
    if (now) flush()
    else timer.current = setTimeout(flush, 400)
  }
}

/** Remember (or with null, forget) an area's words for one prompt kind. */
export function setPromptEdit(kind: PromptKind, text: PromptText | null): Promise<void> {
  return setSettingEntry('aiPromptEdits', kind, text)
}

/** Settings → AI → Prompts: the defaults every area starts from. */
export function PromptSettings() {
  const settings = useStore((s) => s.settings)
  const [kind, setKind] = useState<PromptKind>('commit-message')
  if (!settings) return null
  const kinds = Object.keys(DEFAULT_PROMPTS) as PromptKind[]
  const edited = (k: PromptKind) => !!settings.aiPrompts[k]
  const areaEdited = (k: PromptKind) => !!settings.aiPromptEdits[k]
  return (
    <div data-testid="prompt-settings">
      <SettingsRow label="Prompts" last={false}
        description="The default words for each AI request. An area's Prompt button can change them for that area; the answer format is fixed." />
      <Tabs value={kind} onValueChange={(v) => setKind(v as PromptKind)} orientation="vertical" className="flex-row gap-6 border-b border-border pt-1 pb-3">
        <TabsList className="w-44 shrink-0 items-stretch gap-0.5 self-start bg-transparent p-0">
          {kinds.map((k) => (
            <TabsTrigger key={k} value={k} data-testid={`prompt-kind-${k}`}
              className="h-7 flex-none justify-start truncate rounded px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground data-[state=active]:bg-select data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-select dark:data-[state=active]:text-foreground">
              {DEFAULT_PROMPTS[k].label}{edited(k) ? ' •' : ''}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="min-w-0 flex-1">
          <SettingsPrompt key={kind} kind={kind} />
          {areaEdited(kind) && (
            <p className="mt-2 flex items-center gap-2 text-2xs text-warn">
              Its area has its own edit, which it uses instead of this.
              <Button size="sm" variant="ghost" onClick={() => void setPromptEdit(kind, null)}>Drop that edit</Button>
            </p>
          )}
        </div>
      </Tabs>
    </div>
  )
}

function SettingsPrompt({ kind }: { kind: PromptKind }) {
  const settings = useStore((s) => s.settings)!
  const def = DEFAULT_PROMPTS[kind]
  const stored = settings.aiPrompts[kind]
  const [draft, setDraft] = useState<PromptText>(stored ?? { system: def.system, instructions: def.instructions })
  const save = useDebouncedSave((text: PromptText | null) => setSettingEntry('aiPrompts', kind, text))
  const same = (t: PromptText) => t.system === def.system && t.instructions === def.instructions
  return (
    <PromptEditor kind={kind} value={draft} source={same(draft) ? 'built-in' : 'settings'}
      onChange={(next) => {
        setDraft(next)
        save(same(next) ? null : next)
      }}
      onReset={same(draft) ? undefined : () => {
        setDraft({ system: def.system, instructions: def.instructions })
        save(null, true)
      }} />
  )
}
