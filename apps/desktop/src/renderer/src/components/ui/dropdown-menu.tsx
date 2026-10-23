import { DropdownMenu as R } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { menuContent, menuItem, menuLabel, menuSeparator } from './menu-styles'
import { WithTooltip } from './tooltip'

export const DropdownMenu = R.Root
export const DropdownMenuTrigger = R.Trigger

export function DropdownMenuContent({ className, align = 'start', ...props }: ComponentProps<typeof R.Content>) {
  return (
    <R.Portal>
      <R.Content align={align} sideOffset={4} className={cn(menuContent, className)} {...props} />
    </R.Portal>
  )
}

/**
 * An item. With `reason` it is disabled and a tooltip (and aria-description) says why. Radix
 * only marks a disabled item (data-disabled), it does not swallow the pointer, so the tooltip
 * trigger still sees the hover.
 */
export function DropdownMenuItem({ className, danger, reason, disabled, ...props }: ComponentProps<typeof R.Item> & { danger?: boolean; reason?: string }) {
  return (
    <WithTooltip text={reason} side="right" delay={150}>
      <R.Item disabled={disabled || !!reason} aria-description={reason}
        className={cn(menuItem, danger && 'text-del', reason && 'cursor-not-allowed', className)} {...props} />
    </WithTooltip>
  )
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof R.Separator>) {
  return <R.Separator className={cn(menuSeparator, className)} {...props} />
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof R.Label>) {
  return <R.Label className={cn(menuLabel, className)} {...props} />
}

export function DropdownMenuSub({ label, children }: { label: string; children: ReactNode }) {
  return (
    <R.Sub>
      <R.SubTrigger className={cn(menuItem, 'justify-between')}>{label}<span className="text-faint">›</span></R.SubTrigger>
      <R.Portal>
        <R.SubContent className={cn(menuContent, 'max-h-80 overflow-y-auto')}>{children}</R.SubContent>
      </R.Portal>
    </R.Sub>
  )
}

export function DropdownMenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof R.CheckboxItem>) {
  return (
    <R.CheckboxItem className={cn(menuItem, 'relative pl-7', className)} {...props}>
      <R.ItemIndicator className="absolute left-2 flex items-center">✓</R.ItemIndicator>
      {children}
    </R.CheckboxItem>
  )
}
