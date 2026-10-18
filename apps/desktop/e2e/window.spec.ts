import { tempDir } from '@gitsquid/fixtures'
import { expect, test } from '@playwright/test'
import { launch } from './app'

test('remembers the window size between launches', async () => {
  const profile = tempDir('gitsquid-profile-')
  const first = await launch(undefined, { GITSQUID_USER_DATA: profile }, { keepSize: true })
  await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 40, y: 30, width: 911, height: 577 }))
  await first.page.waitForTimeout(700)
  await first.app.close()

  const second = await launch(undefined, { GITSQUID_USER_DATA: profile }, { keepSize: true })
  await expect(second.page.getByTestId('welcome')).toBeVisible()
  const size = await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds())
  expect([size.width, size.height]).toEqual([911, 577])
  await second.app.close()
})
