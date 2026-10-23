import { describe, expect, it } from 'vitest'
import { dismissToast, setToastPresenter, toast } from './toastBus'

describe('toast', () => {
  it('hands the toast to whatever draws toasts, with a fresh id and the duration', () => {
    const shown: unknown[] = []
    const dismissed: number[] = []
    setToastPresenter({ show: (id, t, ms) => shown.push([id, t.title, ms]), dismiss: (id) => dismissed.push(id) })
    const a = toast({ kind: 'info', title: 'One' })
    const b = toast({ kind: 'success', title: 'Two' }, 0)
    expect(b).not.toBe(a)
    expect(shown).toEqual([[a, 'One', 5000], [b, 'Two', 0]])
    dismissToast(a)
    expect(dismissed).toEqual([a])
  })
})
