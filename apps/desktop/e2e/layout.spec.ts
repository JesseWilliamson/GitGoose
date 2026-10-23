import { makeFixture, tempDir } from '@gitgoose/fixtures'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launch } from './app'

const width = async (page: Page, id: string) => (await page.getByTestId(id).boundingBox())?.width ?? 0
const height = async (page: Page, id: string) => (await page.getByTestId(id).boundingBox())?.height ?? 0

/** A native drag of a pane's tab onto a drop zone, which exists only while a tab is in the air. */
async function dragPaneTo(page: Page, pane: string, zone: string) {
  const tab = page.getByTestId(`pane-tab-${pane}`)
  const target = page.getByTestId(zone)
  // Chromium starts the drag only if the pointer moves soon after the button goes down; on a
  // loaded machine that first move can be missed, so let go and try again.
  for (let attempt = 0; attempt < 4; attempt++) {
    await tab.hover({ position: { x: 8, y: 10 } })
    await page.mouse.down()
    await page.mouse.move(300, 300, { steps: 4 })
    await page.mouse.move(310, 310)
    if (await target.isVisible()) {
      const box = (await target.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
      await page.mouse.up()
      return
    }
    await page.mouse.up()
  }
  throw new Error(`the drag of ${pane} never showed ${zone}`)
}

async function movePaneVia(page: Page, pane: string, to: string) {
  await page.getByTestId(`pane-menu-${pane}`).click()
  await page.getByRole('menuitem', { name: `Move to ${to}` }).click()
}

/** The View menu item with this label, as the native menu has it. */
const viewItem = (app: ElectronApplication, label: string) =>
  app.evaluate(({ Menu }, l) => {
    const item = Menu.getApplicationMenu()!.items.find((i) => i.label === 'View')!.submenu!.items.find((i) => i.label === l)!
    return { checked: item.checked }
  }, label)

test('dragging a divider resizes a side panel, and the size survives a restart', async () => {
  const profile = tempDir('gitgoose-profile-')
  const r = makeFixture('linear')
  const first = await launch(r.dir, { GITGOOSE_USER_DATA: profile })
  const page = first.page
  await expect(page.getByTestId('slot-left')).toBeVisible()
  const before = await width(page, 'slot-left')
  // Drag the divider 120 px to the right. The panel moves only on pointer moves, and on a
  // loaded machine it can miss the first ones (the drag is set up by a render that lands late),
  // so the drag nudges the pointer in place until the panel stops moving, then lets go, and
  // takes hold again from where the divider now is when the panel did not come along.
  for (let attempt = 0; attempt < 4 && (await width(page, 'slot-left')) <= before + 60; attempt++) {
    const sep = (await page.getByTestId('sep-left').boundingBox())!
    await page.mouse.move(sep.x + sep.width / 2, sep.y + 200)
    await page.mouse.down()
    await page.mouse.move(sep.x + 120, sep.y + 200, { steps: 8 })
    let last = -1
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(100)
      const w = await width(page, 'slot-left')
      if (w === last) break
      last = w
      await page.mouse.move(sep.x + 120 + (i % 2), sep.y + 200)
    }
    await page.mouse.up()
  }
  // Not the full 120 px: the point is that it grew by a lot and that size is kept.
  await expect.poll(() => width(page, 'slot-left')).toBeGreaterThan(before + 60)
  const after = await width(page, 'slot-left')
  await expect.poll(async () => (await page.evaluate(() => window.gitgoose.getSettings())).layout.left.size).toBeGreaterThan(before + 60)
  await first.app.close()

  const second = await launch(r.dir, { GITGOOSE_USER_DATA: profile })
  await expect(second.page.getByTestId('slot-left')).toBeVisible()
  expect(Math.abs((await width(second.page, 'slot-left')) - after)).toBeLessThan(3)
  await second.app.close()
})

