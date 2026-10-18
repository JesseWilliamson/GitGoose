import { makeFixture } from '@gitsquid/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { launch } from './app'

async function dragRef(page: Page, from: string, to: string) {
  await page.locator(`[data-testid="ref-pill"][data-ref="${from}"]`).dragTo(page.locator(`[data-testid="ref-pill"][data-ref="${to}"]`))
}

test('drags a branch onto the checked-out branch to merge it', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  await dragRef(page, 'refs/heads/wip', 'refs/heads/main')
  await page.getByRole('menuitem', { name: 'Merge wip into main' }).click()
  await expect(page.getByTestId('commit-row').first()).toContainText('Merge')
  expect(r.git('log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2)
  await app.close()
})

test('drags the checked-out branch onto another to rebase it', async () => {
  const r = makeFixture('branches')
  r.checkout('wip')
  const { app, page } = await launch(r.dir)
  await dragRef(page, 'refs/heads/wip', 'refs/heads/main')
  await page.getByRole('menuitem', { name: 'Rebase wip onto main' }).click()
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

test('stashes and pops from the toolbar', async () => {
  const r = makeFixture('linear')
  r.write('file.txt', 'work in progress\n')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('toolbar').getByRole('button', { name: 'Stash' }).click()
  await expect(page.getByTestId('wip-row')).toHaveCount(0)
  await expect(page.getByTestId('sidebar')).toContainText('WIP on main')
  await page.getByTestId('toolbar').getByRole('button', { name: 'Pop' }).click()
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
