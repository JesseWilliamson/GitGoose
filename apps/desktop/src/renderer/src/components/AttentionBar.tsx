import { AlertTriangle, ChevronDown, ChevronRight, Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import { explainFailure, useAiEnabled } from '../lib/ai'
import { dismissAttention, useStore, type Attention } from '../lib/store'
import { Button } from './ui'

/**
 * Failures, right under the tab bar where they cannot be missed. Unlike toasts they never
 * auto-dismiss, and each failure gets its own row, so a second one does not hide the first.
 */
export function AttentionBar() {
  const items = useStore((s) => s.attentions)
  if (!items.length) return null
  return (
    <div className="shrink-0 border-b border-destructive/40" data-testid="attention" role="alert">
      {items.map((a) => <Row key={a.id} a={a} />)}
    </div>
  )
}

function Row({ a }: { a: Attention }) {
  const [open, setOpen] = useState(false)
  const aiOn = useAiEnabled()
  const repoId = useStore((s) => s.active)
  return (
    <div className="border-b border-destructive/20 bg-destructive/12 px-3 py-1.5 text-sm last:border-b-0" data-testid="attention-row">
      <div className="flex items-center gap-2">
        <AlertTriangle size={15} className="shrink-0 text-destructive" />
        <span className="min-w-0 flex-1 truncate font-medium">{a.title}</span>
        {a.detail && (
          <button onClick={() => setOpen(!open)} className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground" data-testid="attention-details">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Details
          </button>
        )}
        {aiOn && a.detail && (
          <button onClick={() => explainFailure(repoId, a.title, a.detail!)}
            className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground" data-testid="attention-explain" title="Explain this with AI">
            <Sparkles size={12} /> Explain
          </button>
        )}
        {a.actions?.map((c) => (
          <Button key={c.label} size="sm" variant={c.variant === 'danger' ? 'danger' : c.variant === 'primary' ? 'primary' : 'default'}
            onClick={() => { dismissAttention(a.id); void c.run?.() }}>{c.label}</Button>
        ))}
        <button onClick={() => dismissAttention(a.id)} title="Dismiss" className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" data-testid="attention-dismiss">
          <X size={14} />
        </button>
      </div>
      {open && a.detail && (
        <pre className="selectable mt-1.5 mb-0.5 max-h-48 overflow-auto rounded bg-background/60 p-2 font-mono text-2xs whitespace-pre-wrap text-muted-foreground">{a.detail}</pre>
      )}
    </div>
  )
}
