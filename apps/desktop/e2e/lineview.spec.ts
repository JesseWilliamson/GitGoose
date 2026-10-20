import { initRepo } from '@gitgoose/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { launch } from './app'

/** main: A - B        topic (from A): X - Y - Z   (the multiselect fixture) */
function setup() {
  const r = initRepo()
  const A = r.commit('A', { 'a.txt': 'a\n' })
  const B = r.commit('B', { 'b.txt': 'b\n' })
  r.git('checkout', '-q', '-b', 'topic', A)
  const X = r.commit('X', { 'x.txt': 'x\n' })
  const Y = r.commit('Y', { 'y.txt': 'y\n' })
  const Z = r.commit('Z', { 'z.txt': 'z\n' })
  r.checkout('main')
  return { r, A, B, X, Y, Z }
}

const row = (page: Page, hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)
const selected = (page: Page) => page.locator('[data-testid="commit-row"][data-selected]')
const top = async (page: Page, hash: string) => (await row(page, hash).boundingBox())!.y

test('hold Shift: only the selected line shows, and the selected row stays where it was', async () => {
  const { r, A, B, X, Y, Z } = setup()
  const { app, page } = await launch(r.dir)
  await row(page, Y).click()
  const y = await top(page, Y)

  // A tap is not a hold.
  await page.keyboard.press('Shift')
  await page.waitForTimeout(300)
  await expect(page.getByTestId('line-bar')).toHaveCount(0)

  await page.keyboard.down('Shift')
  await expect(page.getByTestId('line-bar')).toContainText(`Showing the line through ${Y.slice(0, 7)} · 1 commit hidden · release Shift to show all`)
  for (const h of [Z, Y, X, A]) await expect(row(page, h)).toBeVisible()
  await expect(row(page, B)).toHaveCount(0)
  expect(await top(page, Y)).toBe(y)

  await page.keyboard.up('Shift')
  await expect(page.getByTestId('line-bar')).toHaveCount(0)
  await expect(row(page, B)).toBeVisible()
  expect(await top(page, Y)).toBe(y)

  // A is the fifth row of all, the second of its line (B, A): three rows above it go away, and
  // A must still not move (the list makes room above the line instead of scrolling past its top).
  await row(page, A).click()
  const a = await top(page, A)
  await page.keyboard.down('Shift')
  await expect(page.getByTestId('line-bar')).toContainText(`through ${A.slice(0, 7)} · 3 commits hidden`)
  await expect(row(page, Z)).toHaveCount(0)
  expect(await top(page, A)).toBe(a)
  expect(await top(page, B)).toBe(a - (await row(page, A).boundingBox())!.height)
  await page.keyboard.up('Shift')
  await expect(row(page, Z)).toBeVisible()
  expect(await top(page, A)).toBe(a)
  await app.close()
})

test('a Shift-click inside the line view selects along the line; leaving the window lets go', async () => {
  const { r, B, Y, Z } = setup()
  const { app, page } = await launch(r.dir)
  await row(page, Y).click()
  await page.keyboard.down('Shift')
  await expect(page.getByTestId('line-bar')).toBeVisible()
  // Shift is still held: this is a Shift-click.
  await row(page, Z).click()
  await expect(selected(page)).toHaveCount(2)
  for (const h of [Y, Z]) await expect(row(page, h)).toHaveAttribute('data-selected', 'true')
  // Still the line through Y, not through the new cursor.
  await expect(page.getByTestId('line-bar')).toContainText(Y.slice(0, 7))

  // A Shift released in another window never arrives: losing focus must not leave it collapsed.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(page.getByTestId('line-bar')).toHaveCount(0)
  await expect(row(page, B)).toBeVisible()
  await page.keyboard.up('Shift')
  await app.close()
})

test('View → Line View keeps the line until Esc; the uncommitted changes show only on HEAD\'s line', async () => {
  const { r, A, B, Y } = setup()
  r.write('a.txt', 'changed\n')
  const { app, page } = await launch(r.dir)
  const lineView = () => app.evaluate(({ BrowserWindow, Menu }) => {
    const view = Menu.getApplicationMenu()!.items.find((i) => i.label === 'View')!.submenu!
    view.items.find((i) => i.label === 'Line View')!.click(undefined, BrowserWindow.getAllWindows()[0])
  })
  await expect(page.getByTestId('wip-row')).toBeVisible()
  await row(page, Y).click()
  await lineView()
  await expect(page.getByTestId('line-bar')).toContainText('Esc to show all')
  await expect(row(page, B)).toHaveCount(0)
  // HEAD (main, at B) is not on topic's line, so neither are the changes waiting to go on top of it.
  await expect(page.getByTestId('wip-row')).toHaveCount(0)
  // Holding and releasing Shift does not undo a pinned line.
  await page.keyboard.down('Shift')
  await page.waitForTimeout(300)
  await page.keyboard.up('Shift')
  await expect(page.getByTestId('line-bar')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('line-bar')).toHaveCount(0)
  await expect(row(page, B)).toBeVisible()

  // On HEAD's own line the changes stay, joined to HEAD.
  await row(page, A).click()
  await lineView()
  await expect(page.getByTestId('line-bar')).toContainText(`through ${A.slice(0, 7)}`)
  await expect(page.getByTestId('wip-row')).toBeVisible()
  await expect(row(page, B)).toBeVisible()
  await expect(row(page, Y)).toHaveCount(0)
  // The menu item toggles it off again.
  await lineView()
  await expect(row(page, Y)).toBeVisible()
  await app.close()
})
