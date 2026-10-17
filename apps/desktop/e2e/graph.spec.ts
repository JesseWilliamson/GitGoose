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
  // laneX(0) = PAD + LANE_W/2 = 6 + 24/2 = 18: the node sits in lane 0 even though newer commits come first.
  await expect(row.locator('[data-testid="avatar-node"] circle').first()).toHaveAttribute('cx', '18')
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

test('caps the graph column on wide histories and lets the user resize it', async () => {
  // Twelve branches whose lanes are all open at once.
  const r = makeFixture('linear')
  for (let i = 0; i < 12; i++) {
    r.checkout('-b', `b${i}`, 'main~4')
    r.commit(`work on b${i}`, { [`b${i}.txt`]: 'x\n' })
  }
  r.checkout('main')
  const { app, page } = await launch(r.dir)
  const header = page.getByTestId('graph-resizer').locator('..')
  await expect(header).toBeVisible()
  const auto = (await header.boundingBox())!.width
  expect(auto).toBeLessThanOrEqual(8 * 24 + 12 + 1) // AUTO_LANES * LANE_W + padding
  const handle = (await page.getByTestId('graph-resizer').boundingBox())!
  await page.mouse.move(handle.x + 2, handle.y + 5)
  await page.mouse.down()
  await page.mouse.move(handle.x + 102, handle.y + 5, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await header.boundingBox())!.width).toBeGreaterThan(auto + 90)
  await page.getByTestId('graph-resizer').dblclick()
  await expect.poll(async () => (await header.boundingBox())!.width).toBeCloseTo(auto, 0)
  await app.close()
})

test('the gear in the graph header hides and shows columns; the author column has no avatar', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  const header = page.getByTestId('graph-header')
  const row = page.getByTestId('commit-row').first()
  await expect(header).toContainText('SHA')
  // The graph node is the author's avatar, so the author column is just the name.
  await expect(row.getByTestId('author-cell')).toHaveText('Ada Lovelace')
  await expect(row.getByTestId('author-cell').locator('img, svg')).toHaveCount(0)
  await page.getByTestId('graph-columns').click()
  await page.getByTestId('col-sha').click()
  await page.getByTestId('col-author').click()
  await page.keyboard.press('Escape')
  await expect(header).not.toContainText('SHA')
  await expect(header).not.toContainText('Author')
  await expect(row.getByTestId('author-cell')).toHaveCount(0)
  await expect.poll(async () => (await page.evaluate(() => window.gitsquid.getSettings())).graphColumns)
    .toEqual({ refs: true, graph: true, author: false, date: true, sha: false })
  await page.getByTestId('graph-columns').click()
  await page.getByRole('menuitem', { name: 'Reset columns' }).click()
  await expect(header).toContainText('SHA')
  await app.close()
})

test('Ctrl+P opens the command palette and Ctrl+F the search', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').first().click()
  await page.keyboard.press('Control+p')
  await expect(page.getByTestId('palette-input')).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+f')
  await expect(page.getByTestId('search-input')).toBeFocused()
  await app.close()
})
