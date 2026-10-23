import { Toggle as RToggle } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export function Toggle({ className, ...props }: ComponentProps<typeof RToggle.Root>) {
  return (
    <RToggle.Root
      className={cn('inline-flex h-6 items-center justify-center gap-1 rounded-md px-2 text-xs text-muted outline-none hover:bg-hover hover:text-fg data-[state=on]:bg-hover data-[state=on]:text-fg disabled:opacity-40', className)}
      {...props} />
  )
}
