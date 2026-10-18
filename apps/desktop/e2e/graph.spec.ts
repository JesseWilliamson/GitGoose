import { makeFixture, makeLargeRepo } from '@gitsquid/fixtures'
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
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

test('keeps main in the leftmost lane whatever is checked out', async () => {
  const r = makeFixture('branches')
  r.checkout('wip') // F, an older side branch, is now HEAD
  r.write('notes.txt', 'draft\n') // an untracked file: the WIP row shows, and checkouts still work
  const main = r.git('rev-parse', 'main').trim()
  const { app, page } = await launch(r.dir)
  // laneX(n) = PAD + n * LANE_W + LANE_W / 2 = 6 + 24n + 12: lane 0 is x 18, lane 1 is x 42.
  const nodeX = (hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"] [data-testid="avatar-node"] circle`).first()
  await expect(nodeX(main)).toHaveAttribute('cx', '18')
  // HEAD sits next to main, and the WIP row above it in the same lane.
  await expect(nodeX(r.head())).toHaveAttribute('cx', '42')
  await expect(page.getByTestId('wip-node')).toHaveAttribute('data-lane', '1')

  // Checking out another branch moves only that branch; main stays put.
  const feature = r.git('rev-parse', 'feature').trim()
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/feature"]').dblclick()
  await expect.poll(() => r.git('rev-parse', 'HEAD').trim()).toBe(feature)
  await expect(nodeX(feature)).toHaveAttribute('cx', '42')
  await expect(nodeX(main)).toHaveAttribute('cx', '18')
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
  await page.getByTestId('commit-row').first().click()
  // The omni search hands a file search to the graph, where the matches stay bright.
  await page.keyboard.press('ControlOrMeta+f')
  await page.getByTestId('palette-input').fill('.txt')
  await page.getByTestId('omni-item').filter({ hasText: 'Commits that changed files matching' }).click()
  const search = page.getByTestId('search-input')
  await expect(search).toBeFocused()
  await expect(page.getByTestId('search-scope')).toHaveValue('path')
  // 6, not 7: a path-limited log leaves out the merge commit M, which changes no file itself.
  await expect(page.getByTestId('search-count')).toHaveText('1 of 6')
  await search.press('Enter')
  await expect(page.getByTestId('search-count')).toHaveText('2 of 6')
  await search.press('Shift+Enter')
  await expect(page.getByTestId('search-count')).toHaveText('1 of 6')
  await page.getByTestId('search-scope').selectOption('all')
  await search.fill('nothing like this')
  await expect(page.getByTestId('search-count')).toHaveText('No matches')
  await app.close()
})

test('one search matches messages, authors, SHAs, branches and tags, greying out the rest', async () => {
  const r = makeFixture('branches')
  r.git('tag', 'v2.0-beta', 'HEAD~1')
  const { app, page } = await launch(r.dir)
  const rows = page.getByTestId('commit-row')
  const dimmed = page.locator('[data-testid="commit-row"].opacity-35')
  await expect(rows).toHaveCount(7)
  await page.keyboard.press('ControlOrMeta+f')
  await page.getByTestId('palette-input').fill('wip')
  await page.getByTestId('omni-item').filter({ hasText: /Show all 1 matching commit in the graph/ }).click()
  const search = page.getByTestId('search-input')

  // A branch name: the commit it points at stays bright, everything else greys out.
  await expect(search).toHaveValue('wip')
  await expect(page.getByTestId('search-count')).toHaveText('1 of 1')
  await expect(dimmed).toHaveCount(6)
  await expect(page.getByTestId('detail-panel')).toContainText('F')

  // A tag name.
  await search.fill('v2.0')
  await expect(page.getByTestId('search-count')).toHaveText('1 of 1')
  // A SHA prefix.
  const sha = r.git('rev-parse', 'feature').trim()
  await search.fill(sha.slice(0, 8))
  await expect(page.getByTestId('search-count')).toHaveText('1 of 1')
  await expect(page.locator(`[data-testid="commit-row"][data-hash="${sha}"]`)).not.toHaveClass(/opacity-35/)
  // An author: every commit here is Ada's.
  await search.fill('ada@example')
  await expect(page.getByTestId('search-count')).toHaveText('1 of 7')
  await expect(dimmed).toHaveCount(0)

  // Esc closes the bar and the graph is whole again.
  await search.fill('wip')
  await expect(dimmed).toHaveCount(6)
  await search.press('Escape')
  await expect(page.getByTestId('search-bar')).toHaveCount(0)
  await expect(dimmed).toHaveCount(0)
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

test('the gear in the graph header shows and hides columns; the author column has no avatar', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  const header = page.getByTestId('graph-header')
  const row = page.getByTestId('commit-row').first()
  // GitKraken's defaults: branch / tag, graph and message.
  await expect(header).toContainText('Commit message')
  await expect(header).not.toContainText('SHA')
  await expect(row.getByTestId('author-cell')).toHaveCount(0)
  await page.getByTestId('graph-columns').click()
  await page.getByTestId('col-sha').click()
  await page.getByTestId('col-author').click()
  await page.keyboard.press('Escape')
  await expect(header).toContainText('SHA')
  // The graph node is the author's avatar, so the author column is just the name.
  await expect(row.getByTestId('author-cell')).toHaveText('Ada Lovelace')
  await expect(row.getByTestId('author-cell').locator('img, svg')).toHaveCount(0)
  await expect.poll(async () => (await page.evaluate(() => window.gitsquid.getSettings())).graphColumns)
    .toEqual({ refs: true, graph: true, author: true, date: false, sha: true })
  await page.getByTestId('graph-columns').click()
  await page.getByRole('menuitem', { name: 'Reset columns' }).click()
  await expect(header).not.toContainText('SHA')
  await app.close()
})

test('GitKraken look: pills joined to their node, recent times inline, far lanes pinned, viewing count', async () => {
  const r = makeFixture('linear')
  for (let i = 0; i < 12; i++) {
    r.checkout('-b', `b${i}`, 'main~4')
    r.commit(`work on b${i}`, { [`b${i}.txt`]: 'x\n' })
  }
  r.checkout('main')
  // A commit made now (fixture commits are from 2023): its time shows in the message cell.
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'just now'], {
    cwd: r.dir, env: { ...process.env, GIT_AUTHOR_NAME: 'Ada Lovelace', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada Lovelace', GIT_COMMITTER_EMAIL: 'ada@example.com' },
  })
  const { app, page } = await launch(r.dir)
  const head = page.locator(`[data-testid="commit-row"][data-hash="${r.head()}"]`)
  await expect(head.getByTestId('row-time')).toHaveText(/just now|min ago/)
  await expect(head.getByTestId('ref-line')).toHaveCount(1)
  const plain = page.getByTestId('commit-row').filter({ hasText: 'Commit 4' })
  await expect(plain.getByTestId('ref-line')).toHaveCount(0)
  await expect(plain.getByTestId('row-time')).toHaveCount(0)
  // Thirteen lanes in a column sized for eight: the far nodes stay visible at the edge.
  const far = page.locator('[data-testid="commit-row"] svg[data-offscreen]').first()
  await expect(far).toBeVisible()
  // Faded rather than ringed with dashes; every row also gets its lane band.
  await expect(far.locator('g[opacity="0.45"] [data-testid="avatar-node"]')).toHaveCount(1)
  await expect(far.locator('[stroke-dasharray]')).toHaveCount(0)
  await expect(plain.getByTestId('lane-band')).toHaveCount(1)
  // Band and strip stop 2px short of the row's top and bottom, so stacked commits read as separate blocks.
  await expect(plain.getByTestId('lane-band')).toHaveAttribute('y', '2')
  await expect(plain.getByTestId('lane-band')).toHaveAttribute('height', '28')
  await expect(plain.getByTestId('lane-strip')).toHaveAttribute('y', '2')
  await expect(page.getByTestId('sidebar-viewing')).toHaveText('Viewing 13/13')
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/b3"]').hover()
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/b3"]').getByTestId('toggle-hidden').click()
  await expect(page.getByTestId('sidebar-viewing')).toContainText('Viewing 12/13')
  await page.getByTestId('sidebar-viewing').getByRole('button', { name: 'Show all' }).click()
  await expect(page.getByTestId('sidebar-viewing')).toHaveText('Viewing 13/13')
  await app.close()
})

test('Ctrl+P opens the search on commands only; Ctrl+K and Ctrl+F on everything', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').first().click()
  await page.keyboard.press('ControlOrMeta+p')
  const input = page.getByTestId('palette-input')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('> ')
  await expect(page.getByTestId('omni-scope-command')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  for (const key of ['ControlOrMeta+k', 'ControlOrMeta+f']) {
    await page.keyboard.press(key)
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('')
    await page.keyboard.press('Escape')
  }
  await app.close()
})
