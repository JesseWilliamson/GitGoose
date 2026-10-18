import { initRepo } from '@gitsquid/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { launch } from './app'

/**   main:  A - B        topic (from A):  X - Y - Z   */
function setup() {
  const r = initRepo()
  const A = r.commit('A', { 'a.txt': 'a\n' })
  r.commit('B', { 'b.txt': 'b\n' })
  r.git('checkout', '-q', '-b', 'topic', A)
  const X = r.commit('X', { 'x.txt': 'x\n' })
  const Y = r.commit('Y', { 'y.txt': 'y\n' })
  const Z = r.commit('Z', { 'z.txt': 'z\n' })
  r.checkout('main')
  return { r, X, Y, Z }
}

const row = (page: Page, hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)
const selected = (page: Page) => page.locator('[data-testid="commit-row"].bg-select')

test('shift-click selects a range, ctrl-click adds and removes; cherry-pick them all, undoably', async () => {
  const { r, X, Y, Z } = setup()
  const before = r.head()
  const { app, page } = await launch(r.dir)
  await row(page, Z).click()
  await row(page, X).click({ modifiers: ['Shift'] })
  await expect(selected(page)).toHaveCount(3)
  await expect(page.getByTestId('multi-panel')).toContainText('3 commits selected')
  // Ctrl-click takes Y out of the selection.
  await row(page, Y).click({ modifiers: ['ControlOrMeta'] })
  await expect(selected(page)).toHaveCount(2)
  await expect(page.getByTestId('multi-panel')).toContainText('2 commits selected')
  // Z and X do not follow each other: the panel lists the files either one touched.
  await expect(page.getByTestId('multi-commit')).toHaveCount(2)
  await expect(page.getByTestId('multi-file')).toHaveCount(2)
  await expect(page.getByTestId('multi-panel')).toContainText('Files they touch')

  // Actions live in the right-click menu, not the panel.
  await row(page, Z).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Cherry-pick 2 commits/ }).click()
  await expect.poll(() => r.git('log', '--format=%s', `${before}..main`).trim()).toBe('Z\nX')
  // One undo entry for both.
  await page.getByTestId('toolbar').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => r.head()).toBe(before)
  await app.close()
})

test('the right-click menu acts on the whole selection; patches copy to the clipboard', async () => {
  const { r, X, Y, Z } = setup()
  const { app, page } = await launch(r.dir)
  await row(page, Z).click()
  // Shift+arrows grow the selection like Shift-click.
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(selected(page)).toHaveCount(3)
  // Consecutive commits: one combined diff, and clicking a file shows its change across all three.
  await expect(page.getByTestId('multi-panel')).toContainText('Combined changes')
  await expect(page.getByTestId('multi-file')).toHaveCount(3)
  await page.getByTestId('multi-file').filter({ hasText: 'y.txt' }).click()
  await expect(page.getByTestId('file-view')).toContainText('y.txt')
  await page.keyboard.press('Escape')
  await row(page, Y).click({ button: 'right' })
  await expect(page.getByRole('menu')).toContainText('3 commits selected')
  await page.getByRole('menuitem', { name: 'Copy as patch' }).click()
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('[PATCH 3/3] Z')
  const text = await app.evaluate(({ clipboard }) => clipboard.readText())
  expect(text).toContain('[PATCH 1/3] X')
  expect(text.indexOf(X)).toBeLessThan(text.indexOf(Z))

  // A plain click goes back to one commit.
  await row(page, Y).click()
  await expect(selected(page)).toHaveCount(1)
  await expect(page.getByTestId('multi-panel')).toHaveCount(0)
  await app.close()
})
