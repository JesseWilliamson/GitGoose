import { initRepo, makeFixture, makeLargeRepo } from '@gitgoose/fixtures'
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

/**   main:  A - B        topic (on B):  X - Y - Z   */
function onTop() {
  const r = initRepo()
  r.commit('A', { 'a.txt': 'a\n' })
  const B = r.commit('B', { 'b.txt': 'b\n' })
  r.git('checkout', '-q', '-b', 'topic')
  const topic = [r.commit('X', { 'x.txt': 'x\n' }), r.commit('Y', { 'y.txt': 'y\n' }), r.commit('Z', { 'z.txt': 'z\n' })]
  return { r, B, topic }
}

test('a branch on top of main goes straight up instead of out to the right', async () => {
  // topic checked out, nothing uncommitted: Z, Y, X and B are one straight line in lane 0.
  const { r, B, topic } = onTop()
  const { app, page } = await launch(r.dir)
  const lane = (hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)
  for (const h of [...topic, B]) await expect(lane(h)).toHaveAttribute('data-lane', '0')
  await expect(page.getByTestId('wip-node')).toHaveCount(0)
  // The node circles agree (laneX(0) = 18).
  await expect(lane(topic[2]!).locator('[data-testid="commit-node"] circle').last()).toHaveAttribute('cx', '18')
  await app.close()
})

test('with main checked out and a change, the WIP line runs straight up from main; the branch on top goes beside it', async () => {
  const { r, B, topic } = onTop()
  r.checkout('main')
  r.write('notes.txt', 'draft\n')
  const { app, page } = await launch(r.dir)
  const row = (hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)
  for (const h of topic) await expect(row(h)).toHaveAttribute('data-lane', '1')
  await expect(row(B)).toHaveAttribute('data-lane', '0')
  // The WIP node sits above, in HEAD's lane (0), and its dashed line never leaves it
  // (laneX(0) = 18): straight down every row and straight into B.
  await expect(page.getByTestId('wip-node')).toHaveAttribute('data-lane', '0')
  const dashed = (hash: string) => row(hash).locator('path[stroke-dasharray="3 4"]')
  for (const h of topic) await expect(dashed(h)).toHaveAttribute('d', /^M18 0V\d+$/)
  await expect(dashed(B)).toHaveAttribute('d', /^M18 0V\d+$/)
  await expect(page.locator('path[stroke-dasharray="3 4"][d*="C"]')).toHaveCount(0)
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
  await expect(row.getByTestId('row-author')).toHaveAttribute('aria-label', 'Ada Lovelace, Grace Hopper and Alan Turing')
  // One avatar each, the author's first: initials show while (or instead of) the images load.
  const stack = row.getByTestId('row-avatar')
  await expect(stack.getByTitle('Ada Lovelace <ada@example.com>')).toBeVisible()
  await expect(stack.getByTitle('Grace Hopper <grace@example.com>')).toBeVisible()
  await expect(stack.getByTitle('Alan Turing <alan@example.com>')).toBeVisible()
  // A commit with one author is unchanged: one avatar, the name on its own.
  const plain = page.getByTestId('commit-row').filter({ hasText: 'Commit 4' }).first()
  await expect(plain.getByTestId('row-author')).toHaveAttribute('aria-label', 'Ada Lovelace')
  await expect(plain.getByTestId('row-avatar').locator('[title]')).toHaveCount(1)
  await app.close()
})

