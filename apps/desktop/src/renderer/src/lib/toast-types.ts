/** Toasts are for outcomes that need nothing from the user: successes and notes. */
export interface Toast {
  kind: 'info' | 'success'
  title: string
  detail?: string
  action?: { label: string; run: () => void }
}

/** Whatever draws toasts (the app mounts sonner); the store only knows this shape, so tests need no DOM. */
export interface ToastPresenter {
  show(id: number, toast: Toast, ms: number): void
  dismiss(id: number): void
}
