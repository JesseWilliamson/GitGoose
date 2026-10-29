import { makeFixture } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { launch } from './app'

test('the diff header groups its controls: layout, view tabs, one ⋯ menu with the version options, and no close', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').first().click()
  await page.getByTestId('commit-file').first().click()
  const view = page.getByTestId('file-view')
  await expect(view.getByTestId('layout-unified')).toBeVisible()

  // Left to right: the layout (Unified | Split), the view (Diff | History | Blame), ⋯.
  const x = async (locator: ReturnType<typeof view.locator>) => (await locator.boundingBox())!.x
  const xs = [await x(view.getByTestId('layout-unified')), await x(view.getByTestId('layout-split')), await x(view.getByTestId('mode-diff')),
    await x(view.getByTestId('mode-blame')), await x(view.getByTestId('file-menu'))]
  expect(xs).toEqual([...xs].sort((a, b) => a - b))
  // No close: the file is part of Details and follows the selection (ADR-011), so there is
  // nothing behind it to go back to, and the graph is still on screen beside it.
  await expect(view.getByRole('button', { name: 'Close' })).toHaveCount(0)
  await expect(page.getByTestId('graph-scroll')).toBeVisible()
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

test('a working-copy file keeps its stage/discard buttons in the header; selecting lines shows their actions without moving a line', async () => {
  const r = makeFixture('linear')
  r.write('file.txt', 'line 5\nline 5\nCHANGED\nline 5\nline 5\n')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('wip-row').click()
  await page.getByTestId('unstaged-file').first().click()
  const view = page.getByTestId('file-view')
  const header = view.locator('div').first()
  await expect(header.getByTestId('stage-file')).toBeVisible()
  await expect(header.getByTestId('discard-file')).toBeVisible()
  // They sit with the other controls: after the view tabs, before ⋯.
  const x = async (locator: ReturnType<typeof view.locator>) => (await locator.boundingBox())!.x
  const xs = [await x(view.getByTestId('mode-blame')), await x(view.getByTestId('stage-file')), await x(view.getByTestId('file-menu'))]
  expect(xs).toEqual([...xs].sort((a, b) => a - b))
  // Nothing to say about the diff itself, so no second bar.
  await expect(view.getByTestId('diff-hint')).toHaveCount(0)

  // Selecting lines shows what can be done with them, floating over the diff: nothing moves under
  // the pointer, so the second click of a double-click lands on the same line as the first.
  const changed = page.getByTestId('diff-line').filter({ hasText: 'CHANGED' })
  const before = (await changed.boundingBox())!.y
  await changed.click()
  await expect(view.getByTestId('diff-selection')).toBeVisible()
  await expect(view.getByTestId('stage-lines')).toBeVisible()
  expect((await changed.boundingBox())!.y).toBe(before)
  await expect(view.getByTestId('diff-hint')).toHaveCount(0)

  await page.getByTestId('stage-file').click()
  await expect(page.getByTestId('staged-file')).toHaveCount(1)
  await page.getByTestId('staged-file').first().click()
  await expect(view.getByTestId('unstage-file')).toBeVisible()
  await app.close()
})

test('a hunk header is tall enough for its buttons', async () => {
  const r = makeFixture('linear')
  r.write('file.txt', 'line 5\nline 5\nCHANGED\nline 5\nline 5\n')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('wip-row').click()
  await page.getByTestId('unstaged-file').first().click()
  const button = page.getByTestId('stage-hunk').first()
  const row = page.getByTestId('diff-lines').locator('div', { has: page.getByTestId('stage-hunk') }).last()
  const [b, h] = [(await button.boundingBox())!, (await row.boundingBox())!]
  expect(b.y).toBeGreaterThanOrEqual(h.y - 0.5)
  expect(b.y + b.height).toBeLessThanOrEqual(h.y + h.height + 0.5)
  await app.close()
})
