import { Dialog } from 'radix-ui'
import type { ReactNode } from 'react'

/** A bare Radix dialog positioned near the top, for the command palette. */
export function RDialogCompat({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed top-[12%] left-1/2 z-50 w-[560px] max-w-[92vw] -translate-x-1/2" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
