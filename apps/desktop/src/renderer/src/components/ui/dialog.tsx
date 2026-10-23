import { Dialog as RDialog } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export const Dialog = RDialog.Root
export const DialogTrigger = RDialog.Trigger
export const DialogDescription = RDialog.Description

export function DialogContent({ className, children, ...props }: ComponentProps<typeof RDialog.Content>) {
  return (
    <RDialog.Portal>
      <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
      <RDialog.Content
        className={cn('fixed left-1/2 z-50 max-w-[94vw] -translate-x-1/2 rounded-lg border border-line bg-raised p-4 shadow-2xl shadow-black/40', className)} {...props}>
        {children}
      </RDialog.Content>
    </RDialog.Portal>
  )
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof RDialog.Title>) {
  return <RDialog.Title className={cn('mb-3 text-[15px] font-semibold', className)} {...props} />
}
