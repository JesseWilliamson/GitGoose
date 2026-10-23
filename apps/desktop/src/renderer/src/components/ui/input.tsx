import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn('h-8 w-full rounded-md border border-line bg-bg px-2 text-[13px] outline-none focus:border-accent disabled:opacity-50', className)} {...props} />
})
