import { ContextMenu as R } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { menuContent, menuItem, menuLabel, menuSeparator } from './menu-styles'
import { WithTooltip } from './tooltip'

export const ContextMenu = R.Root
export const ContextMenuTrigger = R.Trigger

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof R.Content>) {
  return (
    <R.Portal>
      <R.Content className={cn(menuContent, className)} {...props} />
    </R.Portal>
  )
}

/**
 * An item. With `reason` it is disabled and a tooltip (and aria-description) says why. Radix
 * only marks a disabled item (data-disabled), it does not swallow the pointer, so the tooltip
 * trigger still sees the hover.
 */
export function ContextMenuItem({ className, danger, reason, disabled, ...props }: ComponentProps<typeof R.Item> & { danger?: boolean; reason?: string }) {
  return (
    <WithTooltip text={reason} side="right" delay={150}>
      <R.Item disabled={disabled || !!reason} aria-description={reason}
        className={cn(menuItem, danger && 'text-del', reason && 'cursor-not-allowed', className)} {...props} />
    </WithTooltip>
  )
}

export function ContextMenuSeparator({ className, ...props }: ComponentProps<typeof R.Separator>) {
  return <R.Separator className={cn(menuSeparator, className)} {...props} />
}

export function ContextMenuLabel({ className, ...props }: ComponentProps<typeof R.Label>) {
  return <R.Label className={cn(menuLabel, className)} {...props} />
}

export function ContextMenuSub({ label, children }: { label: string; children: ReactNode }) {
  return (
    <R.Sub>
      <R.SubTrigger className={cn(menuItem, 'justify-between')}>{label}<span className="text-faint">›</span></R.SubTrigger>
      <R.Portal>
        <R.SubContent className={cn(menuContent, 'max-h-80 overflow-y-auto')}>{children}</R.SubContent>
      </R.Portal>
    </R.Sub>
  )
}
