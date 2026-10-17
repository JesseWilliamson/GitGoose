import { initRepo } from '@gitsquid/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { launch } from './app'

const row = (page: Page, hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)

test('bisect from the graph: mark bad and good, test what git checks out, find the culprit, stop', async () => {
  const r = initRepo()
  const hashes: string[] = []
  for (let i = 1; i <= 8; i++) hashes.push(r.commit(`c${i}`, { 'value.txt': i >= 5 ? 'bad\n' : 'good\n' }))
  const { app, page } = await launch(r.dir)

  await row(page, hashes[7]!).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Bisect: find the commit that broke something' }).click()
  await page.getByRole('menuitem', { name: 'Start: this commit is bad (has the bug)' }).click()
  const bar = page.getByTestId('bisect-bar')
  await expect(bar).toContainText('now mark a commit without the bug as good')
  await row(page, hashes[0]!).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Bisect' }).click()
  await page.getByRole('menuitem', { name: 'Mark good (no bug)' }).click()
  await expect(row(page, hashes[0]!).getByTestId('bisect-pill')).toHaveText('good')

  for (let guard = 0; guard < 6; guard++) {
    await expect(bar).toContainText(/test the checked-out commit|First bad commit/)
    if ((await bar.textContent())!.includes('First bad commit')) break
    const before = r.head()
    await bar.getByRole('button', { name: r.git('show', 'HEAD:value.txt') === 'bad\n' ? 'Bad' : 'Good' }).click()
    await expect.poll(() => r.head() !== before || r.git('for-each-ref', 'refs/bisect').includes('bad')).toBe(true)
  }
  await expect(bar).toContainText(`First bad commit: ${hashes[4]!.slice(0, 7)} c5`)
  await expect(row(page, hashes[4]!).getByTestId('bisect-pill')).toHaveText('first bad')

  await bar.getByRole('button', { name: 'Stop bisecting' }).click()
  await expect(bar).toHaveCount(0)
  await expect.poll(() => r.git('branch', '--show-current').trim()).toBe('main')
  await app.close()
})
