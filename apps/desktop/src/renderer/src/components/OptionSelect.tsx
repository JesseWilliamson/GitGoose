import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

/** Radix forbids an item whose value is the empty string (that is "no selection"), so '' travels as this. */
const EMPTY = '\u0001empty'

export interface SelectOption { value: string; label: string; title?: string }

/**
 * The common case of shadcn's Select in one piece: a value, a list of options, a change handler.
 * `''` is a valid option value. Extra props (aria-label, data-testid, className) land on the
 * trigger, which is a compact, shrinkable 28px control; `className` can override.
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
      <SelectTrigger
        className={cn('min-w-0 gap-1 bg-background px-2 py-0 text-sm shadow-none data-[size=default]:h-input dark:bg-background dark:hover:bg-accent', className)}
        {...trigger}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" className="data-[state=closed]:animate-none!">
        {options.map((o) => <SelectItem key={o.value} value={enc(o.value)} title={o.title} className="text-sm">{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}
