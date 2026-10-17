import { app } from 'electron'
import { logError } from './diagnostics'

/**
 * Auto-update from GitHub releases (see electron-builder.yml `publish`). Only in packaged builds,
 * and only after the window is up, so it never delays startup. electron-updater is loaded lazily
 * for the same reason.
 */
export function scheduleUpdateCheck(): void {
  if (!app.isPackaged || process.env.GITSQUID_NO_UPDATE) return
  setTimeout(async () => {
    try {
      const { autoUpdater } = await import('electron-updater')
      autoUpdater.logger = null
      await autoUpdater.checkForUpdatesAndNotify()
    } catch (e) {
      logError('updater', e instanceof Error ? e.message : String(e))
    }
  }, 10_000)
}
