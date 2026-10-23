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
