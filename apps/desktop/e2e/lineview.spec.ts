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

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('Mod+L: only the selected line shows, and the selected row stays where it was', async () => {
  const { r, A, B, X, Y, Z } = setup()
  const { app, page } = await launch(r.dir)
  await row(page, Y).click()
  const y = await top(page, Y)

  // Holding Shift is only for Shift-click and Shift+arrows now: it does not collapse the graph.
  await page.keyboard.down('Shift')
  await page.waitForTimeout(300)
  await expect(page.getByTestId('line-bar')).toHaveCount(0)
  await page.keyboard.up('Shift')

  await page.keyboard.press(`${mod}+l`)
  await expect(page.getByTestId('line-bar')).toContainText(`Showing the line through ${Y.slice(0, 7)} · 1 commit hidden · Esc to show all`)
  for (const h of [Z, Y, X, A]) await expect(row(page, h)).toBeVisible()
  await expect(row(page, B)).toHaveCount(0)
  expect(await top(page, Y)).toBe(y)

  await page.keyboard.press(`${mod}+l`)
  await expect(page.getByTestId('line-bar')).toHaveCount(0)
  await expect(row(page, B)).toBeVisible()
  expect(await top(page, Y)).toBe(y)

  // A is the fifth row of all, the second of its line (B, A): three rows above it go away, and
  // A must still not move (the list makes room above the line instead of scrolling past its top).
  await row(page, A).click()
  const a = await top(page, A)
  await page.keyboard.press(`${mod}+l`)
  await expect(page.getByTestId('line-bar')).toContainText(`through ${A.slice(0, 7)} · 3 commits hidden`)
  await expect(row(page, Z)).toHaveCount(0)
  expect(await top(page, A)).toBe(a)
  expect(await top(page, B)).toBe(a - (await row(page, A).boundingBox())!.height)
  await page.keyboard.press('Escape')
  await expect(row(page, Z)).toBeVisible()
  expect(await top(page, A)).toBe(a)
  await app.close()
})

test('a Shift-click inside the line view selects along the line, and keeps the line', async () => {
  const { r, Y, Z } = setup()
  const { app, page } = await launch(r.dir)
  await row(page, Y).click()
  await page.keyboard.press(`${mod}+l`)
  await expect(page.getByTestId('line-bar')).toBeVisible()
  await row(page, Z).click({ modifiers: ['Shift'] })
  await expect(selected(page)).toHaveCount(2)
  for (const h of [Y, Z]) await expect(row(page, h)).toHaveAttribute('data-selected', 'true')
  // Still the line through Y, not through the new cursor.
  await expect(page.getByTestId('line-bar')).toContainText(Y.slice(0, 7))
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

test('the line is drawn in the first lane, however far right the branch was in the full graph', async () => {
  const { r, A, B, Y } = setup()
  const { app, page } = await launch(r.dir)
  // laneX(n) = 6 + 24n + 12: lane 0 is x 18. In the full graph topic's commits sit next to main's.
  const node = (hash: string) => row(page, hash).locator('[data-testid="commit-node"] circle, [data-testid="avatar-node"] circle').first()
  await expect(node(B)).toHaveAttribute('cx', '18')
  await expect(node(Y)).not.toHaveAttribute('cx', '18')

  await row(page, Y).click()
  await page.keyboard.press(`${mod}+l`)
  await expect(page.getByTestId('line-bar')).toBeVisible()
  await expect(node(Y)).toHaveAttribute('cx', '18')
  await expect(node(A)).toHaveAttribute('cx', '18')

  await page.keyboard.press('Escape')
  await expect(row(page, B)).toBeVisible()
  await expect(node(Y)).not.toHaveAttribute('cx', '18')
  await app.close()
})
