import { makeFixture, tempDir } from '@gitsquid/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { launch } from './app'

const width = async (page: Page, id: string) => (await page.getByTestId(id).boundingBox())?.width ?? 0

test('dragging a divider resizes a side panel, and the size survives a restart', async () => {
  const profile = tempDir('gitsquid-profile-')
  const r = makeFixture('linear')
  const first = await launch(r.dir, { GITSQUID_USER_DATA: profile })
  const page = first.page
  await expect(page.getByTestId('slot-left')).toBeVisible()
  const before = await width(page, 'slot-left')
  const sep = (await page.getByTestId('sep-left').boundingBox())!
  await page.mouse.move(sep.x + sep.width / 2, sep.y + 200)
  await page.mouse.down()
  await page.mouse.move(sep.x + 120, sep.y + 200, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => width(page, 'slot-left')).toBeGreaterThan(before + 100)
  const after = await width(page, 'slot-left')
  await expect.poll(async () => (await page.evaluate(() => window.gitsquid.getSettings())).layout.left.size).toBeGreaterThan(before + 100)
  await first.app.close()

  const second = await launch(r.dir, { GITSQUID_USER_DATA: profile })
  await expect(second.page.getByTestId('slot-left')).toBeVisible()
  expect(Math.abs((await width(second.page, 'slot-left')) - after)).toBeLessThan(3)
  await second.app.close()
})

test('dragging a pane tab moves it to another side', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  // The drop zones appear only once a drag starts, so drive the mouse by hand.
  const tab = (await page.getByTestId('pane-tab-details').boundingBox())!
  await page.mouse.move(tab.x + 10, tab.y + tab.height / 2)
  await page.mouse.down()
  await page.mouse.move(tab.x - 40, tab.y + 60, { steps: 5 })
  const zone = (await page.getByTestId('drop-left').boundingBox())!
  await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(page.getByTestId('slot-right')).toHaveCount(0)
  const left = page.getByTestId('slot-left')
  await expect(left.getByTestId('pane-tab-details')).toBeVisible()
  await expect(left.getByTestId('pane-tab-branches')).toBeVisible()
  // Details is now the active tab on the left, left of the graph.
  await expect(left.getByTestId('detail-panel')).toBeVisible()
  const graph = (await page.getByTestId('graph-scroll').boundingBox())!
  expect((await left.boundingBox())!.x).toBeLessThan(graph.x)
  // Tabs switch.
  await left.getByTestId('pane-tab-branches').click()
  await expect(left.getByTestId('sidebar')).toBeVisible()
  await app.close()
})

test('the keyboard collapses and restores panels; presets and reset work', async () => {
  const r = makeFixture('linear')
  r.write('file.txt', 'edited\n')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').first().click()
  await page.keyboard.press('Control+b')
  await expect.poll(() => width(page, 'slot-left')).toBeLessThan(2)
  await page.keyboard.press('Control+b')
  await expect.poll(() => width(page, 'slot-left')).toBeGreaterThan(150)

  // Diff below the graph: both visible at once.
  await page.keyboard.press('Control+j')
  await page.getByTestId('wip-row').click()
  await page.getByTestId('unstaged-file').first().click()
  await expect(page.getByTestId('slot-bottom').getByTestId('file-view')).toBeVisible()
  await expect(page.getByTestId('graph-scroll')).toBeVisible()

  await page.keyboard.press('Control+k')
  await page.getByTestId('palette-input').fill('Default layout')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('slot-bottom')).toHaveCount(0)
  // With the diff no longer docked, the open file shows over the graph again.
  await expect(page.getByTestId('file-view')).toBeVisible()
  await expect(page.getByTestId('graph-scroll')).toHaveCount(0)
  await app.close()
})
