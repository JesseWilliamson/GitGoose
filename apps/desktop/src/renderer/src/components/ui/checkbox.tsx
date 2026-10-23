import { Check } from 'lucide-react'
import { Checkbox as RCheckbox } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export function Checkbox({ className, ...props }: ComponentProps<typeof RCheckbox.Root>) {
  return (
    <RCheckbox.Root {...props}
      className={cn('flex size-4 shrink-0 items-center justify-center rounded border border-line bg-bg outline-none data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-fg disabled:opacity-40', className)}>
      <RCheckbox.Indicator><Check size={12} strokeWidth={3} /></RCheckbox.Indicator>
    </RCheckbox.Root>
  )
}
