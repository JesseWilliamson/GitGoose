import { makeFixture, tempDir } from '@gitgoose/fixtures'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, realpathSync } from 'node:fs'
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
  await page.keyboard.press('ControlOrMeta+w')
  // The path as git reports it, symlinks resolved (the macOS temp folder is one).
  await expect(page.getByTestId('welcome')).toContainText(realpathSync.native(r.dir))
  await app.close()
})

test('offers to initialize a folder that is not a repository', async () => {
  const dir = tempDir('gitgoose-plain-')
  const { app, page } = await launch()
  await pickReturns(app, dir)
  await page.getByTestId('welcome').getByRole('button', { name: 'Open' }).click()
  await page.getByTestId('choice-dialog').getByRole('button', { name: 'Initialize repository' }).click()
  await expect(page.getByTestId('wip-row')).toContainText('No commits yet')
  expect(existsSync(join(dir, '.git'))).toBe(true)
  await app.close()
})

test('clones a repository', async () => {
  const src = makeFixture('branches')
  const parent = tempDir('gitgoose-clones-')
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

test('recent repositories are the main list: folder name, path, one click to open; actions and shortcuts around it', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch()
  const welcome = page.getByTestId('welcome')
  // Nothing opened yet: a line that says so, and the three ways to start.
  await expect(page.getByTestId('welcome-empty')).toBeVisible()
  await expect(page.getByTestId('recent-repo')).toHaveCount(0)
  for (const name of ['Open', 'Clone', 'New']) await expect(welcome.getByRole('button', { name, exact: true })).toBeVisible()
  // The shortcuts are a muted footer line.
  await expect(page.getByTestId('welcome-shortcuts')).toContainText('search')

  await pickReturns(app, r.dir)
  await welcome.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(page.getByTestId('commit-row')).toHaveCount(5)
  await page.keyboard.press('ControlOrMeta+w')

  const row = page.getByTestId('recent-repo')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(realpathSync.native(r.dir).split(/[\\/]/).pop()!)
  await expect(row).toContainText(realpathSync.native(r.dir))
  await expect(page.getByTestId('welcome-empty')).toHaveCount(0)
  await row.click()
  await expect(page.getByTestId('commit-row')).toHaveCount(5)
  await app.close()
})
