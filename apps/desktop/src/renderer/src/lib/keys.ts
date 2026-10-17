/**
 * Keyboard shortcuts, all in one table. The native menu displays the same shortcuts but does not
 * register them (see src/main/menu.ts), so this is the single place a key press is handled.
 *
 * A shortcut is "mod+shift+key", where mod is Cmd on macOS and Ctrl elsewhere.
 */
export const SHORTCUTS: Record<string, string> = {
  'mod+z': 'undo',
  'mod+o': 'open-repo',
  'mod+w': 'close-tab',
  'mod+,': 'settings',
  'mod+f': 'search',
  'mod+k': 'palette',
  'mod+shift+p': 'palette',
  'mod+shift+l': 'fetch',
  'mod+shift+arrowdown': 'pull',
  'mod+shift+arrowup': 'push',
  'mod+b': 'new-branch',
  'mod+shift+s': 'stash',
}

const mac = typeof window !== 'undefined' && window.gitsquid?.platform === 'darwin'

export function shortcutOf(e: KeyboardEvent): string | null {
  const mod = mac ? e.metaKey : e.ctrlKey
  if (!mod) return null
  return `mod+${e.shiftKey ? 'shift+' : ''}${e.key.toLowerCase()}`
}

/** Human-readable list for the shortcuts dialog. */
export const SHORTCUT_HELP: { keys: string; what: string }[] = [
  { keys: 'mod+K  or  mod+Shift+P', what: 'Command palette' },
  { keys: 'mod+Z', what: 'Undo the last git operation (in a text field: undo typing)' },
  { keys: 'mod+F', what: 'Find commits' },
  { keys: 'Enter / Shift+Enter', what: 'Next / previous search match' },
  { keys: 'J / K  or  ↓ / ↑', what: 'Next / previous commit in the graph' },
  { keys: 'PageDown / PageUp, Home / End', what: 'Move through the graph faster' },
  { keys: 'mod+Enter', what: 'Commit (in the message box)' },
  { keys: 'Esc', what: 'Close the diff and return to the graph' },
  { keys: 'mod+B', what: 'New branch' },
  { keys: 'mod+Shift+S', what: 'Stash changes' },
  { keys: 'mod+Shift+L', what: 'Fetch' },
  { keys: 'mod+Shift+↓ / ↑', what: 'Pull / push' },
  { keys: 'mod+O', what: 'Open repository' },
  { keys: 'mod+1 … 9', what: 'Switch tab' },
  { keys: 'mod+W', what: 'Close tab' },
  { keys: 'mod+,', what: 'Settings' },
  { keys: '?', what: 'This list' },
]

export function modName(): string {
  return mac ? '⌘' : 'Ctrl'
}
