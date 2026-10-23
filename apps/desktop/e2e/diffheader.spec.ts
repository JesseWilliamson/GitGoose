import { makeFixture } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { launch } from './app'

test('the diff header groups its controls: layout, view tabs, one ⋯ menu with the version options, then close', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').first().click()
  await page.getByTestId('commit-file').first().click()
  const view = page.getByTestId('file-view')
  await expect(view.getByTestId('layout-unified')).toBeVisible()

  // Left to right: the layout (Unified | Split), the view (Diff | History | Blame), ⋯, ✕.
  const x = async (locator: ReturnType<typeof view.locator>) => (await locator.boundingBox())!.x
  const xs = [await x(view.getByTestId('layout-unified')), await x(view.getByTestId('layout-split')), await x(view.getByTestId('mode-diff')),
    await x(view.getByTestId('mode-blame')), await x(view.getByTestId('file-menu')), await x(view.getByRole('button', { name: 'Close' }))]
  expect(xs).toEqual([...xs].sort((a, b) => a - b))
  // The old stand-alone buttons are gone from the bar.
  await expect(view.getByRole('button', { name: 'This version' })).toHaveCount(0)
  await expect(view.getByRole('button', { name: 'Diff tool' })).toHaveCount(0)

  // The menu holds the version options and the diff tool.
  await view.getByTestId('file-menu').click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['Open this version', 'Save this version as…', 'Restore the working copy to this version', 'Open in diff tool'])
  await page.keyboard.press('Escape')

  // The layout toggle belongs to the diff: History and Blame do not show it, nor the diff tool.
  await view.getByTestId('mode-history').click()
  await expect(view.getByTestId('layout-unified')).toHaveCount(0)
  await expect(view.getByTestId('mode-history')).toHaveAttribute('aria-pressed', 'true')
  await view.getByTestId('file-menu').click()
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveCount(3)
  await page.keyboard.press('Escape')
  await app.close()
})
