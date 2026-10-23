import clsx from 'clsx'
import type { ReactNode } from 'react'

/**
 * The one row every part of the settings page is made of: a label column (label, then the
 * description under it) and a control column of one fixed width. Every control fills the
 * control column; the only exception is the switch, which sits at its right edge. Settings,
 * the AI section and the keyboard section all use this, so nothing can drift out of line.
 */
export function SettingsRow({ label, description, children, testid, labelExtra, last = true }: {
  label: ReactNode
  description?: ReactNode
  /** The control. Omit for a row that only introduces a block below it. */
  children?: ReactNode
  testid?: string
  /** Beside the label (the reset-to-default button). */
  labelExtra?: ReactNode
  /** False when a block follows that carries the row's bottom line. */
  last?: boolean
}) {
  return (
    <div className={clsx('grid grid-cols-[1fr_360px] items-center gap-x-6 py-3', last && 'border-b border-line')} data-testid={testid}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13px] font-medium">{label}{labelExtra}</div>
        {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
      </div>
      {children !== undefined && <div className="flex w-[360px] min-w-0 items-center" data-control>{children}</div>}
    </div>
  )
}

/** The switch is the one control that does not fill the column: it sits at the column's right edge. */
export function SwitchSlot({ children }: { children: ReactNode }) {
  return <div className="flex w-full justify-end">{children}</div>
}
