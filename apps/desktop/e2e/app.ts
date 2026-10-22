import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { tempDir } from '@gitgoose/fixtures'
import { join } from 'node:path'

export interface Launched {
  app: ElectronApplication
  page: Page
}

/**
 * The window every test runs in, on every platform: what fits the macOS CI runner's
 * 1024×768 screen under the menu bar and title bar. macOS shrinks a bigger window to fit its
 * screen while Linux (Xvfb) does not, so without one size the layout differed per platform.
 */
export const WINDOW = { width: 1024, height: 640 }

/**
 * Pick an item from a submenu with the keyboard (→ opens it, Enter picks). With the mouse,
 * Playwright jumps the pointer straight from the trigger to the item; when the window is too
 * small for the submenu on the right it opens on the left, that jump leaves Radix's grace area,
 * and the submenu closes before the click lands.
 */
export async function pickFromSubmenu(page: Page, submenu: string | RegExp, name: string | RegExp): Promise<void> {
  await page.getByRole('menuitem', { name: submenu }).press('ArrowRight')
  await page.getByRole('menuitem', { name }).press('Enter')
}

/** Launch the built app (out/) with a throwaway profile, optionally opening a repository. */
export async function launch(repo?: string, env: Record<string, string> = {}, opts: { keepSize?: boolean } = {}): Promise<Launched> {
  const args = [join(import.meta.dirname, '..', 'out', 'main', 'index.js')]
  // Containers usually run as root, where Chromium refuses to start without this.
  if (process.platform === 'linux') args.unshift('--no-sandbox')
  const app = await electron.launch({
    args,
    env: {
      ...process.env,
      GITGOOSE_USER_DATA: tempDir('gitgoose-profile-'),
      GITGOOSE_NO_UPDATE: '1',
      // Tests never reach GitHub: the API and the avatar host point at a closed local port unless
      // a test brings its own fake (fakeGitHub, a local avatar server).
      GITGOOSE_GITHUB_API: 'http://127.0.0.1:9',
      GITGOOSE_AVATAR_GITHUB_BASE: 'http://127.0.0.1:9',
      ...(repo ? { GITGOOSE_OPEN: repo } : {}),
      ...env,
    } as Record<string, string>,
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.error('[renderer]', e.message))
  if (!opts.keepSize) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), WINDOW)
  }
  return { app, page }
}
