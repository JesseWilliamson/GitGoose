import { initRepo } from '@gitsquid/fixtures'
import { expect, test } from '@playwright/test'
import { launch } from './app'

test('the command log lists what GitSquid ran, failures with what git said', async () => {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'a\n' })
  r.git('branch', 'taken')
  const { app, page } = await launch(r.dir)
  await expect(page.getByTestId('commit-row').first()).toBeVisible()
  // A command that fails: renaming main onto an existing branch name.
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/main"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename main…' }).click()
  await page.getByTestId('dialog-input').fill('taken')
  await page.getByTestId('dialog-submit').click()
  await expect(page.getByTestId('attention-row')).toContainText('Rename main failed')

  await page.keyboard.press('ControlOrMeta+p')
  await page.keyboard.type('Show git command log')
  await page.keyboard.press('Enter')
  const log = page.getByTestId('command-log')
  const failed = log.locator('[data-testid="command-row"][data-failed]').first()
  await expect(failed).toContainText('git branch -m main taken')
  await failed.click()
  await expect(failed).toContainText('already exists')
  // Reads are hidden until asked for.
  await expect(log).not.toContainText('git status')
  await log.getByLabel('Show reads').check()
  await expect(log).toContainText('git status --porcelain=v2')
  await app.close()
})
