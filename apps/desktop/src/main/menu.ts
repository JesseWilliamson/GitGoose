import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { broadcast } from './ipc'

/**
 * Native menu. Items that are app commands send a 'command' event; the renderer owns the logic
 * (it knows whether a text field has focus, which tab is active, and so on).
 */
export function installMenu(): void {
  const cmd = (name: string) => () => broadcast({ type: 'command', name })
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Repository…', accelerator: 'CmdOrCtrl+O', click: cmd('open-repo') },
        { label: 'Clone Repository…', click: cmd('clone-repo') },
        { label: 'New Repository…', click: cmd('init-repo') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: cmd('close-tab') },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: cmd('settings') },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Not role: 'undo': in a text field Cmd+Z should undo typing, elsewhere it undoes the
        // last git operation. Only the renderer knows which, so it decides.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: cmd('undo') },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find Commit…', accelerator: 'CmdOrCtrl+F', click: cmd('search') },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: cmd('palette') },
      ],
    },
    {
      label: 'Repository',
      submenu: [
        { label: 'Fetch', accelerator: 'CmdOrCtrl+Shift+L', click: cmd('fetch') },
        { label: 'Pull', accelerator: 'CmdOrCtrl+Shift+Down', click: cmd('pull') },
        { label: 'Push', accelerator: 'CmdOrCtrl+Shift+Up', click: cmd('push') },
        { type: 'separator' },
        { label: 'New Branch…', accelerator: 'CmdOrCtrl+B', click: cmd('new-branch') },
        { label: 'Stash Changes', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('stash') },
        { label: 'Pop Stash', click: cmd('pop') },
        { type: 'separator' },
        { label: 'Reveal in File Manager', click: cmd('reveal') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  void app
}
