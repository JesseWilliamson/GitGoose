import { Check, ChevronDown } from 'lucide-react'
import { Select as RSelect } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'
import { menuContent, menuItem } from './menu-styles'

export const Select = RSelect.Root
export const SelectValue = RSelect.Value

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof RSelect.Trigger>) {
  return (
    <RSelect.Trigger
      className={cn('inline-flex h-8 items-center justify-between gap-1.5 rounded-md border border-line bg-bg px-2 text-[13px] text-fg outline-none focus:border-accent data-[state=open]:border-accent disabled:opacity-50 [&>span]:truncate', className)}
      {...props}>
      {children}
      <RSelect.Icon asChild><ChevronDown size={13} className="shrink-0 text-muted" /></RSelect.Icon>
    </RSelect.Trigger>
  )
}

export function SelectContent({ className, children, ...props }: ComponentProps<typeof RSelect.Content>) {
  return (
    <RSelect.Portal>
      <RSelect.Content position="popper" sideOffset={4}
        className={cn(menuContent, 'max-h-80 min-w-(--radix-select-trigger-width) overflow-y-auto', className)} {...props}>
        <RSelect.Viewport>{children}</RSelect.Viewport>
      </RSelect.Content>
    </RSelect.Portal>
  )
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof RSelect.Item>) {
  return (
    <RSelect.Item className={cn(menuItem, 'relative pl-6', className)} {...props}>
      <RSelect.ItemIndicator className="absolute left-1.5 flex items-center"><Check size={12} /></RSelect.ItemIndicator>
      <RSelect.ItemText>{children}</RSelect.ItemText>
    </RSelect.Item>
  )
}

/** Radix forbids an item whose value is the empty string (that is "no selection"), so '' travels as this. */
const EMPTY = '\u0001empty'

export interface SelectOption { value: string; label: string; title?: string }

/**
 * The common case in one piece: a value, a list of options, a change handler. `''` is a valid
 * option value. Extra props (aria-label, data-testid, className) land on the trigger.
 */
export function OptionSelect({ value, onChange, options, disabled, className, placeholder, ...trigger }: {
  value: string
  onChange: (value: string) => void
  options: readonly SelectOption[]
  disabled?: boolean
  className?: string
  placeholder?: string
  'aria-label'?: string
  'data-testid'?: string
  title?: string
}) {
  const enc = (v: string) => (v === '' ? EMPTY : v)
  return (
    <Select value={enc(value)} onValueChange={(v) => onChange(v === EMPTY ? '' : v)} disabled={disabled}>
      <SelectTrigger className={className} {...trigger}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => <SelectItem key={o.value} value={enc(o.value)} title={o.title}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}
