import { makeFixture } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { expectTooltip, launch } from './app'

test('the toolbar is one slim row and the Undo chip names the last operation', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  const toolbar = page.getByTestId('toolbar')
  const box = (await toolbar.boundingBox())!
  expect(box.height).toBeLessThanOrEqual(40)

  // Transport buttons are icons: found by their accessible name, with no visible label text.
  const push = toolbar.getByRole('button', { name: 'Push' }).first()
  await expect(push).toHaveText('')
  await expect(push).toHaveAttribute('aria-label', 'Push')

  // Nothing done yet: the chip reads "Undo" alone, disabled.
  const undo = toolbar.getByRole('button', { name: 'Undo' })
  await expect(undo).toBeDisabled()
  await expect(undo).toHaveText('Undo')

  // After an undoable action the chip says what it would undo, and its accessible name is still
  // exactly "Undo", so buttons named after the operation (Stash, Branch…) stay unambiguous.
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/wip"]').dblclick()
  await expect(page.getByTestId('location-head')).toHaveText('wip')
  await expect(toolbar.getByTestId('undo-label')).toHaveText('Check out wip')
  await expect(undo).toHaveAttribute('aria-label', 'Undo')
  await expect(undo).toBeEnabled()
  await expect(toolbar.getByRole('button', { name: 'Branch' })).toHaveCount(1)

  await undo.click()
  await expect(page.getByTestId('location-head')).toHaveText('main')
  await expect(toolbar.getByTestId('undo-label')).toHaveCount(0)
  await expect(toolbar.getByRole('button', { name: 'Redo' })).toBeEnabled()
  await app.close()
})

test('a tooltip closes when a menu opens next to it', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  const toolbar = page.getByTestId('toolbar')
  await expectTooltip(page, toolbar.getByRole('button', { name: 'Push' }).first(), 'Push')
  // Move there like a hand does (several steps), then press: the menu opens under the open tooltip.
  const chevron = (await toolbar.getByRole('button', { name: 'Pull options' }).boundingBox())!
  await page.mouse.move(chevron.x + chevron.width / 2, chevron.y + chevron.height / 2, { steps: 12 })
  await page.mouse.down()
  await page.mouse.up()
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await app.close()
})

test('the search is a real input with its shortcut, and a count sits beside its icon', async () => {
  const r = makeFixture('with-remote')
  r.commit('ahead of origin', { 'a-new-file.txt': 'x\n' })
  const { app, page } = await launch(r.dir)
  const toolbar = page.getByTestId('toolbar')

  // A real <input> (shadcn's), about 20 rem wide, with the platform's shortcut as a Kbd on its right.
  const search = toolbar.getByTestId('omni-open')
  expect(await search.evaluate((el) => el.tagName)).toBe('INPUT')
  const field = (await search.boundingBox())!
  expect(field.width).toBeGreaterThan(300)
  expect(field.width).toBeLessThan(340)
  const kbd = toolbar.locator('kbd')
  await expect(kbd).toHaveText(process.platform === 'darwin' ? '⌘K' : 'Ctrl+K')
  const hint = (await kbd.boundingBox())!
  expect(hint.x).toBeGreaterThan(field.x + field.width / 2)
  expect(hint.x + hint.width).toBeLessThanOrEqual(field.x + field.width)
  // Enter on it opens the search too, like a click.
  await search.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('omni')).toBeVisible()
  await page.keyboard.press('Escape')

  // Every toolbar button is 28 px tall, and the count of commits to push (the fixture has one, plus ours) is beside its icon, not on it.
  const push = toolbar.getByRole('button', { name: 'Push' }).first()
  expect((await push.boundingBox())!.height).toBe(28)
  await expect(push.getByTestId('toolbar-count')).toHaveText('2')
  const icon = (await push.locator('svg').boundingBox())!
  const count = (await push.getByTestId('toolbar-count').boundingBox())!
  expect(count.x).toBeGreaterThanOrEqual(icon.x + icon.width)
  expect((await toolbar.getByRole('button', { name: 'Fetch' }).boundingBox())!.height).toBe(28)
  expect((await toolbar.getByRole('button', { name: 'Settings' }).boundingBox())!.height).toBe(28)
  await app.close()
})
