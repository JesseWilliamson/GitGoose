import { Tooltip as RTooltip } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../lib/cn'

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <RTooltip.Provider delayDuration={400} skipDelayDuration={200}>{children}</RTooltip.Provider>
)
export const Tooltip = RTooltip.Root
export const TooltipTrigger = RTooltip.Trigger

export function TooltipContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof RTooltip.Content>) {
  return (
    <RTooltip.Portal>
      <RTooltip.Content sideOffset={sideOffset}
        className={cn('z-[60] max-w-72 rounded-md border border-line bg-raised px-2 py-1 text-xs text-fg shadow-lg shadow-black/30', className)} {...props} />
    </RTooltip.Portal>
  )
}

/** A tooltip around one element: `<WithTooltip text="Push"><button/></WithTooltip>`. No text, no tooltip. */
export function WithTooltip({ text, children, side, delay }: { text?: string; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; delay?: number }) {
  if (!text) return <>{children}</>
  return (
    <Tooltip delayDuration={delay}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{text}</TooltipContent>
    </Tooltip>
  )
}
