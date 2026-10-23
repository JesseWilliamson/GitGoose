import { initRepo, makeFixture } from '@gitgoose/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { launch } from './app'

/** The dialog opens with a zoom: measure it when it has stopped. */
async function settled(page: Page) {
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  return dialog
}

/** The dialog's outer box and the box of one of its buttons, for the layout rules below. */
async function boxes(page: Page, button: string) {
  const dialog = (await page.getByRole('dialog').boundingBox())!
  const b = (await page.getByRole('dialog').getByRole('button', { name: button, exact: true }).boundingBox())!
  return { dialog, b }
}

test('a dialog has the width of its kind; its footer is right-aligned with the primary button last; Esc and Enter work', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await expect(page.getByTestId('commit-row')).toHaveCount(5)

  // sm (400): one field. Title 15 px semibold; Cancel then the primary action at the right edge, 16 px in.
  await page.getByTestId('toolbar').getByRole('button', { name: 'Branch', exact: true }).click()
  const dialog = await settled(page)
  expect((await dialog.boundingBox())!.width).toBe(400)
  const title = dialog.getByRole('heading')
  await expect(title).toHaveCSS('font-size', '15px')
  await expect(title).toHaveCSS('font-weight', '600')
  const buttons = await dialog.getByRole('button').allTextContents()
  expect(buttons.at(-1)).not.toBe('Cancel')
  expect(buttons.indexOf('Cancel')).toBeLessThan(buttons.length - 1)
  const { dialog: box, b } = await boxes(page, buttons.at(-1)!)
  expect(Math.round(box.x + box.width - (b.x + b.width))).toBe(17) // 16 px padding + 1 px border

  // Esc closes it; Enter in the field submits it.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.getByTestId('toolbar').getByRole('button', { name: 'Branch', exact: true }).click()
  await page.getByTestId('dialog-input').fill('from-enter')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('location-head')).toHaveText('from-enter')
  await app.close()
})

test('a form dialog is md (520), and Enter runs the primary action of a dialog that has no form', async () => {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'a\n' })
  r.git('branch', 'done')
  r.commit('main moves on', { 'b.txt': 'b\n' })
  const { app, page } = await launch(r.dir)
  await expect(page.getByTestId('commit-row')).toHaveCount(2)
  await page.keyboard.press('ControlOrMeta+p')
  await page.getByTestId('palette-input').fill('Clean up branches')
  await page.keyboard.press('Enter')
  const list = page.getByTestId('cleanup-list')
  await expect(list.getByRole('checkbox', { name: 'done' })).toBeChecked()
  expect((await (await settled(page)).boundingBox())!.width).toBe(520)
  // Focus is on a checkbox, not in a form: Enter deletes the ticked branches.
  await list.getByRole('checkbox', { name: 'done' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(() => r.git('branch', '--list', 'done').trim()).toBe('')
  await app.close()
})

test('the clone dialog is md (520)', async () => {
  const { app, page } = await launch()
  await page.getByTestId('welcome').getByRole('button', { name: 'Clone', exact: true }).click()
  expect((await (await settled(page)).boundingBox())!.width).toBe(520)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await app.close()
})
