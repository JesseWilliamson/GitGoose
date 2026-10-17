import { makeFixture } from '@gitsquid/fixtures'
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

test('stashes appear in the graph beside their base commit, with their own menu', async () => {
  const r = makeFixture('stash')
  const { app, page } = await launch(r.dir)
  const stashRows = page.getByTestId('commit-row').filter({ has: page.getByTestId('stash-node') })
  await expect(stashRows).toHaveCount(2)
  await expect(stashRows.first()).toContainText('stash@{0}')
  await expect(stashRows.first()).toContainText('second stash')
  // The base commit is the only real commit; the stash helper commits are not shown.
  await expect(page.getByTestId('commit-row')).toHaveCount(3)

  await stashRows.nth(1).click({ button: 'right' })
  await expect(page.getByRole('menu')).toContainText('stash@{1}: first stash')
  await page.getByRole('menuitem', { name: 'Pop stash' }).click()
  await expect(stashRows).toHaveCount(1)
  await expect.poll(() => readFileSync(join(r.dir, 'x.txt'), 'utf8')).toBe('changed once\n')

  // Settings → Graph can turn them off.
  await page.evaluate(() => window.gitsquid.setSettings({ showStashes: false }))
  await expect(stashRows).toHaveCount(0)
  await expect(page.getByTestId('commit-row')).toHaveCount(1)
  await app.close()
})
