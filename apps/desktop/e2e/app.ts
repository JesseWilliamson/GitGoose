import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { tempDir } from '@gitgoose/fixtures'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  const item = page.getByRole('menuitem', { name })
  // On a loaded machine the arrow can land before the menu is ready to open its submenu and
  // nothing appears; ask again (hovering the trigger opens it too) rather than wait 30 s for nothing.
  for (let attempt = 0; ; attempt++) {
    const trigger = page.getByRole('menuitem', { name: submenu })
    if (attempt) await trigger.hover()
    await trigger.press('ArrowRight')
    try {
      await expect(item).toBeVisible({ timeout: 1500 })
      break
    } catch (e) {
      if (attempt === 3) throw e
    }
  }
  await item.press('Enter')
}

/**
 * Open the popover of an AI area's target button ("Claude · default"), which holds the two model
 * selects (`model-picker-who`, `model-picker-model`) and the Prompt button; a no-op if it is open.
 * `within` narrows the search when several areas of one kind are on screen.
 */
export async function openTarget(page: Page, area: string, within?: Locator): Promise<Locator> {
  const panel = page.getByTestId(`ai-target-panel-${area}`)
  if (!(await panel.isVisible())) await (within ?? page).getByTestId(`ai-target-${area}`).click()
  await expect(panel).toBeVisible()
  return panel
}

/** Open an area's Prompt editor (through its target button's popover). */
export async function openPrompt(page: Page, area: string): Promise<void> {
  const button = page.getByTestId(`prompt-button-${area}`)
  if (!(await button.isVisible())) await openTarget(page, area)
  await button.click()
}

/** Launch the built app (out/) with a throwaway profile, optionally opening a repository. */
export async function launch(repo?: string, env: Record<string, string> = {}, opts: { keepSize?: boolean } = {}): Promise<Launched> {
  const args = [join(import.meta.dirname, '..', 'out', 'main', 'index.js')]
  // Containers usually run as root, where Chromium refuses to start without this.
  if (process.platform === 'linux') args.unshift('--no-sandbox')
  const start = () => electron.launch({
    args,
    env: {
      ...process.env,
      GITGOOSE_USER_DATA: tempDir('gitgoose-profile-'),
      GITGOOSE_NO_UPDATE: '1',
      // Tests never reach GitHub: the API and the avatar host point at a closed local port unless
      // a test brings its own fake (fakeGitHub, whose GITGOOSE_GITHUB_URL also serves the API,
      // or a local avatar server).
      ...(env.GITGOOSE_GITHUB_URL || env.GITGOOSE_GITHUB_API ? {} : { GITGOOSE_GITHUB_API: 'http://127.0.0.1:9' }),
      GITGOOSE_AVATAR_GITHUB_BASE: 'http://127.0.0.1:9',
      ...(repo ? { GITGOOSE_OPEN: repo } : {}),
      ...env,
    } as Record<string, string>,
  })
  // With tests running side by side, a launch now and then dies before the window exists
  // ("Missing X server or $DISPLAY" under a loaded Xvfb). One more try is all it needs.
  const app = await start().catch(() => start())
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.error('[renderer]', e.message))
  if (!opts.keepSize) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), WINDOW)
  }
  return { app, page }
}

/**
 * Tests run side by side, each in its own app, but every app on the machine shares one system
 * clipboard (under xvfb-run, one X display). A file whose tests read or write it calls this at
 * the top, so only one such test runs at a time: `mkdir` either creates the lock directory or
 * fails because another test holds it.
 */
export function useClipboardLock(): void {
  const lock = join(tmpdir(), 'gitgoose-e2e-clipboard.lock')
  test.beforeEach(async () => {
    const until = Date.now() + 120_000
    for (;;) {
      try {
        mkdirSync(lock)
        return
      } catch {
        if (Date.now() > until) throw new Error('Another test held the clipboard for two minutes')
        await new Promise((r) => setTimeout(r, 100))
      }
    }
  })
  test.afterEach(() => rmSync(lock, { recursive: true, force: true }))
}

/**
 * Every AI action goes through the chat: a menu item writes its request into the AI pane's
 * message box and sends nothing (lib/aiActions.ts). This is the second half — read it, send it
 * — which every test of an AI feature does right after picking its menu item.
 */
