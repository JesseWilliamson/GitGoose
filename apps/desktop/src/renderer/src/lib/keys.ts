/**
 * Keyboard shortcuts. The native menu displays shortcuts but does not register them (see
 * src/main/menu.ts), so this is the single place a key press is handled.
 *
 * A combination is written "mod+shift+key", where mod is Cmd on macOS and Ctrl elsewhere, or
 * "alt+key" without mod (Alt+Left goes back, as in a browser). COMMANDS holds the defaults; the
 * `keybindings` setting maps a command id to a replacement combination ("" means no shortcut).
 */

export interface KeyCommand {
  id: string
  label: string
  defaults: string[]
}

const mac = typeof window !== 'undefined' && window.gitgoose?.platform === 'darwin'

export const COMMANDS: KeyCommand[] = [
  { id: 'search', label: 'Search everything', defaults: ['mod+k', 'mod+f'] },
  { id: 'palette', label: 'Commands', defaults: ['mod+p', 'mod+shift+p'] },
  { id: 'undo', label: 'Undo the last git operation', defaults: ['mod+z'] },
  { id: 'redo', label: 'Redo what was undone', defaults: ['mod+shift+z', 'mod+y'] },
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
  { id: 'toggle-sidebar', label: 'Show or hide the Branches pane', defaults: ['mod+b'] },
  { id: 'toggle-details', label: 'Show or hide the Details pane', defaults: ['mod+alt+b'] },
  { id: 'toggle-bottom', label: 'Collapse or expand the bottom panel', defaults: ['mod+j'] },
  // Mod+L, not the plan's Mod+Shift+L: that one has been Fetch for a long time.
  { id: 'line-view', label: 'Show only the selected line of history, or everything again', defaults: ['mod+l'] },
  { id: 'ai-chat', label: 'Show the AI pane and focus it, or hide it when it has focus', defaults: ['mod+shift+a'] },
  // Tower's Workspace keys are Mod+1…5; here Mod+1…9 switch tabs (and Mod+0 is Actual Size), so
  // the Workspace takes Mod+Alt and the same digits. In the sidebar, Mod+0 goes to HEAD's branch too.
  { id: 'ws-working-copy', label: 'Workspace: Working Copy', defaults: ['mod+alt+1'] },
  { id: 'ws-history', label: 'Workspace: History (every branch)', defaults: ['mod+alt+2'] },
  { id: 'ws-stashes', label: 'Workspace: Stashes', defaults: ['mod+alt+3'] },
  { id: 'ws-pulls', label: 'Workspace: Pull Requests', defaults: ['mod+alt+4'] },
  { id: 'ws-reflog', label: 'Workspace: Reflog', defaults: ['mod+alt+5'] },
  { id: 'select-head-branch', label: 'Go to the current branch in the sidebar', defaults: ['mod+alt+0'] },
  // As in a browser. On macOS also Cmd+[ and Cmd+] (Finder, Safari, Xcode).
  { id: 'back', label: 'Back to where you were', defaults: mac ? ['alt+arrowleft', 'mod+['] : ['alt+arrowleft'] },
  { id: 'forward', label: 'Forward again', defaults: mac ? ['alt+arrowright', 'mod+]'] : ['alt+arrowright'] },
]

/**
 * The combination a key event represents, or null for keys without mod or Alt (Shift alone makes
 * no combination). Alt without mod gives "alt+…". The other modifier (Ctrl on macOS, the
 * Windows/Cmd key elsewhere) is never part of a combination: with Alt alone it gives null.
 */
export function comboOf(e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, isMac = mac): string | null {
  const mod = isMac ? e.metaKey : e.ctrlKey
  const other = isMac ? e.ctrlKey : e.metaKey
  if (!mod && (!e.altKey || other)) return null
  let key = e.key.toLowerCase()
  if (['control', 'meta', 'shift', 'alt'].includes(key)) return null
  // A digit by its key, not its character: Alt+1 types "¡" on a Mac and Shift+1 "!".
  const digit = /^Digit(\d)$/.exec(e.code ?? '')
  if (digit) key = digit[1]!
  // "+" is shift+"=" on most layouts; treat both as "=" so zoom in works either way.
  let shift = e.shiftKey
  if (key === '+') {
    key = '='
    shift = false
  }
  return `${mod ? 'mod+' : ''}${e.altKey ? 'alt+' : ''}${shift ? 'shift+' : ''}${key}`
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
  { keys: 'Enter / Shift+Enter', what: 'Next / previous match in the graph (after “Show matching commits in the graph”)' },
  { keys: '> (in search)', what: 'Search commands only' },
  { keys: 'J / K  or  ↓ / ↑', what: 'Next / previous commit in the graph' },
  { keys: 'PageDown / PageUp, Home / End', what: 'Move through the graph faster' },
  { keys: 'mod+Enter', what: 'Commit (in the message box)' },
  { keys: 'Esc', what: 'Close the diff or settings and return to the graph' },
  { keys: 'mod+1 … 9', what: 'Switch tab' },
  { keys: '?', what: 'This list' },
]