test('the default arrangement: branches left, details and AI as tabs on the right, nothing below', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await expect(page.getByTestId('slot-left')).toContainText('Branches')
  await expect(page.getByTestId('slot-right').getByTestId('pane-tab-details')).toBeVisible()
  await expect(page.getByTestId('slot-right').getByTestId('pane-tab-ai')).toBeVisible()
  await expect(page.getByTestId('slot-right').locator('[data-pane]:visible')).toHaveAttribute('data-pane', 'details')
  await expect(page.getByTestId('slot-bottom')).toHaveCount(0)
  await expect(page.getByTestId('pane-drop-left')).toHaveCount(0)
  const graph = (await page.getByTestId('graph-scroll').boundingBox())!
  expect((await page.getByTestId('slot-left').boundingBox())!.x).toBeLessThan(graph.x)
  expect((await page.getByTestId('slot-right').boundingBox())!.x).toBeGreaterThan(graph.x)
  await app.close()
})

test('Details moves to the left from its tab menu, and the move survives a restart', async () => {
  const profile = tempDir('gitgoose-profile-')
  const r = makeFixture('linear')
  const first = await launch(r.dir, { GITGOOSE_USER_DATA: profile })
  const page = first.page
  await movePaneVia(page, 'details', 'left')
  await expect(page.getByTestId('slot-left').getByTestId('pane-tab-details')).toBeVisible()
  await expect(page.getByTestId('slot-left').getByTestId('pane-tab-branches')).toBeVisible()
  await expect(page.getByTestId('slot-left').locator('[data-pane]:visible')).toHaveAttribute('data-pane', 'details')
  // Left of the graph; the right slot holds only the AI pane now (its title alone is the strip).
  const graph = (await page.getByTestId('graph-scroll').boundingBox())!
  const left = (await page.getByTestId('slot-left').boundingBox())!
  expect(left.x + left.width).toBeLessThanOrEqual(graph.x + 1)
  await expect(page.getByTestId('slot-right').locator('[data-pane]:visible')).toHaveAttribute('data-pane', 'ai')
  // The slot a pane is in is greyed in its menu.
  await page.getByTestId('pane-menu-ai').click()
  await expect(page.getByRole('menuitem', { name: 'Move to right' })).toHaveAttribute('data-disabled', '')
  await page.keyboard.press('Escape')
  await first.app.close()

  const second = await launch(r.dir, { GITGOOSE_USER_DATA: profile })
  await expect(second.page.getByTestId('slot-left').getByTestId('pane-tab-details')).toBeVisible()
  await second.app.close()
})

test('dragging the AI tab to the bottom edge puts it under the graph; Hide, then View → Show AI, brings it back', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await dragPaneTo(page, 'ai', 'pane-drop-bottom')
  await expect(page.getByTestId('slot-bottom').getByTestId('ai-chat-panel')).toBeVisible()
  await expect(page.getByTestId('slot-bottom').locator('[data-pane]:visible')).toHaveAttribute('data-pane', 'ai')
  const graph = (await page.getByTestId('graph-scroll').boundingBox())!
  const bottom = (await page.getByTestId('slot-bottom').boundingBox())!
  expect(bottom.y).toBeGreaterThanOrEqual(graph.y + graph.height - 1)
  expect(bottom.height).toBeGreaterThan(150)
  // Details is alone on the right now, and the drop zones went away with the drag.
  await expect(page.getByTestId('slot-right').locator('[data-pane]:visible')).toHaveAttribute('data-pane', 'details')
  await expect(page.getByTestId('pane-drop-bottom')).toHaveCount(0)
  expect(await viewItem(app, 'Show AI')).toEqual({ checked: true })

  // Hide: in no slot at all, and the bottom slot disappears with its last pane.
  await page.getByTestId('pane-menu-ai').click()
  await page.getByRole('menuitem', { name: 'Hide' }).click()
  await expect(page.getByTestId('slot-bottom')).toHaveCount(0)
  await expect(page.getByTestId('ai-chat-panel')).toHaveCount(0)
  await expect.poll(() => viewItem(app, 'Show AI')).toEqual({ checked: false })

  // View → Show AI: back in its home slot, as a tab next to Details.
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()!.items.find((i) => i.label === 'View')!.submenu!.items.find((i) => i.label === 'Show AI')!.click()
  })
  await expect(page.getByTestId('slot-right').getByTestId('ai-chat-panel')).toBeVisible()
  await expect(page.getByTestId('slot-right').getByTestId('pane-tab-details')).toBeVisible()
  await expect.poll(() => viewItem(app, 'Show AI')).toEqual({ checked: true })
  await app.close()
})

