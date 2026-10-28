import { isPaneVisible } from '@gitgoose/shared'
import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { broadcast } from './ipc'
import { getSettings, onSettingsChanged } from './settings'

/**
 * Native menu. Items that are app commands send a 'command' event; the renderer owns the logic
 * (it knows whether a text field has focus, which tab is active, and so on).
 *
 * The renderer also owns the keyboard shortcuts (lib/keys.ts). Menu items show their shortcut
 * but do not register it (`registerAccelerator: false`, as VS Code does), so a key press is
 * handled in exactly one place and never fires twice.
 */
/** The View menu's checkable pane items: menu item id -> pane. */
const PANE_ITEMS = { 'show-branches': 'branches', 'show-details': 'details', 'show-ai': 'ai' } as const

/**
 * The checkmarks follow the layout in place. The menu is never rebuilt for them: replacing the
 * application menu on Linux/GTK can pull the keyboard focus out of the page a moment later, which
 * broke "Mod+Shift+A again hides the pane" (the composer had lost focus), and a divider drag
 * rewrites the layout many times.
 */
function syncPaneChecks(): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const layout = getSettings().layout
  for (const [id, pane] of Object.entries(PANE_ITEMS)) {
    const item = menu.getMenuItemById(id)
    const checked = isPaneVisible(layout, pane)
    if (item && item.checked !== checked) item.checked = checked
  }
}

/** Built once at startup. */
export function installMenu(): void {
  onSettingsChanged((_s, changed) => { if (changed.has('layout')) syncPaneChecks() })
  const layout = getSettings().layout
  const cmd = (name: string) => () => broadcast({ type: 'command', name })
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Repository…', accelerator: 'CmdOrCtrl+O', click: cmd('open-repo'), registerAccelerator: false },
        { label: 'Clone Repository…', click: cmd('clone-repo') },
        { label: 'New Repository…', click: cmd('init-repo') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: cmd('close-tab'), registerAccelerator: false },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: cmd('settings'), registerAccelerator: false },
        { label: 'Open Terminal Here', click: cmd('terminal') },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Not role: 'undo' / 'redo': in a text field Cmd+Z should undo typing, elsewhere it undoes
        // the last git operation. Only the renderer knows which, so it decides.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: cmd('undo'), registerAccelerator: false },
        { label: 'Redo', accelerator: isMac ? 'Shift+CmdOrCtrl+Z' : 'CmdOrCtrl+Y', click: cmd('redo'), registerAccelerator: false },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Search…', accelerator: 'CmdOrCtrl+K', click: cmd('search'), registerAccelerator: false },
        { label: 'Commands…', accelerator: 'CmdOrCtrl+P', click: cmd('palette'), registerAccelerator: false },
      ],
    },
    {
      label: 'Repository',
      submenu: [
        { label: 'Fetch', accelerator: 'CmdOrCtrl+Shift+L', click: cmd('fetch'), registerAccelerator: false },
        { label: 'Pull', accelerator: 'CmdOrCtrl+Shift+Down', click: cmd('pull'), registerAccelerator: false },
        { label: 'Push', accelerator: 'CmdOrCtrl+Shift+Up', click: cmd('push'), registerAccelerator: false },
        { type: 'separator' },
        { label: 'New Branch…', accelerator: 'CmdOrCtrl+Shift+B', click: cmd('new-branch'), registerAccelerator: false },
        { label: 'Stash Changes', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('stash'), registerAccelerator: false },
        { label: 'Pop Stash', click: cmd('pop') },
        { label: 'Reflog (Recover Lost Commits)', click: cmd('reflog') },
        { type: 'separator' },
        { label: 'Apply Patch…', click: cmd('apply-patch') },
        { label: 'Apply Patch from Clipboard', click: cmd('apply-patch-clipboard') },
        { type: 'separator' },
        { label: 'Reveal in File Manager', click: cmd('reveal') },
      ],
    },
    {
      label: 'View',
      submenu: [
        // Like a browser: back to the previous commit, diff or view (and tab), and forward again.
        { label: 'Back', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: cmd('back'), registerAccelerator: false },
        { label: 'Forward', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: cmd('forward'), registerAccelerator: false },
        { type: 'separator' },
        // Panes: a checkmark means the pane is on screen; a click shows or hides it.
        { id: 'show-branches', label: 'Show Branches', type: 'checkbox', checked: isPaneVisible(layout, 'branches'), accelerator: 'CmdOrCtrl+B', click: cmd('toggle-sidebar'), registerAccelerator: false },
        { id: 'show-details', label: 'Show Details', type: 'checkbox', checked: isPaneVisible(layout, 'details'), accelerator: 'CmdOrCtrl+Alt+B', click: cmd('toggle-details'), registerAccelerator: false },
        { id: 'show-ai', label: 'Show AI', type: 'checkbox', checked: isPaneVisible(layout, 'ai'), accelerator: 'CmdOrCtrl+Shift+A', click: cmd('toggle-ai-pane'), registerAccelerator: false },
        { label: 'Toggle Bottom Panel', accelerator: 'CmdOrCtrl+J', click: cmd('toggle-bottom'), registerAccelerator: false },
        { label: 'Hide Side Panels', click: cmd('layout-wide-graph') },
        { label: 'Reset Layout', click: cmd('layout-default') },
        { label: 'Toggle Comfy / Compact Graph', click: cmd('toggle-graph-style') },
        // Holding Shift shows the line for as long as it is held; this keeps it on.
        { label: 'Line View', accelerator: 'CmdOrCtrl+L', click: cmd('line-view'), registerAccelerator: false },
        { type: 'separator' },
        { label: 'Working Copy', accelerator: 'CmdOrCtrl+Alt+1', click: cmd('ws-working-copy'), registerAccelerator: false },
        { label: 'History', accelerator: 'CmdOrCtrl+Alt+2', click: cmd('ws-history'), registerAccelerator: false },
        { label: 'Stashes', accelerator: 'CmdOrCtrl+Alt+3', click: cmd('ws-stashes'), registerAccelerator: false },
        { label: 'Pull Requests', accelerator: 'CmdOrCtrl+Alt+4', click: cmd('ws-pulls'), registerAccelerator: false },
        { label: 'Reflog', accelerator: 'CmdOrCtrl+Alt+5', click: cmd('ws-reflog'), registerAccelerator: false },
        { label: 'Go to the Current Branch', accelerator: 'CmdOrCtrl+Alt+0', click: cmd('select-head-branch'), registerAccelerator: false },
        {
          // Long tag lists are shortened in the sidebar (the filter box still finds every tag).
          label: 'Tags',
          submenu: [
            { label: 'Show Newest 50', click: cmd('sidebar-tags-50') },
            { label: 'Show Newest 100', click: cmd('sidebar-tags-100') },
            { label: 'Show Newest 250', click: cmd('sidebar-tags-250') },
            { label: 'Show All', click: cmd('sidebar-tags-all') },
          ],
        },
        { type: 'separator' },
        {
          label: 'Commit Order',
          submenu: [
            { label: 'By Date', click: cmd('commit-order-date') },
            { label: 'Topological', click: cmd('commit-order-topo') },
          ],
        },
        { type: 'separator' },
        { label: 'Git Command Log', click: cmd('command-log') },
        { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        // Zoom is the UI scale setting, so it persists; the renderer handles the keys.
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: cmd('zoom-reset'), registerAccelerator: false },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: cmd('zoom-in'), registerAccelerator: false },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: cmd('zoom-out'), registerAccelerator: false },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  void app
}