test('one line per commit beside hollow nodes, text indented by the lanes, no month headings', async () => {
  const r = makeFixture('linear')
  for (let i = 0; i < 12; i++) {
    r.checkout('-b', `b${i}`, 'main~4')
    r.commit(`work on b${i}`, { [`b${i}.txt`]: 'x\n' })
  }
  r.checkout('main')
  // A commit made now (fixture commits are from 2023): a new month, which once got a heading.
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'just now'], {
    cwd: r.dir, env: { ...process.env, GIT_AUTHOR_NAME: 'Ada Lovelace', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada Lovelace', GIT_COMMITTER_EMAIL: 'ada@example.com' },
  })
  const { app, page } = await launch(r.dir)
  const head = page.locator(`[data-testid="commit-row"][data-hash="${r.head()}"]`)
  // Refs, subject, then the author's avatar and name; HEAD starts selected, so it shows its SHA.
  await expect(head.getByTestId('row-author')).toHaveAttribute('aria-label', 'Ada Lovelace')
  await expect(head.getByTestId('row-sha')).toHaveText(r.head().slice(0, 7))
  await expect(head.getByTestId('row-avatar')).toContainText('AL')
  await expect(head.locator('[data-testid="ref-pill"][data-ref="refs/heads/main"]')).toBeVisible()
  // No month headings: the first row of a month is as tall as any other, its node centred.
  const plain = page.getByTestId('commit-row').filter({ hasText: 'Commit 4' })
  expect((await head.boundingBox())!.height).toBe(28)
  expect((await plain.boundingBox())!.height).toBe(28)
  await expect(head.locator('[data-testid="commit-node"] circle').last()).toHaveAttribute('cy', '14')
  await expect(page.getByTestId('month-header')).toHaveCount(0)
  // Nodes are hollow: the page colour inside, the lane colour as the ring.
  await expect(plain.locator('[data-testid="commit-node"] circle').last()).toHaveAttribute('fill', 'var(--gs-bg)')
  // Thirteen lanes where the text moves aside for eight: a node past the last lane is left out
  // rather than pinned at the edge, where it would sit on another branch's line.
  const far = page.locator('[data-testid="commit-row"] svg[data-offscreen]').first()
  await expect(far).toBeVisible()
  await expect(far.locator('[data-testid="commit-node"]')).toHaveCount(0)
  // Text starts further right where more lanes are open, but never further than 166 px in:
  // cellWidth(lanes) = 6 + the first four lanes at 24 px + the next four at 16 px (at most eight).
  // The busiest row is the last of the twelve branch tips the log lists (every other tip's line
  // passes through it); which tip that is depends on the log order, so take the widest. The
  // quiet row is HEAD: newest, so above every tip, with nothing open beside it. (The branches
  // fork from the root, so every older row has their lines running through it.)
  const busyX = Math.max(...await page.locator('[data-testid="commit-row"]:has-text("work on b") [data-testid="row-body"]')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().x)))
  const headBox = (await head.getByTestId('row-body').boundingBox())!
  expect(busyX).toBeGreaterThan(headBox.x + 100)
  // ...and the message (the row body, whose left edge is the lane cell's right edge) starts no
  // further than 170 px from the row's left edge, with twelve lanes open.
  const rowLeft = (await head.boundingBox())!.x
  expect(busyX - rowLeft).toBeLessThanOrEqual(170)
  // "Viewing n/m" is for when the graph hides something; with every branch showing it is not there.
  await expect(page.getByTestId('sidebar-viewing')).toHaveCount(0)
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/b3"]').hover()
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/b3"]').getByTestId('toggle-hidden').click()
  await expect(page.getByTestId('sidebar-viewing')).toContainText('Viewing 12/13')
  await page.getByTestId('sidebar-viewing').getByRole('button', { name: 'Show all' }).click()
  await expect(page.getByTestId('sidebar-viewing')).toHaveCount(0)
  await app.close()
})

test('one line per commit: branches before the message, the SHA on the selected row, merges muted', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  const head = page.locator(`[data-testid="commit-row"][data-hash="${r.head()}"]`)
  await expect(head).toBeVisible()
  // Branch pills come first, then the message: labels on the commit, read before it.
  const pill = (await head.locator('[data-testid="ref-pill"][data-ref="refs/heads/main"]').boundingBox())!
  const subject = (await head.getByTestId('row-subject').boundingBox())!
  expect(pill.x).toBeLessThan(subject.x)
  // The SHA is on the selected row only, where you would copy it (HEAD starts selected).
  await expect(head.getByTestId('row-sha')).toHaveText(r.head().slice(0, 7))
  const other = page.getByTestId('commit-row').nth(2)
  await other.click()
  await expect(head.getByTestId('row-sha')).toHaveCount(0)
  await expect(other.getByTestId('row-sha')).toBeVisible()
  await expect(page.getByTestId('row-sha')).toHaveCount(1)
  // A merge's message says where history came from, not what changed: it is muted.
  const merge = page.getByTestId('commit-row').filter({ has: page.locator('svg[data-node="merge"]') }).first()
  await expect(merge.getByTestId('row-subject')).toHaveClass(/text-muted-foreground/)
  await expect(head.getByTestId('row-subject')).not.toHaveClass(/text-muted-foreground/)
  await app.close()
})

