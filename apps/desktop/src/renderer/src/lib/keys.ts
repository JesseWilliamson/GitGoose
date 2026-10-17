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
