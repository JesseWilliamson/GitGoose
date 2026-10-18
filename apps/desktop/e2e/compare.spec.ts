import { initRepo } from '@gitsquid/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

const row = (page: Page, hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)

function setup() {
  const r = initRepo()
  const A = r.commit('A', { 'calc.ts': 'export const total = price * count\nexport const tax = 0.2\n' })
  const B = r.commit('B', { 'notes.md': '# notes\n' })
  const C = r.commit('C', { 'calc.ts': 'export const total = price * quantity\nexport const tax = 0.2\n' })
  return { r, A, B, C }
}

test('compare two commits, open a file, and see changed words in unified and split views', async () => {
  const { r, A, C } = setup()
  const { app, page } = await launch(r.dir)
  await row(page, C).click()
  await row(page, A).click({ modifiers: ['ControlOrMeta'] })
  await page.getByTestId('multi-compare').click()
  const panel = page.getByTestId('compare-panel')
  await expect(panel).toContainText(A.slice(0, 7))
  await expect(page.getByTestId('compare-file')).toHaveCount(2)
  await page.getByTestId('compare-file').filter({ hasText: 'calc.ts' }).click()
  await expect(page.getByTestId('file-view')).toContainText('→')

  // Unified: the changed word is marked inside the changed lines.
  await page.getByTestId('layout-unified').click()
  await expect(page.locator('[data-testid="diff-line"][data-kind="-"] [data-changed]')).toHaveText('count')
  await expect(page.locator('[data-testid="diff-line"][data-kind="+"] [data-changed]')).toHaveText('quantity')
  // Split: the removed line sits beside the added one.
  await page.getByTestId('layout-split').click()
  const changed = page.getByTestId('diff-row').filter({ has: page.locator('[data-side="left"][data-kind="-"]') })
  await expect(changed).toHaveCount(1)
  await expect(changed.locator('[data-side="right"]')).toHaveAttribute('data-kind', '+')
  await expect(changed.locator('[data-side="right"] [data-changed]')).toHaveText('quantity')
  await page.getByTestId('layout-unified').click()
  await app.close()
})

test('compare a commit with the working tree; restore a file to that version, undoably', async () => {
  const { r, A } = setup()
  writeFileSync(join(r.dir, 'calc.ts'), 'local\n')
  const { app, page } = await launch(r.dir)
  await row(page, A).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Compare' }).click()
  await page.getByRole('menuitem', { name: 'With the working tree' }).click()
  await expect(page.getByTestId('compare-panel')).toContainText('working tree')
  const file = page.getByTestId('compare-file').filter({ hasText: 'calc.ts' })
  await file.click({ button: 'right' })
  // Against the working tree there is no revision on the right, so nothing to restore to.
  await expect(page.getByRole('menuitem', { name: 'Restore the working copy to this version' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // From a commit's own file list: restore the working copy to that commit's version.
  await row(page, A).click()
  await page.getByTestId('commit-file').filter({ hasText: 'calc.ts' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Restore the working copy to this version' }).click()
  await expect.poll(() => readFileSync(join(r.dir, 'calc.ts'), 'utf8')).toBe('export const total = price * count\nexport const tax = 0.2\n')
  await page.getByTestId('toolbar').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => readFileSync(join(r.dir, 'calc.ts'), 'utf8')).toBe('local\n')
  await app.close()
})
