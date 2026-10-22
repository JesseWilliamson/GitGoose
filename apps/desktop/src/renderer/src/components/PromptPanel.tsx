import {
  DEFAULT_PROMPTS, effectivePrompt, promptKindsOf,
  type AiArea, type AiTask, type PromptKind, type PromptPreview, type PromptSource, type PromptText,
} from '@gitgoose/shared'
import clsx from 'clsx'
import { ChevronRight, FileText, Lock, RotateCcw } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import { api, toUiError } from '../lib/api'
import { reportError, setSettingEntry, useStore } from '../lib/store'
import { Button, Spinner } from './ui'

/**
 * The prompt, shown and editable where it is used. The "Prompt" button beside an area's model
 * picker opens it: the system prompt and instructions (editable, remembered for this area), the
 * answer format (fixed: GitGoose parses the answer with it) and the context, built by main from
 * the repository exactly as a real request would (aiPromptPreview), so what you read is what
 * goes. Settings → AI edits the defaults with the same editor (PromptEditor).
 */
export function PromptButton({ area, repoId, task, className }: {
  area: AiArea
  repoId: string | null
  /** The request this area would make now; null: show the words only (the context is built when sent). */
  task: AiTask | null
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
        <button className={clsx('inline-flex h-6 items-center gap-1 rounded-md border border-line px-1.5 text-xs text-muted hover:bg-hover hover:text-fg', className)}
          title="Show and edit the prompt" data-testid={`prompt-button-${area}`}>
          <FileText size={12} /> Prompt{source === 'area' ? ' (edited)' : ''}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={12}
          className="z-50 flex max-h-[min(75vh,var(--radix-popover-content-available-height))] w-[min(620px,92vw)] flex-col overflow-hidden rounded-lg border border-line bg-raised text-[13px] shadow-2xl shadow-black/40"
          data-testid={`prompt-panel-${area}`}
          // Keys typed here are the panel's (Recompose's Ctrl+Z must not step its plan).
          onKeyDown={(e) => e.stopPropagation()}>
          {kinds.length > 1 && (
            <div className="flex shrink-0 gap-1 border-b border-line px-3 pt-2">
              {kinds.map((k) => (
                <button key={k} onClick={() => setKind(k)}
                  className={clsx('rounded-t px-2 py-1 text-xs', k === kind ? 'bg-bg text-fg' : 'text-muted hover:text-fg')}>{DEFAULT_PROMPTS[k].label}</button>
              ))}
            </div>
          )}
          {/* Keyed: switching prompt kinds starts that kind's draft fresh. */}
          <AreaPrompt key={kind} kind={kind} repoId={repoId} task={task?.kind === kind ? task : null} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** One kind's words as this area uses them, saved as the area's edit; plus the live preview. */
function AreaPrompt({ kind, repoId, task }: { kind: PromptKind; repoId: string | null; task: AiTask | null }) {
  const settings = useStore((s) => s.settings)!
  const used = effectivePrompt(kind, settings)
  const fallback = effectivePrompt(kind, settings, { area: false })
  const [draft, setDraft] = useState<PromptText>({ system: used.system, instructions: used.instructions })
  const save = useDebouncedSave((text: PromptText | null) => setPromptEdit(kind, text))

  const change = (next: PromptText) => {
    setDraft(next)
    // The same words as the default are no edit: nothing to remember, and Reset has nothing to do.
    save(sameWords(next, fallback) ? null : next)
  }
  const reset = () => {
    setDraft({ system: fallback.system, instructions: fallback.instructions })
    save(null, true)
  }

  // A blank part is no edit: the next request uses Settings' (or the built-in) words for it
  // (effectivePrompt), so the preview must too; main alone would fall back to the built-in words.
  const sent: PromptText = {
    system: draft.system.trim() ? draft.system : fallback.system,
    instructions: draft.instructions.trim() ? draft.instructions : fallback.instructions,
  }
  const preview = usePreview(repoId, task, sent)
  return (
    <div className="min-h-0 overflow-y-auto p-3">
      <PromptEditor kind={kind} value={draft} onChange={change} rendered={preview.parts?.instructions}
        source={sameWords(draft, fallback) ? fallback.source : 'area'} onReset={used.source === 'area' || !sameWords(draft, fallback) ? reset : undefined}
        resetLabel={fallback.source === 'settings' ? 'Reset to Settings' : 'Reset to built-in'} />
      <Context preview={preview} task={task} />
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
 * The editable words of one prompt and its fixed answer format. Used by the area panel and by
 * Settings → AI → Prompts.
 */
export function PromptEditor({ kind, value, onChange, source, onReset, resetLabel = 'Reset to built-in', rendered }: {
  kind: PromptKind
  value: PromptText
  onChange: (v: PromptText) => void
  source: PromptSource
  onReset?: () => void
  resetLabel?: string
  /** The instructions with their {names} filled in, when they differ from the template. */
  rendered?: string
}) {
  const def = DEFAULT_PROMPTS[kind]
  const vars = Object.entries(def.vars)
  const area = 'w-full resize-y rounded-md border border-line bg-bg px-2 py-1 font-mono text-[12px] leading-relaxed outline-none focus:border-accent'
  return (
    <div data-testid={`prompt-editor-${kind}`}>
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="flex-1 text-faint" data-testid="prompt-source">{SOURCE_LABEL[source]}</span>
        {onReset && <Button size="sm" variant="ghost" onClick={onReset} data-testid="prompt-reset"><RotateCcw size={11} /> {resetLabel}</Button>}
      </div>
      <label className="mb-1 block text-[11px] font-semibold tracking-wide text-muted uppercase">System</label>
      <textarea value={value.system} onChange={(e) => onChange({ ...value, system: e.target.value })} rows={2} spellCheck={false}
        className={clsx(area, 'mb-3')} data-testid="prompt-system" />
      <label className="mb-1 block text-[11px] font-semibold tracking-wide text-muted uppercase">Instructions</label>
      <textarea value={value.instructions} onChange={(e) => onChange({ ...value, instructions: e.target.value })} rows={Math.min(12, value.instructions.split('\n').length + 2)} spellCheck={false}
        className={area} data-testid="prompt-instructions" />
      {vars.length > 0 && (
        <p className="mt-1 text-[11px] text-faint">
          Filled in when sent: {vars.map(([name, what], i) => <span key={name}>{i ? ', ' : ''}<code className="text-muted">{`{${name}}`}</code> ({what})</span>)}.
        </p>
      )}
      {rendered && rendered !== value.instructions && (
        <details className="mt-1 text-[11px] text-faint">
          <summary className="cursor-default">As it will be sent</summary>
          <pre className="selectable mt-1 rounded border border-line bg-bg p-2 font-mono whitespace-pre-wrap" data-testid="prompt-rendered">{rendered}</pre>
        </details>
      )}
      {def.format && (
        <>
          <label className="mt-3 mb-1 flex items-center gap-1 text-[11px] font-semibold tracking-wide text-muted uppercase"
            title="GitGoose reads the answer in this shape, so it cannot be changed">
            <Lock size={10} /> Answer format <span className="font-normal normal-case">(fixed: GitGoose reads the answer with it)</span>
          </label>
          <pre className="selectable rounded-md border border-line/60 bg-bg/60 p-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-muted" data-testid="prompt-format">{def.format}</pre>
        </>
      )}
    </div>
  )
}

/** The context the request carries, built by main now (read-only). */
function Context({ preview, task }: { preview: Preview; task: AiTask | null }) {
  const [open, setOpen] = useState(false)
  if (!task) {
    return <p className="mt-3 text-[11px] text-faint">The context (the change, the commit, …) is built when the request is sent; in a conversation, each message's "Sent" shows exactly what went out.</p>
  }
  const ctx = preview.parts?.context ?? ''
  return (
    <div className="mt-3" data-testid="prompt-context">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1 text-[11px] font-semibold tracking-wide text-muted uppercase hover:text-fg">
        <ChevronRight size={12} className={clsx('transition-transform', open && 'rotate-90')} /> Context
        <span className="font-normal normal-case">
          {preview.loading ? ' (building…)' : preview.error ? '' : ` (${ctx.split('\n').length.toLocaleString()} lines, ${ctx.length.toLocaleString()} characters)`}
        </span>
        {preview.loading && <Spinner className="ml-1" />}
      </button>
      {preview.error && <p className="mt-1 text-xs text-del" data-testid="prompt-context-error">{preview.error}</p>}
      {preview.parts?.note && <p className="mt-1 text-[11px] text-faint">{preview.parts.note}</p>}
      {open && ctx && <pre className="selectable mt-1 max-h-80 overflow-auto rounded-md border border-line/60 bg-bg/60 p-2 font-mono text-[11px] whitespace-pre" data-testid="prompt-context-text">{ctx}</pre>}
    </div>
  )
}

interface Preview { parts: PromptPreview | null; loading: boolean; error: string | null }

/** Main's preview of `task` with these words, rebuilt (debounced) when either changes. */
function usePreview(repoId: string | null, task: AiTask | null, words: PromptText): Preview {
  const [state, setState] = useState<Preview>({ parts: null, loading: false, error: null })
  const key = JSON.stringify([repoId, task, words])
  useEffect(() => {
    if (!task) return setState({ parts: null, loading: false, error: null })
    let live = true
    setState((s) => ({ ...s, loading: true }))
    const t = setTimeout(() => {
      api.aiPromptPreview(repoId ?? '', task, words).then(
        (parts) => live && setState({ parts, loading: false, error: null }),
        (e) => live && setState({ parts: null, loading: false, error: toUiError(e).message }),
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state
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
    <div className="mt-3 border-t border-line pt-3" data-testid="prompt-settings">
      <div className="mb-2">
        Prompts
        <span className="block text-xs text-faint">The default words for each AI request. An area's Prompt button can change them for that area; the answer format is fixed.</span>
      </div>
      <div className="flex gap-3">
        <div className="w-44 shrink-0">
          {kinds.map((k) => (
            <button key={k} onClick={() => setKind(k)} data-testid={`prompt-kind-${k}`}
              className={clsx('block w-full truncate rounded px-2 py-1 text-left text-xs', k === kind ? 'bg-select text-fg' : 'text-muted hover:bg-hover hover:text-fg')}>
              {DEFAULT_PROMPTS[k].label}{edited(k) ? ' •' : ''}
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <SettingsPrompt key={kind} kind={kind} />
          {areaEdited(kind) && (
            <p className="mt-2 flex items-center gap-2 text-[11px] text-warn">
              Its area has its own edit, which it uses instead of this.
              <Button size="sm" variant="ghost" onClick={() => void setPromptEdit(kind, null)}>Drop that edit</Button>
            </p>
          )}
        </div>
      </div>
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
