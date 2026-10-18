import { FixtureRepo, initRepo, makeLargeRepo } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { launch } from './app'

function setup() {
  const r = initRepo()
  r.commit('feat: price lines with tax', { 'src/pricing/taxRate.ts': 'export const rate = 0.2\n', 'README.md': '# shop\n' })
  const fix = r.commit('fix: round totals to cents', { 'src/pricing/totals.ts': 'export const total = 1\n' })
  r.git('branch', 'feature/receipts')
  r.git('tag', 'v1.0.0')
  r.write('src/pricing/totals.ts', 'export const total = 2\n')
  return { r, fix }
}

test('one search for commits, files, settings and commands; results open where they belong', async () => {
  const { r, fix } = setup()
  const { app, page } = await launch(r.dir)
  await expect(page.getByTestId('commit-row').first()).toBeVisible()
  const input = page.getByTestId('palette-input')
  const items = page.getByTestId('omni-item')

  // Nothing typed: suggestions and what is being changed.
  await page.getByTestId('omni-open').click()
  await expect(page.getByTestId('omni-results')).toContainText('Suggestions')
  await expect(items.filter({ hasText: 'src/pricing/totals.ts' })).toHaveAttribute('data-kind', 'change')

  // A commit, by its message (git searches; results join when they arrive).
  await input.fill('round totals')
  const commit = items.filter({ hasText: 'fix: round totals to cents' })
  await expect(commit).toHaveAttribute('data-kind', 'commit')
  await expect(commit.locator('mark')).toHaveText(['round', 'totals'])
  await commit.click()
  await expect(page.getByTestId('omni')).toHaveCount(0)
  await expect(page.locator(`[data-testid="commit-row"][data-hash="${fix}"]`)).toHaveAttribute('data-selected', 'true')

  // A file by name: its history opens. The highlight follows the best result while results
  // arrive (the file list comes after the first keystroke), so Enter right away picks the file.
  await page.keyboard.press('ControlOrMeta+k')
  await input.fill('taxrate')
  await expect(items.first()).toHaveAttribute('data-kind', 'file')
  await expect(items.first()).toHaveAttribute('data-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('file-view')).toContainText('taxRate.ts')

  // A setting: the settings page opens, searched for it.
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('omni-scope-setting').click()
  await input.fill('compact rows')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('settings-search')).toHaveValue('Compact graph rows')
  await page.keyboard.press('Escape')

  // Recent remembers what was picked; ">" limits to commands.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByTestId('omni-results')).toContainText('Recent')
  await expect(items.first()).toContainText('Compact graph rows')
  await input.fill('> receipts')
  await expect(page.getByTestId('omni-empty')).toContainText('No results for “receipts”')
  await input.fill('receipts')
  await expect(items.first()).toHaveAttribute('data-kind', 'branch')
  await app.close()
})

test('Tab narrows to one kind and shows more of it', async () => {
  const r = initRepo()
  r.commit('root', Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`docs/page-${i}.md`, `${i}\n`])))
  const { app, page } = await launch(r.dir)
  await expect(page.getByTestId('commit-row').first()).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill('page')
  await expect(page.getByTestId('omni-results')).toContainText('8 of 30 · Tab to narrow')
  // All → Commands → Branches → Commits → Files
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab')
  await expect(page.getByTestId('omni-scope-file')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('omni-item')).toHaveCount(30)
  await app.close()
})

test('a stash hidden from the graph opens without loading the whole history', async () => {
  const dir = makeLargeRepo(8000)
  const r = new FixtureRepo(dir)
  r.write('main.txt', 'work in progress\n')
  r.git('stash', 'push', '-m', 'half-done pricing')
  const { app, page } = await launch(dir)
  await page.evaluate(() => window.gitgoose.setSettings({ showStashes: false }))
  const count = page.getByTestId('commit-count')
  await expect(count).toContainText('+')

  await page.getByTestId('omni-open').click()
  await page.getByTestId('palette-input').fill('half-done')
  const stash = page.getByTestId('omni-item').filter({ hasText: 'half-done pricing' })
  await expect(stash).toHaveAttribute('data-kind', 'stash')
  await stash.click()
  await expect(page.getByTestId('detail-panel')).toContainText('half-done pricing')
  // Looking for the stash in the log would keep loading pages until all 8,000 commits are in.
  await page.waitForTimeout(1500)
  await expect(count).toContainText('+')
  await app.close()
})
