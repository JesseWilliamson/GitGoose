import { makeFixture, tempDir } from '@gitgoose/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { launch } from './app'

const width = async (page: Page, id: string) => (await page.getByTestId(id).boundingBox())?.width ?? 0

test('dragging a divider resizes a side panel, and the size survives a restart', async () => {
  const profile = tempDir('gitgoose-profile-')
  const r = makeFixture('linear')
  const first = await launch(r.dir, { GITGOOSE_USER_DATA: profile })
  const page = first.page
  await expect(page.getByTestId('slot-left')).toBeVisible()
  const before = await width(page, 'slot-left')
  const sep = (await page.getByTestId('sep-left').boundingBox())!
  await page.mouse.move(sep.x + sep.width / 2, sep.y + 200)
  await page.mouse.down()
  await page.mouse.move(sep.x + 120, sep.y + 200, { steps: 8 })
  await page.mouse.up()
  // Not the full 120 px: on a loaded machine the panel catches up with the pointer a few steps
  // late and ends a little short. The point is that it grew by a lot and that size is kept.
  await expect.poll(() => width(page, 'slot-left')).toBeGreaterThan(before + 60)
  const after = await width(page, 'slot-left')
  await expect.poll(async () => (await page.evaluate(() => window.gitgoose.getSettings())).layout.left.size).toBeGreaterThan(before + 60)
  await first.app.close()

  const second = await launch(r.dir, { GITGOOSE_USER_DATA: profile })
  await expect(second.page.getByTestId('slot-left')).toBeVisible()
  expect(Math.abs((await width(second.page, 'slot-left')) - after)).toBeLessThan(3)
  await second.app.close()
})

test('panes stay where they are: headers are labels, not drag handles', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await expect(page.getByTestId('slot-left')).toContainText('Branches')
  await expect(page.getByTestId('slot-right')).toContainText('Details')
  await expect(page.locator('[draggable="true"][data-pane-tab]')).toHaveCount(0)
  const graph = (await page.getByTestId('graph-scroll').boundingBox())!
  expect((await page.getByTestId('slot-left').boundingBox())!.x).toBeLessThan(graph.x)
  expect((await page.getByTestId('slot-right').boundingBox())!.x).toBeGreaterThan(graph.x)
  await app.close()
})

test('the keyboard collapses and restores panels; hide and reset from the palette', async () => {
  const r = makeFixture('linear')
  r.write('file.txt', 'edited\n')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').first().click()
  await page.keyboard.press('ControlOrMeta+b')
  await expect.poll(() => width(page, 'slot-left')).toBeLessThan(2)
  await page.keyboard.press('ControlOrMeta+b')
  await expect.poll(() => width(page, 'slot-left')).toBeGreaterThan(150)

  // A file's diff opens over the graph and closes back to it.
  await page.getByTestId('wip-row').click()
  await page.getByTestId('unstaged-file').first().click()
  await expect(page.getByTestId('file-view')).toBeVisible()
  await expect(page.getByTestId('graph-scroll')).toHaveCount(0)

  await page.keyboard.press('ControlOrMeta+p')
  await page.getByTestId('palette-input').fill('Hide side panels')
  await page.keyboard.press('Enter')
  await expect.poll(() => width(page, 'slot-right')).toBeLessThan(2)
  await page.keyboard.press('ControlOrMeta+p')
  await page.getByTestId('palette-input').fill('Reset panel sizes')
  await page.keyboard.press('Enter')
  await expect.poll(() => width(page, 'slot-right')).toBeGreaterThan(300)
  await app.close()
})
