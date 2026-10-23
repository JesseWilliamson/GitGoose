import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn('rounded border border-line bg-panel px-1 py-px font-mono text-[10px] text-muted', className)}>{children}</kbd>
}