test('a tab dropped on another slot\'s tab strip lands at that position', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  const tab = page.getByTestId('pane-tab-ai')
  const strip = page.getByTestId('tabs-left')
  for (let attempt = 0; attempt < 4; attempt++) {
    await tab.hover({ position: { x: 8, y: 10 } })
    await page.mouse.down()
    await page.mouse.move(300, 300, { steps: 4 })
    await page.mouse.move(310, 310)
    const box = (await strip.boundingBox())!
    // The left half of the only tab there (x 30 is clear of the 24 px edge zone): before it.
    await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    if (await page.getByTestId('slot-left').getByTestId('pane-tab-ai').count()) break
  }
  const tabs = page.getByTestId('slot-left').locator('[data-pane-tab]')
  await expect(tabs).toHaveCount(2)
  await expect(tabs.first()).toHaveAttribute('data-pane-tab', 'ai')
  await app.close()
})

test('Mod+J collapses and expands the bottom slot, and does nothing while it is empty', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.getByTestId('slot-bottom')).toHaveCount(0)
  await movePaneVia(page, 'ai', 'bottom')
  await expect.poll(() => height(page, 'slot-bottom')).toBeGreaterThan(150)
  await page.keyboard.press('ControlOrMeta+j')
  await expect.poll(() => height(page, 'slot-bottom')).toBeLessThan(2)
  await page.keyboard.press('ControlOrMeta+j')
  await expect.poll(() => height(page, 'slot-bottom')).toBeGreaterThan(150)
  await app.close()
})

test('Mod+Shift+A shows the AI pane and focuses it, then hides it from its own composer; Reset layout restores the default', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await expect(page.getByTestId('commit-row').first()).toBeVisible()
  await expect(page.getByTestId('ai-chat-panel')).toHaveCount(0) // behind the Details tab
  await page.keyboard.press('ControlOrMeta+Shift+A')
  await expect(page.getByTestId('slot-right').getByTestId('ai-chat-panel')).toBeVisible()
  await expect(page.getByTestId('thread-input')).toBeFocused()
  await page.keyboard.press('ControlOrMeta+Shift+A')
  await expect(page.getByTestId('ai-chat-panel')).toHaveCount(0)
  await expect(page.getByTestId('pane-tab-ai')).toHaveCount(0)

  await page.keyboard.press('ControlOrMeta+p')
  await page.getByTestId('palette-input').fill('Reset layout')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('slot-right').getByTestId('pane-tab-ai')).toBeVisible()
  await expect(page.getByTestId('slot-right').locator('[data-pane]:visible')).toHaveAttribute('data-pane', 'details')
  await app.close()
})

test('the keyboard shows and hides panes; hide side panels and reset from the palette', async () => {
  const r = makeFixture('linear')
  r.write('file.txt', 'edited\n')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').first().click()
  await page.keyboard.press('ControlOrMeta+b')
  await expect(page.getByTestId('slot-left')).toHaveCount(0)
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
  await page.getByTestId('palette-input').fill('Reset layout')
  await page.keyboard.press('Enter')
  await expect.poll(() => width(page, 'slot-right')).toBeGreaterThan(300)
  await app.close()
})
