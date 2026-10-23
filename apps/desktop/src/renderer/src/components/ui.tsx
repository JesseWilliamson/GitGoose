import type { InputHTMLAttributes, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Button } from './ui/button'
import {
  ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuSub,
} from './ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import {
  DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub,
} from './ui/dropdown-menu'
import { Input } from './ui/input'
import { Kbd } from './ui/kbd'
import { WithTooltip } from './ui/tooltip'

/**
 * The app's shared primitives under their short names. The components themselves live in
 * `ui/` (shadcn-shaped: small, owned by us, built on Radix and our theme tokens); this file keeps
 * the names and props the rest of the renderer already uses.
 */

export { Button, Kbd }

/**
 * An icon-only toolbar button. The label is its accessible name and (unless a richer title is
 * given) its tooltip, so screen readers and tests still see "Push", not an arrow.
 */
export function ToolbarButton({ icon, label, onClick, disabled, title, badge, className }: {
  icon: ReactNode; label: string; onClick?: () => void; disabled?: boolean; title?: string; badge?: ReactNode; className?: string
}) {
  return (
    <WithTooltip text={title ?? label} side="bottom">
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={cn('no-drag relative flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40', className)}
      >
        {icon}
        {badge}
      </button>
    </WithTooltip>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cn('inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent', className)} />
}

export function SectionHeader({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between px-3 text-[11px] font-semibold tracking-wide text-muted uppercase">
      <span className="truncate">{children}</span>
      {right}
    </div>
  )
}

export const CM = {
  Content: ({ children }: { children: ReactNode }) => <ContextMenuContent>{children}</ContextMenuContent>,
  /** `reason` greys the item out and says why on hover (a tooltip, and aria-description). */
  Item: ({ children, onSelect, disabled, danger, reason }: { children: ReactNode; onSelect: () => void; disabled?: boolean; danger?: boolean; reason?: string }) => (
    <ContextMenuItem danger={danger} reason={reason} onSelect={onSelect} disabled={disabled}>{children}</ContextMenuItem>
  ),
  Separator: () => <ContextMenuSeparator />,
  Label: ({ children }: { children: ReactNode }) => <ContextMenuLabel>{children}</ContextMenuLabel>,
  Sub: ContextMenuSub,
}

export const DM = {
  Content: ({ children, align = 'start' }: { children: ReactNode; align?: 'start' | 'end' | 'center' }) => (
    <DropdownMenuContent align={align}>{children}</DropdownMenuContent>
  ),
  Item: ({ children, onSelect, disabled, reason }: { children: ReactNode; onSelect: () => void; disabled?: boolean; reason?: string }) => (
    <DropdownMenuItem reason={reason} onSelect={onSelect} disabled={disabled}>{children}</DropdownMenuItem>
  ),
  /** A toggle that keeps the menu open, so several can be flipped in a row. */
  Check: ({ children, checked, onChange, disabled, testId }: { children: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; testId?: string }) => (
    <DropdownMenuCheckboxItem checked={checked} disabled={disabled} data-testid={testId}
      onCheckedChange={(v) => onChange(v === true)} onSelect={(e) => e.preventDefault()}>
      {children}
    </DropdownMenuCheckboxItem>
  ),
  Separator: () => <DropdownMenuSeparator />,
  Label: ({ children }: { children: ReactNode }) => <DropdownMenuLabel>{children}</DropdownMenuLabel>,
  Sub: DropdownMenuSub,
}

export function Modal({ open, onClose, title, children, width = 440, tall = false, onEscapeKeyDown }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; width?: number
  /** A big dialog (a whole editor): placed near the top so it has the height. */
  tall?: boolean
  /** Esc closes the dialog unless this calls preventDefault (to end something inside it first). */
  onEscapeKeyDown?: (e: KeyboardEvent) => void
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent onEscapeKeyDown={onEscapeKeyDown} style={{ width }} className={tall ? 'top-[5vh]' : 'top-[18%]'}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="sr-only">{title}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  )
}

export function TextField({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return (
    <label className="block">
      {label && <span className="mb-1 block text-xs text-muted">{label}</span>}
      <Input {...props} />
    </label>
  )
}
