import { Switch as RSwitch } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export function Switch({ className, ...props }: ComponentProps<typeof RSwitch.Root>) {
  return (
    <RSwitch.Root {...props}
      className={cn('inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-line bg-hover transition-colors outline-none data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:opacity-40', className)}>
      <RSwitch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-fg transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-accent-fg" />
    </RSwitch.Root>
  )
}
