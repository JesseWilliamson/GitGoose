import { initRepo, tempDir } from '@gitgoose/fixtures'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { launch } from './app'

/**
 * An item that cannot run is greyed, not missing, and says why. shadcn items are
 * pointer-events: none when disabled, so the tooltip hangs on the wrapper: move the pointer onto it.
 */
async function expectDisabledWith(page: Page, item: Locator, reason: string) {
  await expect(item).toHaveAttribute('aria-disabled', 'true')
  await expect(item).toHaveAttribute('aria-description', reason)
  // A long menu scrolls: bring the item into view first.
  await item.scrollIntoViewIfNeeded()
  const at = (await item.boundingBox())!
  await page.mouse.move(at.x + 20, at.y + at.height / 2, { steps: 8 })
  await page.mouse.move(at.x + 60, at.y + at.height / 2, { steps: 8 })
  await expect(page.getByRole('tooltip').first()).toHaveText(reason, { timeout: 10_000 })
}

/** base - A (on main) - side branch work - M (merge, HEAD) - after */
function mergedRepo() {
  const r = initRepo()
  r.commit('base', { 'a.txt': 'a\n' })
  r.checkout('-b', 'side')
  r.commit('side work', { 's.txt': 's\n' })
  r.checkout('main')
  r.commit('main work', { 'm.txt': 'm\n' })
  const M = r.merge('side', 'Merge side')
  r.commit('after merge', { 'z.txt': 'z\n' })
  return { r, M }
}
const row = (page: Page, subject: string) => page.locator('[data-testid="commit-row"]', { hasText: subject }).first()

test('a merge commit cannot be recomposed or split, and the menu says why', async () => {
  const { r, M } = mergedRepo()
  const { app, page } = await launch(r.dir)
  await page.evaluate(() => window.gitgoose.setSettings({ aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: 'true' } as never))
  await page.locator(`[data-testid="commit-row"][data-hash="${M}"]`).getByText('Merge side', { exact: true }).click({ button: 'right' })
  const split = page.getByRole('menuitem', { name: 'Split with AI…' })
  await expectDisabledWith(page, split, 'Recompose cannot include a merge commit')
  // The edit items are there too, greyed: a merge is not something the app can replay.
  await expect(page.getByRole('menuitem', { name: 'Reword…' })).toHaveAttribute('aria-disabled', 'true')
  await app.close()
})

test('a commit below a merge says it must be newer than the last merge; one above it is fine', async () => {
  const { r } = mergedRepo()
  const { app, page } = await launch(r.dir)
  await page.evaluate(() => window.gitgoose.setSettings({ aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: 'true' } as never))
  await row(page, 'main work').getByText('main work', { exact: true }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Split with AI…' })).toHaveAttribute('aria-description', /newer than its last merge/)
  await page.keyboard.press('Escape')
  await row(page, 'after merge').getByText('after merge', { exact: true }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Split with AI…' })).not.toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByRole('menuitem', { name: 'Reword…' })).not.toHaveAttribute('aria-disabled', 'true')
  await app.close()
})

test('the HEAD commit cannot be checked out detached or cherry-picked', async () => {
  const { r } = mergedRepo()
  const { app, page } = await launch(r.dir)
  await row(page, 'after merge').getByText('after merge', { exact: true }).click({ button: 'right' })
  await expectDisabledWith(page, page.getByRole('menuitem', { name: 'Check out this commit (detached)' }), 'This is HEAD')
  await expect(page.getByRole('menuitem', { name: /^Cherry-pick onto/ })).toHaveAttribute('aria-description', 'This is HEAD')
  await app.close()
})

test('with AI off the AI items are there, greyed, and point to Settings', async () => {
  const { r } = mergedRepo()
  const { app, page } = await launch(r.dir)
  await row(page, 'after merge').getByText('after merge', { exact: true }).click({ button: 'right' })
  await expectDisabledWith(page, page.getByRole('menuitem', { name: 'Review this commit with AI' }), 'Turn on AI features in Settings → AI')
  await expect(page.getByRole('menuitem', { name: 'Split with AI…' })).toHaveAttribute('aria-description', 'Turn on AI features in Settings → AI')
  await app.close()
})

test('the checked-out branch cannot be deleted, and says why; another branch can', async () => {
  const { r } = mergedRepo()
  const { app, page } = await launch(r.dir)
  await page.locator('[data-testid="ref-pill"][data-ref="refs/heads/main"]').first().click({ button: 'right' })
  await expectDisabledWith(page, page.getByRole('menuitem', { name: 'Delete main' }), 'The current branch cannot be deleted: check out another branch first')
  await expect(page.getByRole('menuitem', { name: 'Check out main' })).toHaveAttribute('aria-description', 'This branch is checked out')
  // Escape closes the tooltip first, then the menu.
  await expect(async () => { await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 500 }) }).toPass()
  await page.locator('[data-testid="ref-pill"][data-ref="refs/heads/side"]').first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Delete side' })).not.toHaveAttribute('aria-disabled', 'true')
  await app.close()
})

