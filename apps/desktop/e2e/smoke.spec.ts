import { makeFixture } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { launch } from './app'

test('shows the welcome screen with no repository', async () => {
  const { app, page } = await launch()
  await expect(page.getByTestId('welcome')).toBeVisible()
  await app.close()
})

test('opens a repository and draws the graph', async () => {
  const r = makeFixture('branches')
  r.write('a.txt', 'changed\n')
  const { app, page } = await launch(r.dir)
  await expect(page.getByTestId('commit-row')).toHaveCount(7)
  await expect(page.getByTestId('wip-row')).toBeVisible()
  await expect(page.getByTestId('ref-pill').filter({ hasText: 'main' })).toBeVisible()
  await page.screenshot({ path: 'test-results/graph.png' })
  await app.close()
})

test('shows the repository and what HEAD is on at the top left', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  await expect(page.getByTestId('location-repo')).toHaveText(r.dir.split(/[\\/]/).pop()!)
  await expect(page.getByTestId('location-head')).toHaveText('main')
  await app.close()

  // Detached: the short commit hash stands in for the branch.
  r.checkout('--detach', 'main~1')
  const second = await launch(r.dir)
  await expect(second.page.getByTestId('location-head')).toHaveText(r.head().slice(0, 7))
  await second.app.close()
})
