import { Popover as RPopover } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export const Popover = RPopover.Root
export const PopoverTrigger = RPopover.Trigger

export function PopoverContent({ className, align = 'start', sideOffset = 4, ...props }: ComponentProps<typeof RPopover.Content>) {
  return (
    <RPopover.Portal>
      <RPopover.Content align={align} sideOffset={sideOffset}
        className={cn('z-50 w-72 rounded-md border border-line bg-raised p-3 text-[13px] shadow-xl shadow-black/30 outline-none', className)} {...props} />
    </RPopover.Portal>
  )
}
