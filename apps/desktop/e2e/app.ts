import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { tempDir } from '@gitsquid/fixtures'
import { join } from 'node:path'

export interface Launched {
  app: ElectronApplication
  page: Page
}

/** Launch the built app (out/) with a throwaway profile, optionally opening a repository. */
export async function launch(repo?: string, env: Record<string, string> = {}): Promise<Launched> {
  const args = [join(import.meta.dirname, '..', 'out', 'main', 'index.js')]
  // Containers usually run as root, where Chromium refuses to start without this.
  if (process.platform === 'linux') args.unshift('--no-sandbox')
  const app = await electron.launch({
    args,
    env: {
      ...process.env,
      GITSQUID_USER_DATA: tempDir('gitsquid-profile-'),
      GITSQUID_NO_UPDATE: '1',
      ...(repo ? { GITSQUID_OPEN: repo } : {}),
      ...env,
    } as Record<string, string>,
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.error('[renderer]', e.message))
  return { app, page }
}
