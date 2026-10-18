import { makeFixture, makeLargeRepo } from '@gitgoose/fixtures'
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
  const nodeX = (hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"] [data-testid="commit-node"] circle`).last()
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

test('Ctrl+F is the omni search; a commit result selects it, and there is no second search bar', async () => {
  const r = makeFixture('branches')
  r.git('tag', 'v2.0-beta', 'HEAD~1')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').first().click()
  await page.keyboard.press('ControlOrMeta+f')
  const input = page.getByTestId('palette-input')
  await expect(input).toBeFocused()
  await input.fill('wip')
  // No "Search history" actions that would open a bar over the graph.
  await expect(page.getByTestId('omni-item').filter({ hasText: /in the graph/ })).toHaveCount(0)
  await page.getByTestId('omni-item').filter({ hasText: 'wip' }).first().click()
  await expect(page.getByTestId('search-bar')).toHaveCount(0)
  await expect(page.getByTestId('detail-panel')).toContainText('F')
  await expect(page.locator('[data-testid="commit-row"].opacity-35')).toHaveCount(0)
  await app.close()
})

test('a co-authored commit stacks the avatars and names everyone on the row', async () => {
  const r = makeFixture('linear')
  r.commit('Pair work\n\nCo-authored-by: Grace Hopper <grace@example.com>\nCo-authored-by: Alan Turing <alan@example.com>')
  const { app, page } = await launch(r.dir)
  const row = page.getByTestId('commit-row').filter({ hasText: 'Pair work' }).first()
  await expect(row.getByTestId('row-author')).toHaveText('Ada Lovelace, Grace Hopper and Alan Turing')
  // One avatar each, the author's first: initials show while (or instead of) the images load.
  const stack = row.getByTestId('row-avatar')
  await expect(stack.getByTitle('Ada Lovelace <ada@example.com>')).toBeVisible()
  await expect(stack.getByTitle('Grace Hopper <grace@example.com>')).toBeVisible()
  await expect(stack.getByTitle('Alan Turing <alan@example.com>')).toBeVisible()
  // A commit with one author is unchanged: one avatar, the name on its own.
  const plain = page.getByTestId('commit-row').filter({ hasText: 'Commit 4' }).first()
  await expect(plain.getByTestId('row-author')).toHaveText('Ada Lovelace')
  await expect(plain.getByTestId('row-avatar').locator('[title]')).toHaveCount(1)
  await app.close()
})

test('Tower look: two-line rows beside hollow nodes, text indented by the lanes, month headings', async () => {
  const r = makeFixture('linear')
  for (let i = 0; i < 12; i++) {
    r.checkout('-b', `b${i}`, 'main~4')
    r.commit(`work on b${i}`, { [`b${i}.txt`]: 'x\n' })
  }
  r.checkout('main')
  // A commit made now (fixture commits are from 2023): it opens a month of its own.
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'just now'], {
    cwd: r.dir, env: { ...process.env, GIT_AUTHOR_NAME: 'Ada Lovelace', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada Lovelace', GIT_COMMITTER_EMAIL: 'ada@example.com' },
  })
  const { app, page } = await launch(r.dir)
  const head = page.locator(`[data-testid="commit-row"][data-hash="${r.head()}"]`)
  // Author and refs on the first line, hash and subject on the second; the avatar is HTML beside them.
  await expect(head.getByTestId('row-author')).toHaveText('Ada Lovelace')
  await expect(head.getByTestId('row-sha')).toHaveText(r.head().slice(0, 7))
  await expect(head.getByTestId('row-avatar')).toContainText('AL')
  await expect(head.locator('[data-testid="ref-pill"][data-ref="refs/heads/main"]')).toBeVisible()
  // The newest commit opens this month; the 2023 commits open another heading further down.
  await expect(head.getByTestId('month-header')).toHaveText(new RegExp(String(new Date().getFullYear())))
  const plain = page.getByTestId('commit-row').filter({ hasText: 'Commit 4' })
  await expect(plain.getByTestId('month-header')).toHaveCount(0)
  // A row with a heading is taller by the heading, and its node sits in the lower part.
  expect((await head.boundingBox())!.height).toBe(52 + 26)
  await expect(head.locator('[data-testid="commit-node"] circle').last()).toHaveAttribute('cy', String(26 + 26))
  // Nodes are hollow: the page colour inside, the lane colour as the ring.
  await expect(plain.locator('[data-testid="commit-node"] circle').last()).toHaveAttribute('fill', 'var(--gs-bg)')
  // Thirteen lanes where the text moves aside for twelve: a node past the last lane is left out
  // rather than pinned at the edge, where it would sit on another branch's line.
  const far = page.locator('[data-testid="commit-row"] svg[data-offscreen]').first()
  await expect(far).toBeVisible()
  await expect(far.locator('[data-testid="commit-node"]')).toHaveCount(0)
  // Text starts further right where more lanes are open: cellWidth(lanes) = 6 + min(12, max(2, lanes)) * 24.
  // The busiest row is the last of the twelve branch tips the log lists (every other tip's line
  // passes through it); which tip that is depends on the log order, so take the widest. The
  // quiet row is HEAD: newest, so above every tip, with nothing open beside it. (The branches
  // fork from the root, so every older row has their lines running through it.)
  const busyX = Math.max(...await page.locator('[data-testid="commit-row"]:has-text("work on b") [data-testid="row-body"]')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().x)))
  expect(busyX).toBeGreaterThan((await head.getByTestId('row-body').boundingBox())!.x + 100)
  await expect(page.getByTestId('sidebar-viewing')).toHaveText('Viewing 13/13')
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/b3"]').hover()
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/b3"]').getByTestId('toggle-hidden').click()
  await expect(page.getByTestId('sidebar-viewing')).toContainText('Viewing 12/13')
  await page.getByTestId('sidebar-viewing').getByRole('button', { name: 'Show all' }).click()
  await expect(page.getByTestId('sidebar-viewing')).toHaveText('Viewing 13/13')
  await app.close()
})

