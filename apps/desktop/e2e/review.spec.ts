import { makeFixture } from '@gitsquid/fixtures'
import { expect, test } from '@playwright/test'
import { launch } from './app'

test('error toasts carry git stderr, not just the first line (review #14)', async () => {
  const r = makeFixture('branches')
  r.write('f.txt', 'an untracked file in the way\n') // wip has a tracked f.txt
  const { app, page } = await launch(r.dir)
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/wip"]').dblclick()
  const toast = page.locator('[role=status][data-kind=error]')
  await expect(toast).toContainText('Check out wip failed')
  // The list of files is on later stderr lines, which only survive if stderr crosses the bridge.
  await expect(toast).toContainText('f.txt')
  await app.close()
})

test('Undo buttons only undo their own operation (review #6)', async () => {
  const r = makeFixture('branches')
  r.write('notes.txt', 'n\n')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('wip-row').click()
  await page.getByTestId('stage-all').click()
  await page.getByTestId('commit-summary').fill('My commit')
  await page.getByTestId('commit-button').click()
  const commitToast = page.locator('[role=status]').filter({ hasText: 'Committed' })
  await expect(commitToast.getByTestId('toast-action')).toBeVisible()

  // Merging an already-merged branch changes nothing: no Undo offered.
  await page.locator('[data-testid="ref-pill"][data-ref="refs/heads/feature"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Merge feature into main' }).click()
  const mergeToast = page.locator('[role=status]').filter({ hasText: 'Merge feature' })
  await expect(mergeToast).toBeVisible()
  await expect(mergeToast.getByTestId('toast-action')).toHaveCount(0)

  // Something newer (a tag) makes the commit's toast stale: its Undo is refused.
  await page.getByTestId('commit-row').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Create tag here…' }).click()
  await page.getByTestId('dialog-input').fill('v9')
  await page.getByTestId('dialog-submit').click()
  await expect(page.locator('[data-testid="ref-pill"][data-ref="refs/tags/v9"]')).toBeVisible()
  await commitToast.getByTestId('toast-action').click()
  await expect(page.locator('[role=status][data-kind=error]')).toContainText('Something else happened since')
  expect(r.git('log', '-1', '--format=%s').trim()).toBe('My commit')
  await app.close()
})
