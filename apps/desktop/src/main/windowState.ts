import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface WindowState {
  bounds: Rectangle
  maximized: boolean
}

const file = () => join(app.getPath('userData'), 'window-state.json')

/** Last window size and position, if it still fits on a connected display. */
export function loadWindowState(): WindowState | null {
  try {
    const s = JSON.parse(readFileSync(file(), 'utf8')) as WindowState
    // A window saved on a monitor that is no longer connected would open off-screen.
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      s.bounds.x < a.x + a.width && s.bounds.x + s.bounds.width > a.x &&
      s.bounds.y < a.y + a.height && s.bounds.y + s.bounds.height > a.y)
    return visible ? s : null
  } catch {
    return null
  }
}

/** Save size and position when the window moves or resizes (debounced) and when it closes. */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const save = () => {
    if (win.isDestroyed()) return
    const state: WindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
    try {
      writeFileSync(file(), JSON.stringify(state))
    } catch {
      // Not worth failing over.
    }
  }
  const later = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 500)
  }
  win.on('resize', later)
  win.on('move', later)
  win.on('close', save)
}

/** Height of the title bar (the tab bar row) in CSS px; the Windows caption buttons match it. */
export const TITLE_BAR_HEIGHT = 36
/** Caption button colours for the first paint, the same as --gs-bg / --gs-fg in styles.css. */
export const OVERLAY_DARK = { color: '#171719', symbolColor: '#e7e7e9' }
export const OVERLAY_LIGHT = { color: '#ffffff', symbolColor: '#1f2023' }
