import { Tabs as RTabs } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export const Tabs = RTabs.Root

export function TabsList({ className, ...props }: ComponentProps<typeof RTabs.List>) {
  return <RTabs.List className={cn('flex items-center gap-0.5 border-b border-line', className)} {...props} />
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof RTabs.Trigger>) {
  return (
    <RTabs.Trigger
      className={cn('-mb-px h-7 border-b-2 border-transparent px-2.5 text-xs text-muted outline-none hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg', className)}
      {...props} />
  )
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RTabs.Content>) {
  return <RTabs.Content className={cn('outline-none', className)} {...props} />
}
