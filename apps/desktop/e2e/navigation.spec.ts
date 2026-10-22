import { makeFixture } from '@gitgoose/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { basename, delimiter } from 'node:path'
import { launch } from './app'

const row = (page: Page, hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)
const back = (page: Page) => page.keyboard.press('Alt+ArrowLeft')
const forward = (page: Page) => page.keyboard.press('Alt+ArrowRight')
/** A mouse side button: Playwright cannot press those, so the event the page would get. */
const sideButton = (page: Page, button: 3 | 4) =>
  page.evaluate((button) => document.body.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true, cancelable: true })), button)

test('back and forward step through commits, diffs, views and tabs', async () => {
  const a = makeFixture('linear')
  const older = a.git('rev-parse', 'HEAD~1').trim()
  const b = makeFixture('branches')
  b.write('notes.txt', 'uncommitted\n') // so B shows the commit message box
  const { app, page } = await launch([a.dir, b.dir].join(delimiter))
  const tabs = page.getByTestId('tabs')
  const repo = page.getByTestId('location-repo')
  const reflog = page.getByTestId('reflog')
  const fileView = page.getByTestId('file-view')
  await expect(tabs.getByText(basename(b.dir), { exact: true })).toBeVisible()

  // In A: a commit, one of its files, the reflog. Then over to B.
  await tabs.getByText(basename(a.dir), { exact: true }).click()
  await expect(repo).toHaveText(basename(a.dir))
  await row(page, older).click()
  await expect(row(page, older)).toHaveAttribute('data-selected', 'true')
  await page.getByTestId('commit-file').first().click()
  await expect(fileView).toBeVisible()
  await page.getByTestId('open-reflog').click()
  await expect(reflog).toBeVisible()
  await tabs.getByText(basename(b.dir), { exact: true }).click()
  await expect(repo).toHaveText(basename(b.dir))

  // Back: to A's reflog, the diff, the commit in the graph, as they were.
  await back(page)
  await expect(repo).toHaveText(basename(a.dir))
  await expect(reflog).toBeVisible()
  await back(page)
  await expect(fileView).toBeVisible()
  await expect(reflog).toHaveCount(0)
  await back(page)
  await expect(fileView).toHaveCount(0)
  await expect(page.getByTestId('graph-scroll')).toBeVisible()
  await expect(row(page, older)).toHaveAttribute('data-selected', 'true')

  // Forward again, all the way to B; past the end nothing happens.
  await forward(page)
  await expect(fileView).toBeVisible()
  await forward(page)
  await expect(reflog).toBeVisible()
  await forward(page)
  await expect(repo).toHaveText(basename(b.dir))
  await forward(page)
  await expect(repo).toHaveText(basename(b.dir))

  // Typing: Alt+Left belongs to the text field (Option+Left moves by word on macOS).
  const summary = page.getByTestId('commit-summary')
  await summary.fill('half a message')
  await summary.press('Alt+ArrowLeft')
  await expect(repo).toHaveText(basename(b.dir))
  await expect(summary).toBeFocused()
  await expect(summary).toHaveValue('half a message')

  // The mouse's side buttons. (After a key, a click from the mouse within 150 ms would count as
  // the same click reported twice; wait that out, as a real hand would.)
  await page.waitForTimeout(200)
  await sideButton(page, 3)
  await expect(repo).toHaveText(basename(a.dir))
  await expect(reflog).toBeVisible()
  await sideButton(page, 4)
  await expect(repo).toHaveText(basename(b.dir))

  // On Windows and Linux the window reports the same click again as an app command, before or
  // after the page sees it: one click, one step. Both reports leave the main process together, as
  // they would for a real click.
  const backClickedTwice = (commandFirst: boolean) =>
    app.evaluate(({ BrowserWindow }, commandFirst) => {
      const win = BrowserWindow.getAllWindows()[0]!
      const command = () => win.emit('app-command', {}, 'browser-backward')
      const mouse = () => void win.webContents.executeJavaScript(
        `document.body.dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true }))`)
      if (commandFirst) command()
      mouse()
      if (!commandFirst) command()
    }, commandFirst)
  for (const commandFirst of [false, true]) {
    await page.waitForTimeout(200)
    await backClickedTwice(commandFirst)
    await expect(repo).toHaveText(basename(a.dir))
    await page.waitForTimeout(300)
    await expect(reflog).toBeVisible() // not on to the diff before it
    await forward(page)
    await expect(repo).toHaveText(basename(b.dir))
  }
  // On its own, the window's report navigates.
  await page.waitForTimeout(200)
  await app.evaluate(({ BrowserWindow }) => void BrowserWindow.getAllWindows()[0]!.emit('app-command', {}, 'browser-backward'))
  await expect(repo).toHaveText(basename(a.dir))
  await forward(page)
  await expect(repo).toHaveText(basename(b.dir))

  // And View → Back in the menu.
  await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()!.items.find((i) => i.label === 'View')!
    view.submenu!.items.find((i) => i.label === 'Back')!.click()
  })
  await expect(repo).toHaveText(basename(a.dir))
  await expect(reflog).toBeVisible()
  await app.close()
})
