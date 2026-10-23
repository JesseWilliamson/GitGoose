import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn('min-h-16 w-full resize-y rounded-md border border-line bg-bg p-2 text-[13px] outline-none focus:border-accent disabled:opacity-50', className)} {...props} />
})
