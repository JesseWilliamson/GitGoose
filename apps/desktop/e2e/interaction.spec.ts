import { makeFixture } from '@gitgoose/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { dragTo, launch } from './app'

async function dragRef(page: Page, from: string, to: string) {
  await dragTo(page, page.locator(`[data-testid="ref-pill"][data-ref="${from}"]`), page.locator(`[data-testid="ref-pill"][data-ref="${to}"]`))
}

test('drags a branch onto the checked-out branch to merge it (no chooser: the drop is the merge)', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  await dragRef(page, 'refs/heads/wip', 'refs/heads/main')
  await expect(page.getByTestId('commit-row').first()).toContainText('Merge')
  expect(r.git('log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2)
  await app.close()
})

test('right-clicking the commit at a branch tip offers the branch actions too', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  const tip = r.git('rev-parse', 'wip').trim()
  // On the message, not the pill: the pill has always had its own branch menu.
  await page.locator(`[data-testid="commit-row"][data-hash="${tip}"]`).getByText('F', { exact: true }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Rebase main onto wip' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Revert this commit' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Merge wip into main' }).click()
  await expect(page.getByTestId('commit-row').first()).toContainText('Merge')
  expect(r.git('log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2)
  await app.close()
})

test('Alt-drags a branch onto the checked-out branch to rebase it onto that branch', async () => {
  const r = makeFixture('branches')
  r.checkout('wip')
  const { app, page } = await launch(r.dir)
  await page.keyboard.down('Alt')
  await dragRef(page, 'refs/heads/main', 'refs/heads/wip')
  await page.keyboard.up('Alt')
  await expect.poll(() => r.git('merge-base', 'wip', 'main').trim()).toBe(r.git('rev-parse', 'main').trim())
  await app.close()
})

test('creates a tag from the commit context menu', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').nth(2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Create tag here…' }).click()
  await page.getByTestId('dialog-input').fill('v1')
  await page.getByTestId('dialog-submit').click()
  await expect(page.locator('[data-testid="ref-pill"][data-ref="refs/tags/v1"]')).toBeVisible()
  expect(r.git('rev-parse', 'v1').trim()).toBe(r.git('rev-parse', 'HEAD~2').trim())
  await app.close()
})

test('opens the branch menu when right-clicking a branch pill', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  await page.locator('[data-testid="ref-pill"][data-ref="refs/heads/feature"]').click({ button: 'right' })
  await expect(page.getByRole('menu')).toContainText('Branch feature')
  await page.getByRole('menuitem', { name: 'Rename feature…' }).click()
  await page.getByTestId('dialog-input').fill('feature-2')
  await page.getByTestId('dialog-submit').click()
  await expect(page.locator('[data-testid="ref-pill"][data-ref="refs/heads/feature-2"]')).toBeVisible()
  // Right-clicking the row itself (its message, away from the pills) still gives the commit menu.
  const root = r.git('log', '--format=%s', '--max-parents=0', 'HEAD').trim()
  await page.getByTestId('commit-row').last().getByText(root, { exact: true }).click({ button: 'right' })
  await expect(page.getByRole('menu')).toContainText('Cherry-pick')
  await app.close()
})

test('stashes from the toolbar and pops from the stash view', async () => {
  const r = makeFixture('linear')
  r.write('file.txt', 'work in progress\n')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('toolbar').getByRole('button', { name: 'Stash' }).click()
  await expect(page.getByTestId('wip-row')).toHaveCount(0)
  await expect(page.getByTestId('sidebar')).toContainText('WIP on main')
  await page.getByTestId('stash-item').first().click()
  await page.getByTestId('stash-header').getByRole('button', { name: 'Pop' }).click()
  await expect(page.getByTestId('wip-row')).toBeVisible()
  await app.close()
})

test('shows what a stash contains', async () => {
  const r = makeFixture('linear')
  r.write('file.txt', 'edited\n')
  r.write('brand-new.txt', 'new\n')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('toolbar').getByRole('button', { name: 'Stash' }).click()
  await page.getByTestId('stash-item').first().click()
  await expect(page.getByTestId('stash-header')).toContainText('stash@{0}')
  await expect(page.getByTestId('commit-file')).toHaveCount(2)
  await page.getByTestId('commit-file').filter({ hasText: 'brand-new.txt' }).click()
  await expect(page.getByTestId('diff-line')).toHaveText(['1+new']) // new-side line number, sign, text
  await page.getByTestId('stash-header').getByRole('button', { name: 'Pop' }).click()
  await expect(page.getByTestId('wip-row')).toBeVisible()
  await app.close()
})

