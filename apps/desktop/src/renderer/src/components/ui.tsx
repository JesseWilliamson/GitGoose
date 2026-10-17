import clsx from 'clsx'
import { ContextMenu, Dialog as RDialog, DropdownMenu } from 'radix-ui'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

/**
 * Small shared primitives. Radix provides behaviour (focus, keyboard, positioning, a11y);
 * these wrappers only add the look, in one place.
 */

type Variant = 'default' | 'primary' | 'danger' | 'ghost'

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }>(
  function Button({ variant = 'default', size = 'md', className, ...props }, ref) {
    return (
      <button
        ref={ref}
        className={clsx(
          'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:opacity-40 disabled:pointer-events-none',
          size === 'sm' ? 'h-6 px-2 text-xs' : 'h-8 px-3 text-[13px]',
          variant === 'primary' && 'bg-accent text-accent-fg hover:brightness-110',
          variant === 'danger' && 'bg-del text-white hover:brightness-110',
          variant === 'default' && 'bg-raised border border-line text-fg hover:bg-hover',
          variant === 'ghost' && 'text-muted hover:text-fg hover:bg-hover',
          className,
        )}
        {...props}
      />
    )
  },
)

export function ToolbarButton({ icon, label, onClick, disabled, title, badge }: {
  icon: ReactNode; label: string; onClick?: () => void; disabled?: boolean; title?: string; badge?: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      className="no-drag relative flex flex-col items-center justify-center gap-0.5 rounded-md px-2.5 py-1 text-muted hover:bg-hover hover:text-fg disabled:opacity-40 disabled:pointer-events-none"
    >
      {icon}
      <span className="text-[11px] leading-none">{label}</span>
      {badge}
    </button>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-panel px-1 py-px font-mono text-[10px] text-muted">{children}</kbd>
}

export function Spinner({ className }: { className?: string }) {
  return <span className={clsx('inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent', className)} />
}

export function SectionHeader({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between px-3 text-[11px] font-semibold tracking-wide text-muted uppercase">
      <span className="truncate">{children}</span>
      {right}
    </div>
  )
}

const menuContent = 'z-50 min-w-48 rounded-md border border-line bg-raised p-1 text-[13px] shadow-xl shadow-black/30'
const menuItem = 'flex h-7 cursor-default items-center gap-2 rounded px-2 outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg data-[disabled]:opacity-40'

export const CM = {
  Content: ({ children }: { children: ReactNode }) => (
    <ContextMenu.Portal>
      <ContextMenu.Content className={menuContent}>{children}</ContextMenu.Content>
    </ContextMenu.Portal>
  ),
  Item: ({ children, onSelect, disabled, danger }: { children: ReactNode; onSelect: () => void; disabled?: boolean; danger?: boolean }) => (
    <ContextMenu.Item className={clsx(menuItem, danger && 'text-del')} onSelect={onSelect} disabled={disabled}>{children}</ContextMenu.Item>
  ),
  Separator: () => <ContextMenu.Separator className="my-1 h-px bg-line" />,
  Label: ({ children }: { children: ReactNode }) => <ContextMenu.Label className="truncate px-2 py-1 text-[11px] text-faint">{children}</ContextMenu.Label>,
  Sub: ({ label, children }: { label: string; children: ReactNode }) => (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={clsx(menuItem, 'justify-between')}>{label}<span className="text-faint">›</span></ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className={menuContent}>{children}</ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  ),
}

export const DM = {
  Content: ({ children, align = 'start' }: { children: ReactNode; align?: 'start' | 'end' | 'center' }) => (
    <DropdownMenu.Portal>
      <DropdownMenu.Content align={align} sideOffset={4} className={menuContent}>{children}</DropdownMenu.Content>
    </DropdownMenu.Portal>
  ),
  Item: ({ children, onSelect, disabled }: { children: ReactNode; onSelect: () => void; disabled?: boolean }) => (
    <DropdownMenu.Item className={menuItem} onSelect={onSelect} disabled={disabled}>{children}</DropdownMenu.Item>
  ),
  /** A toggle that keeps the menu open, so several can be flipped in a row. */
  Check: ({ children, checked, onChange, disabled, testId }: { children: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; testId?: string }) => (
    <DropdownMenu.CheckboxItem className={clsx(menuItem, 'pl-7 relative')} checked={checked} disabled={disabled} data-testid={testId}
      onCheckedChange={(v) => onChange(v === true)} onSelect={(e) => e.preventDefault()}>
      <DropdownMenu.ItemIndicator className="absolute left-2 flex items-center">✓</DropdownMenu.ItemIndicator>
      {children}
    </DropdownMenu.CheckboxItem>
  ),
  Separator: () => <DropdownMenu.Separator className="my-1 h-px bg-line" />,
  Label: ({ children }: { children: ReactNode }) => <DropdownMenu.Label className="px-2 py-1 text-[11px] text-faint">{children}</DropdownMenu.Label>,
}

export function Modal({ open, onClose, title, children, width = 440 }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; width?: number
}) {
  return (
    <RDialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RDialog.Content
          style={{ width }}
          className="fixed top-[18%] left-1/2 z-50 max-w-[92vw] -translate-x-1/2 rounded-lg border border-line bg-raised p-4 shadow-2xl shadow-black/40"
        >
          <RDialog.Title className="mb-3 text-[15px] font-semibold">{title}</RDialog.Title>
          <RDialog.Description className="sr-only">{title}</RDialog.Description>
          {children}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

export function TextField({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return (
    <label className="block">
      {label && <span className="mb-1 block text-xs text-muted">{label}</span>}
      <input
        {...props}
        className={clsx('h-8 w-full rounded-md border border-line bg-bg px-2 text-[13px] outline-none focus:border-accent', props.className)}
      />
    </label>
  )
}
