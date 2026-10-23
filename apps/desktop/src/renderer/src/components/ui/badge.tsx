import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

const badgeVariants = cva('inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium', {
  variants: {
    variant: {
      default: 'bg-hover text-muted',
      accent: 'bg-accent text-accent-fg',
      add: 'bg-add-bg text-add',
      del: 'bg-del-bg text-del',
    },
  },
  defaultVariants: { variant: 'default' },
})

export function Badge({ className, variant, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