test('asks for credentials when a remote needs them', async () => {
  // A server that demands HTTP Basic auth and never accepts: git will prompt through askpass.
  const server = createServer((_req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const r = makeFixture('linear')
  r.git('remote', 'add', 'origin', `http://127.0.0.1:${port}/repo.git`)
  r.git('config', 'credential.helper', '')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('toolbar').getByRole('button', { name: 'Fetch' }).click()
  const input = page.getByTestId('prompt-input')
  await expect(page.getByRole('dialog')).toContainText('Username for')
  await input.fill('ada')
  await input.press('Enter')
  await expect(page.getByRole('dialog')).toContainText('Password for')
  await expect(input).toHaveAttribute('type', 'password')
  await input.fill('wrong')
  await input.press('Enter')
  await expect(page.getByTestId('attention')).toContainText('Fetch failed')
  await app.close()
  server.close()
})

test('double-clicking a commit row checks out its branch, undoably', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  const branch = () => r.git('rev-parse', '--abbrev-ref', 'HEAD').trim()
  const wip = r.git('rev-parse', 'wip').trim()
  // On the subject, not the pill: the pill has its own double-click.
  await page.locator(`[data-testid="commit-row"][data-hash="${wip}"]`).getByText('F', { exact: true }).dblclick()
  await expect.poll(branch).toBe('wip')
  // The two clicks leave exactly this commit selected.
  await expect(page.locator('[data-testid="commit-row"][data-selected]')).toHaveCount(1)
  await expect(page.locator(`[data-testid="commit-row"][data-hash="${wip}"]`)).toHaveAttribute('data-selected', 'true')
  await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).first().click()
  await expect.poll(branch).toBe('main')
  await app.close()
})

test('double-clicking a commit with no branch checks it out detached; with Ctrl held it stays the one selection', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  const b = r.git('rev-parse', 'main~2').trim() // B: no branch points at it
  expect(r.git('log', '-1', '--format=%s', b).trim()).toBe('B')
  await page.getByTestId('commit-row').first().click()
  // A Ctrl-click would toggle; two of them would toggle B on and off again, then add HEAD's row.
  await page.locator(`[data-testid="commit-row"][data-hash="${b}"]`).getByText('B', { exact: true }).dblclick({ modifiers: ['ControlOrMeta'] })
  await expect.poll(() => r.git('rev-parse', 'HEAD').trim()).toBe(b)
  expect(r.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD') // detached
  await expect(page.getByTestId('status-bar')).toContainText(`detached at ${b.slice(0, 7)}`)
  await expect(page.locator('[data-testid="commit-row"][data-selected]')).toHaveCount(1)
  await expect(page.locator(`[data-testid="commit-row"][data-hash="${b}"]`)).toHaveAttribute('data-selected', 'true')
  await app.close()
})

test("double-clicking HEAD's own row does nothing", async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  const head = r.head()
  await page.locator(`[data-testid="commit-row"][data-hash="${head}"]`).getByText('E', { exact: true }).dblclick()
  // Give a checkout time to happen, if one wrongly started.
  await page.waitForTimeout(500)
  expect(r.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
  expect(r.git('rev-parse', 'HEAD').trim()).toBe(head)
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByTestId('toast-action')).toHaveCount(0)
  await app.close()
})

test('double-clicking a commit where several branches point asks which one to check out', async () => {
  const r = makeFixture('branches')
  r.git('branch', 'release', 'wip')
  const { app, page } = await launch(r.dir)
  const wip = r.git('rev-parse', 'wip').trim()
  const branch = () => r.git('rev-parse', '--abbrev-ref', 'HEAD').trim()
  // A pill's double-click means that branch: it does not reach the row, so no menu.
  await page.locator('[data-testid="ref-pill"][data-ref="refs/heads/release"]').dblclick()
  await expect.poll(branch).toBe('release')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).first().click()
  await expect.poll(branch).toBe('main')
  // release points at wip's commit: until the app has seen the undo, that row is still HEAD's
  // own and a double-click there rightly does nothing. Wait for the app, not only for git.
  await expect(page.getByTestId('status-bar').locator('span').first()).toHaveText('main')

  await page.locator(`[data-testid="commit-row"][data-hash="${wip}"]`).getByText('F', { exact: true }).dblclick()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Check out wip' })).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveCount(2)
  // Nothing happens until one is picked.
  expect(r.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
  await menu.getByRole('menuitem', { name: 'Check out release' }).click()
  await expect.poll(() => r.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('release')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await app.close()
})

test('a menu item that cannot run is greyed out and says why on hover', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  await page.locator(`[data-testid="commit-row"][data-hash="${r.head()}"]`).getByText('E', { exact: true }).click({ button: 'right' })
  const item = page.getByRole('menuitem', { name: 'Check out this commit (detached)' })
  await expect(item).toHaveAttribute('aria-disabled', 'true')
  await expect(item).toHaveAttribute('aria-description', 'This is HEAD')
  // shadcn items are pointer-events: none when disabled; the tooltip hangs on the wrapper around them.
  const at = (await item.boundingBox())!
  await page.mouse.move(at.x + 20, at.y + at.height / 2, { steps: 8 })
  await page.mouse.move(at.x + 60, at.y + at.height / 2, { steps: 8 })
  await expect(page.getByRole('tooltip').first()).toHaveText('This is HEAD', { timeout: 10_000 })
  // Clicking it does nothing: still on main, menu open.
  await item.click({ force: true })
  expect(r.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
  await app.close()
})
