import { useState } from 'react'
import { toast as sonner } from 'sonner'
import { Button } from '../components/ui/button'
import type { Toast, ToastPresenter } from './toast-types'

/**
 * The presenter the store's `toast()` hands toasts to. Sonner owns the timing, stacking,
 * pause-on-hover and the live region; the toast's body is ours, so it keeps the look, the
 * expandable git output and the `toast-action` button users and tests know.
 */
export const sonnerPresenter: ToastPresenter = {
  show(id, t, ms) {
    sonner.custom((sid) => <ToastBody toast={t} onDismiss={() => sonner.dismiss(sid)} />, {
      id,
      duration: ms > 0 ? ms : Infinity,
    })
  },
  dismiss: (id) => void sonner.dismiss(id),
}

function ToastBody({ toast: t, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div role="status" data-kind={t.kind} className="w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-raised p-3 text-[13px] text-fg shadow-xl shadow-black/30">
      <div className="flex items-start gap-2">
        <span className={`mt-1 size-2 shrink-0 rounded-full ${t.kind === 'success' ? 'bg-add' : 'bg-accent'}`} />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{t.title}</div>
          {t.detail && (
            <pre onClick={() => setExpanded(!expanded)}
              className={`selectable mt-1 cursor-pointer font-mono text-[11px] whitespace-pre-wrap text-muted ${expanded ? 'max-h-64 overflow-auto' : 'line-clamp-3'}`}>{t.detail}</pre>
          )}
        </div>
        {t.action && (
          <Button size="sm" onClick={() => { onDismiss(); t.action!.run() }} data-testid="toast-action">{t.action.label}</Button>
        )}
        <button onClick={onDismiss} className="text-faint hover:text-fg" title="Dismiss" aria-label="Dismiss">✕</button>
      </div>
    </div>
  )
}
