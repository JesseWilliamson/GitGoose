import type { Toast, ToastPresenter } from './toast-types'

let presenter: ToastPresenter | null = null
let nextToast = 1

/** The app registers what draws toasts (App.tsx: sonner); until then, and in tests, they are dropped. */
export function setToastPresenter(p: ToastPresenter): void {
  presenter = p
}

/** Show a toast for `ms` milliseconds (0: until dismissed). */
export function toast(t: Toast, ms = 5000): number {
  const id = nextToast++
  presenter?.show(id, t, ms)
  return id
}

export function dismissToast(id: number): void {
  presenter?.dismiss(id)
}
