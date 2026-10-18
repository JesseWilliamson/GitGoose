import { initRepo } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { launch } from './app'

test('find a deleted branch in the reflog and restore it under its old name', async () => {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'a\n' })
  r.git('checkout', '-q', '-b', 'experiment')
  const tip = r.commit('try something', { 'b.txt': 'b\n' })
  r.checkout('main')
  r.git('branch', '-D', 'experiment')
  const { app, page } = await launch(r.dir)

  await page.getByTestId('open-reflog').click()
  const reflog = page.getByTestId('reflog')
  await expect(reflog).toContainText('1 commit is reachable only from here')
  const row = reflog.locator(`[data-testid="reflog-row"][data-hash="${tip}"]`)
  await expect(row).toContainText('lost')
  await expect(row).toContainText('was experiment')

  // Clicking shows the commit in the details panel, though the graph no longer has it.
  await row.click()
  await expect(page.getByTestId('detail-panel')).toContainText('try something')

  await reflog.getByLabel('Only lost commits').check()
  await expect(reflog.getByTestId('reflog-row')).toHaveCount(1)

  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Restore as a branch…' }).click()
  await expect(page.getByTestId('dialog-input')).toHaveValue('experiment')
  await page.getByTestId('dialog-submit').click()
  await expect.poll(() => r.gitOrNull('rev-parse', 'experiment')?.trim()).toBe(tip)
  await expect(reflog).toContainText('Nothing is lost')
  await expect(page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/experiment"]')).toHaveCount(1)
  await app.close()
})
