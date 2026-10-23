import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        default: 'bg-raised border border-line text-fg hover:bg-hover',
        primary: 'bg-accent text-accent-fg hover:brightness-110',
        danger: 'bg-del text-white hover:brightness-110',
        ghost: 'text-muted hover:bg-hover hover:text-fg',
      },
      size: {
        sm: 'h-6 px-2 text-xs',
        md: 'h-8 px-3 text-[13px]',
        icon: 'size-8 shrink-0 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
)

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant, size, className, ...props }, ref) {
  return <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
})