test('the author\'s picture and the date line up on the right, with no names; a very narrow graph drops the date', async () => {
  const r = makeFixture('linear')
  // Dates the row shows differently: "2 h ago", "3 days ago", and the fixture's absolute ones.
  const now = Math.floor(Date.now() / 1000)
  r.git('commit', '-q', '--allow-empty', '-m', 'three days old', `--date=${now - 3 * 86400} +0000`)
  r.git('commit', '-q', '--allow-empty', '-m', 'two hours old', `--date=${now - 2 * 3600} +0000`)
  const { app, page } = await launch(r.dir)
  await page.evaluate(() => window.gitgoose.setSettings({ dateFormat: 'relative' }))
  // Wide: every row has the author's picture (the name only on hover) and the date.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1800, 640))
  const dates = page.getByTestId('row-date')
  await expect(dates.first()).toHaveText('2 h ago')
  await expect(dates.first()).toBeVisible()
  await expect(dates.nth(1)).toHaveText('3 days ago')
  await expect(page.getByTestId('row-author').first()).toHaveAttribute('aria-label', 'Ada Lovelace')
  await expect(page.getByTestId('row-author').first()).not.toContainText('Ada')
  for (const id of ['row-date', 'row-author']) {
    const boxes = await page.getByTestId(id).evaluateAll((els) => els.map((el) => {
      const b = el.getBoundingClientRect()
      return [b.left, b.right]
    }))
    expect(boxes.length).toBeGreaterThan(3)
    expect(new Set(boxes.map((b) => b.join())).size, `${id} columns line up`).toBe(1)
  }
  // Very narrow (the reading pane in a 1024 px window leaves the graph about 320 px): the picture
  // stays, the date goes, and the message keeps the room.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 640))
  await expect(dates.first()).toBeHidden()
  await expect(page.getByTestId('row-avatar').first()).toBeVisible()
  await app.close()
})

test('a commit message with a long unbroken token wraps instead of scrolling sideways', async () => {
  const r = makeFixture('linear')
  const token = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9'.repeat(8)
  r.git('commit', '-q', '--allow-empty', '-m', 'long token', '-m', `token: ${token}`)
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').filter({ hasText: 'long token' }).click()
  const body = page.locator('pre', { hasText: token.slice(0, 40) })
  await expect(body).toBeVisible()
  const { scroll, client } = await body.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
  expect(scroll).toBeLessThanOrEqual(client)
  await app.close()
})

test('a detached HEAD gets a HEAD pill', async () => {
  const r = makeFixture('linear')
  r.git('checkout', '-q', 'HEAD~2')
  const head = r.git('rev-parse', 'HEAD').trim()
  const { app, page } = await launch(r.dir)
  const row = page.locator(`[data-testid="commit-row"][data-hash="${head}"]`)
  await expect(row.getByTestId('head-pill')).toHaveText('HEAD')
  await expect(page.getByTestId('head-pill')).toHaveCount(1)
  // On a branch, the branch's pill says where HEAD is: no HEAD pill.
  r.checkout('main')
  await expect(page.getByTestId('head-pill')).toHaveCount(0)
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

test('the selected row is tinted with the selection blue, not its lane colour, in dark and light', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  // A side-branch commit: its lane is not lane 0, so a lane tint would differ from the blue.
  const row = page.locator(`[data-testid="commit-row"][data-hash="${r.git('rev-parse', 'wip').trim()}"]`)
  await row.click()
  await expect(row).toHaveAttribute('data-selected', 'true')
  const tint = row.getByTestId('row-tint')
  /** What var(--gs-select) resolves to right now, as the browser would paint it. */
  const selectBlue = () => page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.background = 'var(--gs-select)'
    document.body.append(probe)
    const c = getComputedStyle(probe).backgroundColor
    probe.remove()
    return c
  })
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => window.gitgoose.setSettings({ theme: t }), theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    const want = await selectBlue()
    expect(want).toMatch(/^rgba\(/)
    await expect.poll(() => tint.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(want)
  }
  await app.close()
})

test('Commit order: topological keeps each branch together, and switching reloads the graph in place', async () => {
  // main and side alternate in time: s1, m1, s2, m2, s3, m3.
  const r = initRepo()
  r.commit('A', { 'a.txt': 'a\n' })
  r.checkout('-b', 'side')
  r.checkout('main')
  for (let i = 1; i <= 3; i++) {
    r.checkout('side')
    r.commit(`s${i}`, { [`s${i}.txt`]: 'x\n' })
    r.checkout('main')
    r.commit(`m${i}`, { [`m${i}.txt`]: 'x\n' })
  }
  const { app, page } = await launch(r.dir)
  const subjects = () => page.locator('[data-testid="commit-row"] [data-testid="row-subject"]').allTextContents()
  await expect.poll(subjects).toEqual(['m3', 's3', 'm2', 's2', 'm1', 's1', 'A'])
  await page.evaluate(() => window.gitgoose.setSettings({ commitOrder: 'topo' }))
  // Each branch in one block; which block comes first is git's choice.
  await expect.poll(async () => (await subjects()).join(' ')).toMatch(/^(m3 m2 m1 s3 s2 s1|s3 s2 s1 m3 m2 m1) A$/)
  // Back from the command palette.
  await page.getByTestId('commit-row').first().click()
  await page.keyboard.press('ControlOrMeta+p')
  await page.getByTestId('palette-input').fill('> commit order')
  await page.getByTestId('omni-item').filter({ hasText: 'Commit order: by date' }).click()
  await expect.poll(subjects).toEqual(['m3', 's3', 'm2', 's2', 'm1', 's1', 'A'])
  await app.close()
})
