/**
 * Keyboard shortcuts. The native menu displays shortcuts but does not register them (see
 * src/main/menu.ts), so this is the single place a key press is handled.
 *
 * A combination is written "mod+shift+key", where mod is Cmd on macOS and Ctrl elsewhere.
 * COMMANDS holds the defaults; the `keybindings` setting maps a command id to a replacement
 * combination ("" means no shortcut).
 */

export interface KeyCommand {
  id: string
  label: string
  defaults: string[]
}

export const COMMANDS: KeyCommand[] = [
  { id: 'palette', label: 'Command palette', defaults: ['mod+p', 'mod+shift+p', 'mod+k'] },
  { id: 'undo', label: 'Undo the last git operation', defaults: ['mod+z'] },
  { id: 'search', label: 'Find commits', defaults: ['mod+f'] },
  { id: 'open-repo', label: 'Open repository', defaults: ['mod+o'] },
  { id: 'close-tab', label: 'Close tab', defaults: ['mod+w'] },
  { id: 'settings', label: 'Settings', defaults: ['mod+,'] },
  { id: 'fetch', label: 'Fetch', defaults: ['mod+shift+l'] },
  { id: 'pull', label: 'Pull', defaults: ['mod+shift+arrowdown'] },
  { id: 'push', label: 'Push', defaults: ['mod+shift+arrowup'] },
  { id: 'new-branch', label: 'New branch', defaults: ['mod+shift+b'] },
  { id: 'stash', label: 'Stash changes', defaults: ['mod+shift+s'] },
  { id: 'terminal', label: 'Open terminal here', defaults: ['mod+shift+t'] },
  { id: 'zoom-in', label: 'Zoom in', defaults: ['mod+='] },
  { id: 'zoom-out', label: 'Zoom out', defaults: ['mod+-'] },
  { id: 'zoom-reset', label: 'Actual size', defaults: ['mod+0'] },
  { id: 'toggle-sidebar', label: 'Show or hide the sidebar', defaults: ['mod+b'] },
  { id: 'toggle-details', label: 'Show or hide the details panel', defaults: ['mod+alt+b'] },
]

const mac = typeof window !== 'undefined' && window.gitsquid?.platform === 'darwin'

/** The combination a key event represents, or null for keys without a modifier. */
export function comboOf(e: KeyboardEvent): string | null {
  const mod = mac ? e.metaKey : e.ctrlKey
  if (!mod) return null
  let key = e.key.toLowerCase()
  if (['control', 'meta', 'shift', 'alt'].includes(key)) return null
  // "+" is shift+"=" on most layouts; treat both as "=" so zoom in works either way.
  let shift = e.shiftKey
  if (key === '+') {
    key = '='
    shift = false
  }
  return `mod+${e.altKey ? 'alt+' : ''}${shift ? 'shift+' : ''}${key}`
}

/** The effective combinations for each command. */
export function bindings(overrides: Record<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const c of COMMANDS) {
    const o = overrides[c.id]
    out.set(c.id, o === undefined ? c.defaults : o ? [o] : [])
  }
  return out
}

/** combination -> command id, for dispatching key presses. */
export function keymap(overrides: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>()
  for (const [id, combos] of bindings(overrides)) for (const k of combos) if (!map.has(k)) map.set(k, id)
  return map
}

/** Combinations bound to more than one command. */
export function conflicts(overrides: Record<string, string>): Map<string, string[]> {
  const seen = new Map<string, string[]>()
  for (const [id, combos] of bindings(overrides)) for (const k of combos) seen.set(k, [...(seen.get(k) ?? []), id])
  return new Map([...seen].filter(([, ids]) => ids.length > 1))
}

export function modName(): string {
  return mac ? '⌘' : 'Ctrl'
}

/** "mod+shift+p" -> "Ctrl+Shift+P" (or "⌘⇧P" on macOS). */
export function formatCombo(combo: string): string {
  const names: Record<string, string> = mac
    ? { mod: '⌘', shift: '⇧', alt: '⌥', arrowdown: '↓', arrowup: '↑', arrowleft: '←', arrowright: '→' }
    : { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', arrowdown: '↓', arrowup: '↑', arrowleft: '←', arrowright: '→' }
  const parts = combo.split('+').map((p) => names[p] ?? (p.length === 1 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1)))
  return mac ? parts.join('') : parts.join('+')
}

/** The first shortcut bound to a command, formatted for a tooltip ("" when it has none). */
export function shortcutOf(id: string, overrides: Record<string, string> = {}): string {
  const combo = bindings(overrides).get(id)?.[0]
  return combo ? formatCombo(combo) : ''
}

/** Keys that are not configurable commands, for the shortcuts dialog. */
export const FIXED_KEYS: { keys: string; what: string }[] = [
  { keys: 'Enter / Shift+Enter', what: 'Next / previous search match' },
  { keys: 'J / K  or  ↓ / ↑', what: 'Next / previous commit in the graph' },
  { keys: 'PageDown / PageUp, Home / End', what: 'Move through the graph faster' },
  { keys: 'mod+Enter', what: 'Commit (in the message box)' },
  { keys: 'Esc', what: 'Close the diff or settings and return to the graph' },
  { keys: 'mod+1 … 9', what: 'Switch tab' },
  { keys: '?', what: 'This list' },
]
