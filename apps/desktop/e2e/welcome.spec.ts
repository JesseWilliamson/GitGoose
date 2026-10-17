import { makeFixture, tempDir } from '@gitsquid/fixtures'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

/** Make the native folder picker return `dir` without showing anything. */
async function pickReturns(app: ElectronApplication, dir: string) {
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [d] })) as typeof dialog.showOpenDialog
  }, dir)
}

test('opens a repository from the welcome screen and lists it as recent', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch()
  await pickReturns(app, r.dir)
  await page.getByTestId('welcome').getByRole('button', { name: 'Open' }).click()
  await expect(page.getByTestId('commit-row')).toHaveCount(5)
  await page.keyboard.press('Control+w')
  await expect(page.getByTestId('welcome')).toContainText(r.dir)
  await app.close()
})

test('offers to initialize a folder that is not a repository', async () => {
  const dir = tempDir('gitsquid-plain-')
  const { app, page } = await launch()
  await pickReturns(app, dir)
  await page.getByTestId('welcome').getByRole('button', { name: 'Open' }).click()
  await page.getByTestId('toast-action').filter({ hasText: 'Initialize it' }).click()
  await expect(page.getByTestId('wip-row')).toContainText('No commits yet')
  expect(existsSync(join(dir, '.git'))).toBe(true)
  await app.close()
})

test('clones a repository', async () => {
  const src = makeFixture('branches')
  const parent = tempDir('gitsquid-clones-')
  const { app, page } = await launch()
  await pickReturns(app, parent)
  await page.getByTestId('welcome').getByRole('button', { name: 'Clone' }).click()
  await page.getByPlaceholder('https://github.com/owner/repo.git').fill(src.dir)
  await page.getByRole('button', { name: 'Choose…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Clone' }).click()
  await expect(page.getByTestId('commit-row')).toHaveCount(7)
  await expect(page.getByTestId('sidebar')).toContainText('origin')
  await app.close()
})