export async function sendComposed(page: Page, action?: string): Promise<void> {
  const pill = page.getByTestId('ai-pending-action')
  await expect(pill).toBeVisible()
  if (action) await expect(pill).toHaveAttribute('data-action', action)
  const box = page.getByTestId('ai-chat-panel').locator('textarea')
  await expect(box).not.toHaveValue('')
  await box.press('Enter')
}

/** Close the AI pane from its tab menu (the pane chrome has the Hide; the pane itself has no close button). */
export async function hideAiPane(page: Page): Promise<void> {
  await page.getByTestId('pane-menu-ai').click()
  await page.getByRole('menuitem', { name: 'Hide' }).click()
}

/**
 * Drag `from` onto `to` with the mouse. Chromium starts a native drag only when the pointer
 * moves soon after the button goes down; on a loaded machine that first move can land before
 * the page is ready and no drag begins (Playwright's own dragTo then drops nothing, silently).
 * The app shows its drag badge as soon as a drag is over a target, so that is the proof the
 * drag started: without it, let go and try again. `at` is where on the target to drop, as a
 * fraction of its height (0.5: the middle; a row's thirds mean above, onto, below).
 */
export async function dragTo(page: Page, from: Locator, to: Locator, opts: { at?: number } = {}): Promise<void> {
  const badge = page.getByTestId('drag-badge')
  await from.scrollIntoViewIfNeeded()
  await to.scrollIntoViewIfNeeded()
  const box = (await to.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height * (opts.at ?? 0.5)
  for (let attempt = 0; ; attempt++) {
    await from.hover()
    await page.mouse.down()
    await page.mouse.move(x, y, { steps: 6 })
    await page.mouse.move(x + 1, y)
    if (attempt === 2) break
    try {
      await expect(badge).toBeVisible({ timeout: 1500 })
      break
    } catch {
      await page.mouse.up()
      await expect(badge).toBeHidden()
    }
  }
  await page.mouse.up()
  await expect(badge).toBeHidden()
}

/**
 * Click one of a file row's hover-only actions (the buttons in FileList shown with
 * `group-hover:flex`). The hover is synthetic, and a re-render between the hover and the click
 * (a snapshot arriving) can leave the row un-hovered and the button display:none; Playwright then
 * waits for a button that will never show. Hover again from outside the row and retry.
 */
export async function clickRowAction(page: Page, row: Locator, title: string): Promise<void> {
  const button = row.getByTitle(title)
  for (let attempt = 0; ; attempt++) {
    await page.mouse.move(0, 0)
    await row.hover()
    try {
      await button.click({ timeout: 2000 })
      return
    } catch (e) {
      if (attempt === 4) throw e
    }
  }
}

/**
 * A file's text, or null while it does not exist. git rewrites a file by removing it first, so a
 * read in an expect.poll can land in between; a thrown ENOENT fails the poll at once instead of
 * being retried, null is retried.
 */
export function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Hover `trigger` and wait for its tooltip to say `text`. A tooltip is a timer plus a pointer
 * event: Radix opens it 400 ms (TooltipProvider's delay) after a `pointermove` over the trigger,
 * and on a loaded machine that move can land before the trigger is mounted, hit-testable or out
 * from under a menu that is still settling, so nothing opens. A test should wait for the
 * tooltip, not for a fixed time: hover, nudge the pointer (the move is what Radix listens
 * for), wait up to 2 s (the delay plus slack) and if nothing came, leave and try again (3 tries).
 */
export async function expectTooltip(page: Page, trigger: Locator, text: string | RegExp): Promise<void> {
  const tip = page.getByRole('tooltip').filter({ hasText: text }).first()
  for (let attempt = 0; ; attempt++) {
    // Start from a neutral point so that arriving is a real pointer enter, then walk onto the
    // trigger in steps (several pointermoves, the event Radix opens on), then nudge twice.
    await page.mouse.move(2, 2)
    // force: a disabled menu item's wrapper is what has the tooltip, and a menu animating in is not "stable".
    await trigger.scrollIntoViewIfNeeded().catch(() => {})
    const at = (await trigger.boundingBox())!
    const cx = at.x + at.width / 2
    const cy = at.y + at.height / 2
    await page.mouse.move(cx, cy, { steps: 10 })
    for (const dx of [2, -2]) {
      await page.waitForTimeout(100)
      await page.mouse.move(cx + dx, cy, { steps: 2 })
    }
    try {
      await expect(tip).toBeVisible({ timeout: 2000 })
      return
    } catch (e) {
      if (attempt === 2) throw e
    }
  }
}
