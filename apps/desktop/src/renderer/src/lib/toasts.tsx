import { useState } from 'react'
import { toast as sonner } from 'sonner'
import { Button } from '../components/ui'
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
    <div role="status" data-kind={t.kind} className="w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-3 text-sm text-foreground shadow-xl shadow-black/30">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{t.title}</div>
          {t.detail && (
            <pre onClick={() => setExpanded(!expanded)}
              className={`selectable mt-1 cursor-pointer font-mono text-2xs whitespace-pre-wrap text-muted-foreground ${expanded ? 'max-h-64 overflow-auto' : 'line-clamp-3'}`}>{t.detail}</pre>
          )}
        </div>
        {t.action && (
          <Button size="sm" onClick={() => { onDismiss(); t.action!.run() }} data-testid="toast-action">{t.action.label}</Button>
        )}
        <button onClick={onDismiss} className="text-hint hover:text-foreground" title="Dismiss" aria-label="Dismiss">✕</button>
      </div>
    </div>
  )
}
