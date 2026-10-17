import { initRepo } from '@gitsquid/fixtures'
import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { launch } from './app'

test('add a worktree on a new branch (it opens as a tab), then remove it and undo', async () => {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'a\n' })
  const { app, page } = await launch(r.dir)
  const expected = `${r.dir}-feature-x`

  await page.getByRole('button', { name: 'Add worktree' }).click()
  await page.getByTestId('dialog-input').fill('feature/x')
  await page.getByTestId('dialog-submit').click()
  await expect(page.getByTestId('tabs').getByTitle(expected)).toBeVisible()
  expect(r.git('worktree', 'list')).toContain('[feature/x]')

  // Back in the first tab: the branch is marked as checked out elsewhere.
  await page.getByTestId('tabs').getByTitle(expected).getByTitle('Close tab').click({ force: true })
  await expect(page.getByTestId('tabs').getByTitle(expected)).toHaveCount(0)
  await expect(page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/feature/x"]')).toContainText('worktree')
  const item = page.locator(`[data-testid="worktree-item"][data-path="${expected}"]`)
  await expect(item).toContainText('feature/x')

  await item.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Remove worktree' }).click()
  await expect(item).toHaveCount(0)
  expect(existsSync(expected)).toBe(false)
  await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).last().click()
  await expect(item).toHaveCount(1)
  expect(existsSync(expected)).toBe(true)
  await app.close()
})

test('a branch can be checked out in a new worktree from its menu', async () => {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'a\n' })
  r.git('branch', 'topic')
  const { app, page } = await launch(r.dir)
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/topic"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Check out in a new worktree…' }).click()
  await expect(page.getByTestId('dialog-input')).toHaveValue(`${r.dir}-topic`)
  await page.getByTestId('dialog-submit').click()
  await expect(page.getByTestId('tabs').getByTitle(`${r.dir}-topic`)).toBeVisible()
  await app.close()
})
