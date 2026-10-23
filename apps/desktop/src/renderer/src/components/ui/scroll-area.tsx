import { ScrollArea as RScrollArea } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export function ScrollArea({ className, children, ...props }: ComponentProps<typeof RScrollArea.Root>) {
  return (
    <RScrollArea.Root className={cn('relative overflow-hidden', className)} {...props}>
      <RScrollArea.Viewport className="size-full">{children}</RScrollArea.Viewport>
      <RScrollArea.Scrollbar orientation="vertical" className="flex w-2 touch-none p-px select-none">
        <RScrollArea.Thumb className="relative flex-1 rounded-full bg-line" />
      </RScrollArea.Scrollbar>
    </RScrollArea.Root>
  )
}
