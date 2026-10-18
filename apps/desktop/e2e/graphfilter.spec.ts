import { initRepo, tempDir } from '@gitgoose/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { launch } from './app'

function setup() {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'a\n' })
  r.git('checkout', '-q', '-b', 'wip')
  const wip = r.commit('on wip', { 'w.txt': 'w\n' })
  r.checkout('main')
  r.git('checkout', '-q', '-b', 'other')
  const other = r.commit('on other', { 'o.txt': 'o\n' })
  r.checkout('main')
  const main = r.commit('on main', { 'm.txt': 'm\n' })
  return { r, wip, other, main }
}
const row = (page: Page, hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)
const ref = (page: Page, name: string) => page.locator(`[data-testid="sidebar-ref"][data-ref="refs/heads/${name}"]`)

test('hide a branch with its eye button, solo another from its menu; remembered after a restart', async () => {
  const { r, wip, other, main } = setup()
  const profile = tempDir('gitgoose-profile-')
  let { app, page } = await launch(r.dir, { GITGOOSE_USER_DATA: profile })
  await expect(row(page, wip)).toBeVisible()

  await ref(page, 'wip').hover()
  await ref(page, 'wip').getByTestId('toggle-hidden').click()
  await expect(row(page, wip)).toHaveCount(0)
  await expect(page.getByTestId('graph-filter')).toContainText('1 hidden: wip')
  await expect(row(page, other)).toBeVisible()
  await app.close()

  ;({ app, page } = await launch(r.dir, { GITGOOSE_USER_DATA: profile }))
  await expect(row(page, main)).toBeVisible()
  await expect(row(page, wip)).toHaveCount(0)
  await expect(page.getByTestId('graph-filter')).toBeVisible()

  // Solo: only that branch and HEAD's.
  await page.getByTestId('graph-filter').getByRole('button', { name: 'Show all' }).click()
  await expect(row(page, wip)).toBeVisible()
  await ref(page, 'other').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Solo other (show only it)' }).click()
  await expect(page.getByTestId('graph-filter')).toContainText('Showing only other')
  await expect(row(page, wip)).toHaveCount(0)
  await expect(row(page, other)).toBeVisible()
  await expect(row(page, main)).toBeVisible()
  await expect(ref(page, 'wip').getByTestId('ref-label')).toHaveClass(/line-through/)
  await page.getByTestId('graph-filter').getByRole('button', { name: 'Show all' }).click()
  await expect(page.getByTestId('graph-filter')).toHaveCount(0)
  await app.close()
})
