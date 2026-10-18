import { initRepo, tempDir } from '@gitgoose/fixtures'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

/** Native dialogs cannot be clicked: answer them from the main process instead. */
const answerDialogs = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, path)
const setClipboard = (app: ElectronApplication, text: string) => app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
const row = (page: import('@playwright/test').Page, hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)

test('save a commit as a patch file, then apply it from the clipboard as a commit', async () => {
  const r = initRepo()
  const root = r.commit('root', { 'a.txt': 'a\n' })
  const one = r.commit('add b', { 'b.txt': 'b\n' })
  const { app, page } = await launch(r.dir)
  const dir = tempDir('gitgoose-patches-')
  await answerDialogs(app, dir)
  await row(page, one).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Save as patch file…' }).click()
  await expect.poll(() => readdirSync(dir)).toEqual(['0001-add-b.patch'])

  r.git('reset', '-q', '--hard', root)
  await setClipboard(app, readFileSync(join(dir, '0001-add-b.patch'), 'utf8'))
  await page.keyboard.press('ControlOrMeta+p')
  await page.keyboard.type('Apply patch from the clipboard')
  await page.keyboard.press('Enter')
  await expect.poll(() => r.git('log', '-1', '--format=%s').trim()).toBe('add b')
  await app.close()
})

test('a patch that conflicts stops as "Patch in progress"; Abort patch puts things back', async () => {
  const r = initRepo()
  const root = r.commit('root', { 'a.txt': '1\n2\n3\n' })
  r.commit('change three', { 'a.txt': '1\n2\nTHREE\n' })
  const patch = r.git('format-patch', '--stdout', '-1', 'HEAD')
  r.git('reset', '-q', '--hard', root)
  const mine = r.commit('other change', { 'a.txt': '1\n2\ntres\n' })
  const { app, page } = await launch(r.dir)
  await expect(row(page, mine)).toBeVisible()
  await setClipboard(app, patch)
  await page.keyboard.press('ControlOrMeta+p')
  await page.keyboard.type('Apply patch from the clipboard')
  await page.keyboard.press('Enter')
  const alert = page.getByTestId('attention-row').filter({ hasText: 'conflicts' })
  await expect(alert).toContainText('The patch stopped: 1 file has conflicts')
  await expect(page.getByTestId('conflicts')).toContainText('Patch in progress')
  await page.getByTestId('conflicts').getByRole('button', { name: 'Abort patch' }).click()
  await expect.poll(() => r.head()).toBe(mine)
  await expect(page.getByTestId('conflicts')).toHaveCount(0)
  await app.close()
})
