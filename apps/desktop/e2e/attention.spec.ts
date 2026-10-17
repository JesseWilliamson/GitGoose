import { makeFixture, tempDir } from '@gitsquid/fixtures'
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

test('the search box names its shortcuts with the real modifier, no ⌘ glyph elsewhere', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  const toolbar = page.getByTestId('toolbar')
  await expect(toolbar.locator('.lucide-command')).toHaveCount(0)
  const search = page.getByTestId('omni-open')
  const mod = process.platform === 'darwin' ? '⌘' : 'Ctrl'
  await expect(search).toContainText(`${mod}+K`)
  await expect(search).toHaveAttribute('title', new RegExp(`commands only: ${mod.replace('+', '')}\\+P`))
  await app.close()
})

test('deleting an unmerged branch asks in a modal, and can still be undone', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/wip"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete wip' }).click()
  await expect(page.getByRole('dialog')).toContainText('wip is not fully merged')
  const dialog = page.getByTestId('choice-dialog')
  await dialog.getByRole('button', { name: 'Delete anyway' }).click()
  await expect(page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/wip"]')).toHaveCount(0)
  await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).first().click()
  await expect(page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/wip"]')).toHaveCount(1)
  await app.close()
})

test('a rejected push lands in the attention bar with the hook output, one row per failure', async () => {
  const r = makeFixture('with-remote')
  const bare = r.git('remote', 'get-url', 'origin').trim()
  const hook = join(bare, 'hooks', 'pre-receive')
  writeFileSync(hook, '#!/bin/sh\necho "policy: pushes to main need review" >&2\nexit 1\n')
  chmodSync(hook, 0o755)
  const { app, page } = await launch(r.dir)
  const push = page.getByTestId('toolbar').getByRole('button', { name: 'Push' }).first()
  await push.click()
  const bar = page.getByTestId('attention')
  await expect(bar).toContainText('Push failed')
  await bar.getByTestId('attention-details').first().click()
  await expect(bar).toContainText('pushes to main need review')
  // A second failure adds a row instead of replacing the first.
  await push.click()
  await expect(page.getByTestId('attention-row')).toHaveCount(2)
  await page.getByTestId('attention-dismiss').first().click()
  await expect(page.getByTestId('attention-row')).toHaveCount(1)
  await app.close()
})

test('a push behind the remote offers to pull first', async () => {
  const r = makeFixture('with-remote')
  const other = tempDir('gitsquid-other-')
  execFileSync('git', ['clone', '-q', r.git('remote', 'get-url', 'origin').trim(), other])
  execFileSync('git', ['-c', 'user.name=B', '-c', 'user.email=b@x', 'commit', '-q', '--allow-empty', '-m', 'Theirs'], { cwd: other })
  execFileSync('git', ['push', '-q'], { cwd: other })
  const { app, page } = await launch(r.dir)
  await page.getByTestId('toolbar').getByRole('button', { name: 'Push' }).first().click()
  await expect(page.getByRole('dialog')).toContainText('The remote has commits you do not have')
  const dialog = page.getByTestId('choice-dialog')
  await dialog.getByRole('button', { name: 'Pull, then push' }).click()
  await expect(page.locator('[role=status]').filter({ hasText: 'Pushed' })).toBeVisible()
  expect(r.git('rev-parse', 'origin/main').trim()).toBe(r.head())
  await app.close()
})

test('checkout blocked by local changes offers to stash first', async () => {
  const r = makeFixture('branches')
  r.write('f.txt', 'in the way\n')
  const { app, page } = await launch(r.dir)
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/wip"]').dblclick()
  await page.getByTestId('choice-dialog').getByRole('button', { name: 'Stash and check out' }).click()
  await expect(page.getByTestId('status-bar')).toContainText('wip')
  await expect(page.getByTestId('sidebar')).toContainText('before checking out wip')
  await app.close()
})
