import { hidePane, isPaneVisible, setCollapsed, showPane, type PaneId, type PaneLayout } from '@gitgoose/shared'
import { create } from 'zustand'
import { saveSettings, setting } from './store'

/**
 * Doing things with the pane layout. The layout itself and every rule about it are pure
 * functions in packages/shared/src/layout.ts; this file only reads the setting, applies one of
 * them and saves the result, which is how every window sees the change.
 */

/** A pane tab in a drag: the PaneId. */
export const PANE_MIME = 'application/x-gitgoose-pane'

/** The pane tab in the air, so the workspace can show its drop zones. */
export const usePaneDrag = create<{ dragging: PaneId | null }>(() => ({ dragging: null }))

export function saveLayout(next: PaneLayout): void {
  if (JSON.stringify(next) !== JSON.stringify(setting('layout'))) void saveSettings({ layout: next })
}

export function changeLayout(f: (l: PaneLayout) => PaneLayout): void {
  saveLayout(f(setting('layout')))
}

/** Keyboard and View menu: show a pane (where it lives, or where it belongs) or hide the one on screen. */
export function togglePane(pane: PaneId): void {
  changeLayout((l) => (isPaneVisible(l, pane) ? hidePane(l, pane) : showPane(l, pane)))
}

/** Collapse or expand the bottom slot. Nothing to do while no pane is in it. */
export function toggleBottom(): void {
  changeLayout((l) => (l.bottom.panes.length ? setCollapsed(l, 'bottom', !l.bottom.collapsed) : l))
}

const COMPOSER = '[data-testid="ai-chat-panel"] textarea'

/** Is the keyboard focus anywhere inside the AI pane (its message box, a button in it, ...)? */
export function focusInAiPane(): boolean {
  return !!document.activeElement?.closest('[data-testid="ai-chat-panel"]')
}

/** Put the cursor in the AI pane's message box once it exists (the pane may have just been shown). */
export function focusAiComposer(): void {
  let tries = 0
  const timer = setInterval(() => {
    const el = document.querySelector<HTMLTextAreaElement>(COMPOSER)
    if (el) el.focus()
    if (el || ++tries > 40) clearInterval(timer)
  }, 50)
}

/** Show the AI pane, activated and opened (a result is here, or a conversation was started). */
export function showAiPane(): void {
  changeLayout((l) => showPane(l, 'ai'))
}
