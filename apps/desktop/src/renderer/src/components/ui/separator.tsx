import { Separator as RSeparator } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export function Separator({ className, orientation = 'horizontal', ...props }: ComponentProps<typeof RSeparator.Root>) {
  return (
    <RSeparator.Root decorative orientation={orientation} {...props}
      className={cn('shrink-0 bg-line', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)} />
  )
}
