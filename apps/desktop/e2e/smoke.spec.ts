import { makeFixture } from '@gitsquid/fixtures'
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
