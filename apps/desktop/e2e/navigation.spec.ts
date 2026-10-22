import { FixtureRepo, makeFixture, makeLargeRepo } from '@gitgoose/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { basename, delimiter } from 'node:path'
import { launch } from './app'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
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

test('after a rewrite, back shows the rewritten commit and its diff, not the stale copy', async () => {
  const r = makeFixture('linear')
  const before = r.head()
  const { app, page } = await launch(r.dir)
  await row(page, before).click()
  await page.getByTestId('commit-file').first().click()
  await expect(page.getByTestId('file-view')).toContainText(`in ${before.slice(0, 7)}`)
  await page.getByTestId('open-reflog').click()
  await expect(page.getByTestId('reflog')).toBeVisible()

  // Amended outside the app: same author date and subject, new hash.
  r.git('commit', '-q', '--amend', '--no-edit', '--allow-empty')
  const after = r.head()
  expect(after).not.toBe(before)
  // The app has noticed once the reflog lists it (the log is walked again with it).
  await expect(page.locator(`[data-testid="reflog-row"][data-hash="${after}"]`).first()).toBeVisible()

  await back(page)
  await expect(page.getByTestId('file-view')).toContainText(`in ${after.slice(0, 7)}`)
  await back(page)
  await expect(row(page, after)).toHaveAttribute('data-selected', 'true')
  await app.close()
})

test('back to a commit the refreshed log has not loaded yet loads it and shows it selected', async () => {
  // More than one page of history: a refresh reloads only as far as the first 3,000 commits.
  const dir = makeLargeRepo(4000)
  const r = new FixtureRepo(dir)
  const root = r.git('rev-list', '--max-parents=0', 'HEAD').trim()
  const { app, page } = await launch(dir)
  const count = page.getByTestId('commit-count')
  await expect(count).toContainText('+')
  // Down to the oldest commit, loading every page on the way.
  await page.getByTestId('commit-row').first().click()
  for (let i = 0; i < 20 && !(await row(page, root).isVisible()); i++) {
    await page.keyboard.press('End')
    await page.waitForTimeout(200)
  }
  await row(page, root).click()
  await expect(row(page, root)).toHaveAttribute('data-selected', 'true')
  await expect(count).not.toContainText('+')
  await page.getByTestId('open-reflog').click()
  await expect(page.getByTestId('reflog')).toBeVisible()

  // Something outside the app changes the refs: the log is walked again, first page only.
  r.git('branch', 'elsewhere')
  await expect(count).toHaveText(/^3,000\+ commits$/)

  await back(page)
  await expect(page.getByTestId('graph-scroll')).toBeVisible()
  await expect(row(page, root)).toHaveAttribute('data-selected', 'true')

  // The line view's anchor is loaded the same way: the line through the root, with the cursor
  // moved up to HEAD, must come back as the line through the root, not through the cursor.
  await row(page, root).click()
  await page.keyboard.press(`${mod}+l`)
  await expect(page.getByTestId('line-bar')).toContainText(root.slice(0, 7))
  await page.keyboard.press('Home')
  await expect(row(page, r.head())).toHaveAttribute('data-selected', 'true')
  await expect(page.getByTestId('line-bar')).toContainText(root.slice(0, 7))
  await page.getByTestId('open-reflog').click()
  await expect(page.getByTestId('reflog')).toBeVisible()
  r.git('branch', 'elsewhere-too')
  await expect(count).toHaveText(/^3,000\+ commits$/)

  await back(page)
  await expect(page.getByTestId('line-bar')).toContainText(root.slice(0, 7))
  await app.close()
})
