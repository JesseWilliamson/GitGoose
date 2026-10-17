import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { broadcast } from './ipc'

/**
 * Native menu. Items that are app commands send a 'command' event; the renderer owns the logic
 * (it knows whether a text field has focus, which tab is active, and so on).
 *
 * The renderer also owns the keyboard shortcuts (lib/keys.ts). Menu items show their shortcut
 * but do not register it (`registerAccelerator: false`, as VS Code does), so a key press is
 * handled in exactly one place and never fires twice.
 */
export function installMenu(): void {
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
        // Not role: 'undo': in a text field Cmd+Z should undo typing, elsewhere it undoes the
        // last git operation. Only the renderer knows which, so it decides.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: cmd('undo'), registerAccelerator: false },
        { role: 'redo' },
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
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: cmd('toggle-sidebar'), registerAccelerator: false },
        { label: 'Toggle Details', accelerator: 'CmdOrCtrl+Alt+B', click: cmd('toggle-details'), registerAccelerator: false },
        { label: 'Hide Side Panels', click: cmd('layout-wide-graph') },
        { label: 'Reset Panel Sizes', click: cmd('layout-default') },
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
