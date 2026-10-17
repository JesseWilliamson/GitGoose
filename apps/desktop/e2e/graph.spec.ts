import { makeFixture, makeLargeRepo } from '@gitsquid/fixtures'
import { expect, test } from '@playwright/test'
import { launch } from './app'

test('loads history page by page as you scroll', async () => {
  const dir = makeLargeRepo(8000)
  const { app, page } = await launch(dir)
  const count = page.getByTestId('commit-count')
  await expect(count).toContainText('+')
  // Jump to the end with the keyboard; pages keep loading until the log is complete.
  await page.getByTestId('commit-row').first().click()
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('End')
    await page.waitForTimeout(200)
  }
  await expect(count).toHaveText(/^8,0\d\d commits$/)
  await app.close()
})

test('keeps the checked-out branch in the leftmost lane', async () => {
  const r = makeFixture('branches')
  r.checkout('wip') // F, an older side branch, is now HEAD
  const head = r.head()
  const { app, page } = await launch(r.dir)
  const row = page.locator(`[data-testid="commit-row"][data-hash="${head}"]`)
  await expect(row).toBeVisible()
  // laneX(0) = 6 + 16/2 = 14: the node sits in lane 0 even though newer commits come first.
  await expect(row.locator('svg circle').last()).toHaveAttribute('cx', '14')
  await app.close()
})

test('navigates with the keyboard and shows commit details', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').first().click()
  await expect(page.getByTestId('detail-panel')).toContainText('Commit 5')
  await page.keyboard.press('j')
  await page.keyboard.press('j')
  await expect(page.getByTestId('detail-panel')).toContainText('Commit 3')
  await page.keyboard.press('k')
  await expect(page.getByTestId('detail-panel')).toContainText('Commit 4')
  await app.close()
})

test('searches commits and steps through matches', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  const search = page.getByTestId('search-input')
  await page.locator('select[title="Search in"]').selectOption('path')
  await search.fill('.txt')
  await search.press('Enter')
  // 6, not 7: a path-limited log leaves out the merge commit M, which changes no file itself.
  await expect(page.getByTestId('search-count')).toHaveText('1 of 6')
  await search.press('Enter')
  await expect(page.getByTestId('search-count')).toHaveText('2 of 6')
  await page.locator('select[title="Search in"]').selectOption('message')
  await search.fill('nothing like this')
  await search.press('Enter')
  await expect(page.getByTestId('search-count')).toHaveText('No matches')
  await app.close()
})