test('GitKraken look: one-line rows in fixed columns, avatar nodes, pills joined to the node, a column menu', async () => {
  const r = makeFixture('linear')
  for (let i = 0; i < 12; i++) {
    r.checkout('-b', `b${i}`, 'main~4')
    r.commit(`work on b${i}`, { [`b${i}.txt`]: 'x\n' })
  }
  r.checkout('main')
  const { app, page } = await launch(r.dir)
  await page.evaluate(() => window.gitgoose.setSettings({ graphStyle: 'compact' }))
  // A header names the columns; the gear at its end picks them (message always shows).
  const header = page.getByTestId('graph-header')
  await expect(header).toContainText('Branch / Tag')
  await expect(header).toContainText('Graph')
  await expect(header).toContainText('Commit message')
  const head = page.locator(`[data-testid="commit-row"][data-hash="${r.head()}"]`)
  await expect.poll(async () => (await head.boundingBox())!.height).toBe(32)
  // The node is the author's avatar (initials until an image loads), ringed in the lane colour;
  // the branch pill sits in the first column, joined to the node by a line.
  await expect(head.locator('[data-testid="avatar-node"] text')).toHaveText('AL')
  await expect(head.getByTestId('refs-cell').locator('[data-testid="ref-pill"][data-ref="refs/heads/main"]')).toBeVisible()
  await expect(head.locator('svg [data-testid="ref-line"]')).toHaveCount(1)
  // A commit without refs has no connector, and its first column is empty.
  const plain = page.getByTestId('commit-row').filter({ hasText: 'Commit 3' })
  await expect(plain.locator('svg [data-testid="ref-line"]')).toHaveCount(0)
  await expect(plain.getByTestId('row-avatar')).toHaveCount(0)
  // Fixed columns: the message starts at the same x on a busy row as on a quiet one.
  const busy = page.getByTestId('commit-row').filter({ hasText: 'work on b0' })
  expect((await busy.getByTestId('row-message').boundingBox())!.x).toBe((await plain.getByTestId('row-message').boundingBox())!.x)
  // The graph column fits eight lanes by default (8 * 24 + 12 = 204); thirteen are open, so
  // the header says some are hidden, and dragging its edge widens the column.
  const graphSvg = plain.locator('svg[data-node]')
  await expect(graphSvg).toHaveAttribute('width', '204')
  await expect(header.getByTitle('Some lanes are hidden; drag the edge to widen')).toBeVisible()
  const grip = (await page.getByTestId('graph-resizer').boundingBox())!
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 + 100, grip.y + grip.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect(graphSvg).toHaveAttribute('width', '304')
  // The column menu: turning the first column off removes the pills' column and their connector.
  await page.getByTestId('graph-columns').click()
  await page.getByTestId('col-refs').click()
  await page.keyboard.press('Escape')
  await expect(head.getByTestId('refs-cell')).toHaveCount(0)
  await expect(head.locator('svg [data-testid="ref-line"]')).toHaveCount(0)
  await expect(header).not.toContainText('Branch / Tag')
  // Back to two-line rows from the same menu.
  await page.getByTestId('graph-columns').click()
  await page.getByRole('menuitem', { name: 'Two-line rows (Tower)' }).click()
  await expect(header).toHaveCount(0)
  await expect(head.getByTestId('row-avatar')).toContainText('AL')
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
