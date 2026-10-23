import { tempDir } from '@gitgoose/fixtures'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { delimiter } from 'node:path'
import { makeFixture } from '@gitgoose/fixtures'
import { launch } from './app'

test('remembers the window size between launches', async () => {
  const profile = tempDir('gitgoose-profile-')
  const first = await launch(undefined, { GITGOOSE_USER_DATA: profile }, { keepSize: true })
  await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 40, y: 30, width: 911, height: 577 }))
  await first.page.waitForTimeout(700)
  await first.app.close()

  const second = await launch(undefined, { GITGOOSE_USER_DATA: profile }, { keepSize: true })
  await expect(second.page.getByTestId('welcome')).toBeVisible()
  const size = await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds())
  expect([size.width, size.height]).toEqual([911, 577])
  await second.app.close()
})

// The title bar is the tab bar. Linux draws its own controls (Windows has the OS's, macOS the
// traffic lights), so these run where the page owns them.
test.describe('title bar', () => {
  test.skip(process.platform !== 'linux', 'the page draws the window controls on Linux only')

  /**
   * Xvfb has no window manager, and maximising is a request to one: the window never changes
   * state. So stand in for the WM: maximize()/unmaximize() flip a flag, report it through
   * isMaximized() and emit the events the real window would. Everything from the click through
   * IPC, the handler, the event and the label is real.
   */
  async function fakeWindowManager(app: ElectronApplication): Promise<() => Promise<boolean>> {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      let max = false
      win.isMaximized = () => max
      win.maximize = () => { max = true; win.emit('maximize') }
      win.unmaximize = () => { max = false; win.emit('unmaximize') }
    })
    return () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())
  }

  test('the bar is the 36 px drag region and its controls opt out', async () => {
    const { app, page } = await launch()
    const bar = page.getByTestId('tabs')
    await expect(bar).toBeVisible()
    expect((await bar.boundingBox())!.height).toBe(36)
    expect(await bar.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('drag')
    for (const name of ['Menu', 'Minimize', 'Maximize', 'Close']) {
      const region = await page.getByRole('button', { name, exact: true }).evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))
      expect(region, name).toBe('no-drag')
    }
    await app.close()
  })

  test('Maximize maximises and turns into Restore', async () => {
    const { app, page } = await launch()
    const maximized = await fakeWindowManager(app)
    expect(await maximized()).toBe(false)
    await page.getByRole('button', { name: 'Maximize', exact: true }).click()
    await expect.poll(maximized).toBe(true)
    await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect.poll(maximized).toBe(false)
    await expect(page.getByRole('button', { name: 'Maximize', exact: true })).toBeVisible()
    await app.close()
  })

  test('double-clicking the empty bar toggles maximise', async () => {
    const { app, page } = await launch()
    const maximized = await fakeWindowManager(app)
    const box = (await page.getByTestId('tabs').boundingBox())!
    await page.mouse.dblclick(box.x + box.width / 2, box.y + 18)
    await expect.poll(maximized).toBe(true)
    await page.mouse.dblclick(box.x + box.width / 2, box.y + 18)
    await expect.poll(maximized).toBe(false)
    await app.close()
  })

  test('with many tabs open the window controls stay inside the window', async () => {
    const repos = ['branches', 'branches', 'branches', 'branches', 'branches', 'branches', 'branches', 'branches'].map(() => makeFixture('branches').dir)
    const { app, page } = await launch(repos.join(delimiter))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(900, 640))
    await expect(page.locator('[data-tab]')).toHaveCount(8)
    const view = { width: await page.evaluate(() => window.innerWidth) }
    const box = (await page.getByRole('button', { name: 'Close', exact: true }).boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(view.width)
    await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeInViewport({ ratio: 1 })
    await app.close()
  })

  test('Minimize reaches the window', async () => {
    const { app, page } = await launch()
    // Xvfb has no window manager to iconify a window, so record the call instead of the result.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      const g = globalThis as unknown as { minimizeCalls: number }
      g.minimizeCalls = 0
      win.minimize = () => { g.minimizeCalls++ }
    })
    await page.getByRole('button', { name: 'Minimize', exact: true }).click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { minimizeCalls: number }).minimizeCalls)).toBe(1)
    await app.close()
  })

  test('Close closes the window', async () => {
    const { app, page } = await launch()
    const closed = app.evaluate(({ BrowserWindow }) => new Promise<boolean>((res) => BrowserWindow.getAllWindows()[0]!.once('closed', () => res(true))))
    await page.getByRole('button', { name: 'Close', exact: true }).click({ noWaitAfter: true }).catch(() => {}) // the window goes away mid-click
    expect(await closed).toBe(true)
  })

  test('the Menu button pops up the application menu', async () => {
    const { app, page } = await launch()
    // A native menu is not in the page, so stub popup on the real menu and check what it got.
    await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()!
      const g = globalThis as unknown as { popups: unknown[] }
      g.popups = []
      menu.popup = ((o: unknown) => { g.popups.push(o) }) as typeof menu.popup
    })
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { popups: unknown[] }).popups.length)).toBe(1)
    const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map((i) => i.label))
    expect(labels).toContain('File')
    await app.close()
  })
})
