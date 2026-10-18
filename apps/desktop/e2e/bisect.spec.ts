import { initRepo } from '@gitsquid/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { pickFromSubmenu, launch } from './app'

const row = (page: Page, hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)

test('bisect from the graph: mark bad and good, test what git checks out, find the culprit, stop', async () => {
  const r = initRepo()
  const hashes: string[] = []
  for (let i = 1; i <= 8; i++) hashes.push(r.commit(`c${i}`, { 'value.txt': i >= 5 ? 'bad\n' : 'good\n' }))
  const { app, page } = await launch(r.dir)

  await row(page, hashes[7]!).click({ button: 'right' })
  await pickFromSubmenu(page, 'Bisect: find the commit that broke something', 'Start: this commit is bad (has the bug)')
  const bar = page.getByTestId('bisect-bar')
  await expect(bar).toContainText('now mark a commit without the bug as good')
  await row(page, hashes[0]!).click({ button: 'right' })
  await pickFromSubmenu(page, 'Bisect', 'Mark good (no bug)')
  await expect(row(page, hashes[0]!).getByTestId('bisect-pill')).toHaveText('good')

  for (let guard = 0; guard < 6; guard++) {
    await expect(bar).toContainText(/test the checked-out commit|First bad commit/)
    if ((await bar.textContent())!.includes('First bad commit')) break
    const before = r.head()
    await bar.getByRole('button', { name: r.git('show', 'HEAD:value.txt') === 'bad\n' ? 'Bad' : 'Good' }).click()
    // Each step checks out the next commit to test, or ends with the answer (HEAD stays put).
    await expect.poll(async () => r.head() !== before || (await bar.textContent())!.includes('First bad commit')).toBe(true)
  }
  await expect(bar).toContainText(`First bad commit: ${hashes[4]!.slice(0, 7)} c5`)
  await expect(row(page, hashes[4]!).getByTestId('bisect-pill')).toHaveText('first bad')

  await bar.getByRole('button', { name: 'Stop bisecting' }).click()
  await expect(bar).toHaveCount(0)
  await expect.poll(() => r.git('branch', '--show-current').trim()).toBe('main')
  await app.close()
})
