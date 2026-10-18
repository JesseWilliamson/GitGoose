import { initRepo } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { realpathSync } from 'node:fs'
import { launch } from './app'

// Local submodule clones need protocol.file.allow (off by default since git 2.38.1).
const allowFile = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' }

test('clone a missing submodule, open it as a tab, remove it and undo', async () => {
  const lib = initRepo()
  lib.commit('lib', { 'lib.txt': 'lib\n' })
  const app = initRepo()
  app.commit('root', { 'app.txt': 'app\n' })
  app.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib.dir, 'lib')
  app.git('commit', '-q', '-m', 'add lib')
  // A clone of the superproject without its submodule: what you get from a plain git clone.
  const clone = initRepo()
  clone.git('fetch', '-q', app.dir, 'main')
  clone.git('reset', '-q', '--hard', 'FETCH_HEAD')

  const { app: electron, page } = await launch(clone.dir, allowFile)
  const item = page.locator('[data-testid="submodule-item"][data-path="lib"]')
  await expect(item).toContainText('not cloned')
  await item.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Clone and check out' }).click()
  await expect(item).not.toContainText('not cloned')

  await item.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Remove submodule' }).click()
  await expect(item).toHaveCount(0)
  await expect(page.getByTestId('staged-file')).toHaveCount(2) // .gitmodules and lib
  await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).last().click()
  await expect(item).toHaveCount(1)
  await expect.poll(() => clone.git('status', '--porcelain')).toBe('')

  await item.dblclick()
  await expect(page.getByTestId('tabs').getByTitle(`${realpathSync.native(clone.dir)}/lib`)).toBeVisible()
  await electron.close()
})