test('Recompose works on the root commit, but drop and move cannot (greyed)', async () => {
  const r = initRepo()
  const root = r.commit('root', { 'a.txt': 'a\n' })
  r.commit('second', { 'b.txt': 'b\n' })
  const { app, page } = await launch(r.dir)
  await page.evaluate(() => window.gitgoose.setSettings({ aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: 'true' } as never))
  await page.locator(`[data-testid="commit-row"][data-hash="${root}"]`).getByText('root', { exact: true }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Split with AI…' })).not.toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByRole('menuitem', { name: 'Drop commit' })).toHaveAttribute('aria-disabled', 'true')
  await app.close()
})

test('what does not exist here is left out, not greyed: no remote, no remote actions or pull request', async () => {
  const { r } = mergedRepo()
  const { app, page } = await launch(r.dir)
  await page.locator('[data-testid="ref-pill"][data-ref="refs/heads/side"]').first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Delete side' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'More remote actions' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Create pull request…' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: /^Publish / })).toHaveCount(0)
  await app.close()
})

test('the fullest menus fit the window without scrolling', async () => {
  const bare = tempDir('bare')
  const r = initRepo()
  r.commit('base', { 'a.txt': 'a\n' })
  r.git('init', '-q', '--bare', bare)
  r.git('remote', 'add', 'origin', 'https://github.com/x/y.git')
  r.git('config', 'remote.origin.pushurl', bare)
  r.commit('two', { 'b.txt': 'b\n' })
  r.git('push', '-q', '-u', 'origin', 'main')
  r.git('fetch', '-q', bare, '+refs/heads/*:refs/remotes/origin/*')
  r.checkout('-b', 'dev')
  r.commit('dev work', { 'd.txt': 'd\n' })
  r.git('branch', '--set-upstream-to=origin/main', 'dev')
  r.checkout('main')
  r.commit('three', { 'c.txt': 'c\n' })
  const { app, page } = await launch(r.dir)
  // AI on and everything editable: every conditional item is present.
  await page.evaluate(() => window.gitgoose.setSettings({ aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: 'true' } as never))
  const fits = async () => {
    const m = await page.evaluate(() => { const el = document.querySelector('[role="menu"]') as HTMLElement; return { client: el.clientHeight, scroll: el.scrollHeight, win: window.innerHeight } })
    expect(m.scroll, `menu content ${m.scroll}px in a ${m.client}px menu (window ${m.win}px)`).toBeLessThanOrEqual(m.client)
  }
  const close = () => expect(async () => { await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 400 }) }).toPass()
  await page.locator('[data-testid="ref-pill"][data-ref="refs/heads/dev"]').first().click({ button: 'right' })
  await fits()
  await close()
  await page.locator('[data-testid="ref-pill"][data-ref="refs/heads/main"]').first().click({ button: 'right' })
  await fits()
  await close()
  await page.locator('[data-testid="commit-row"]', { hasText: 'three' }).first().getByText('three', { exact: true }).click({ button: 'right' })
  await fits()
  await close()
  // A branch tip: the branch's actions come first (one submenu), then the commit's.
  await page.locator('[data-testid="commit-row"]', { hasText: 'dev work' }).first().getByText('dev work', { exact: true }).click({ button: 'right' })
  await fits()
  await app.close()
})
