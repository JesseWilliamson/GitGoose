import { initRepo, tempDir } from '@gitgoose/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { launch, pickFromSubmenu } from './app'

/**
 * main: A - B; feature/login and feature/ui/menu at A (each one commit of its own); fix at B.
 * Tags v1 (A) and v2 (B), one stash.
 */
function setup() {
  const r = initRepo()
  const A = r.commit('A', { 'a.txt': 'a\n' })
  r.git('checkout', '-q', '-b', 'feature/login')
  const login = r.commit('login work', { 'login.txt': 'l\n' })
  r.git('checkout', '-q', '-b', 'feature/ui/menu', A)
  const menu = r.commit('menu work', { 'menu.txt': 'm\n' })
  r.checkout('main')
  const B = r.commit('B', { 'b.txt': 'b\n' })
  r.git('branch', 'fix')
  r.git('tag', 'v1', A)
  r.git('tag', 'v2', B)
  r.write('wip.txt', 'w\n')
  r.git('stash', 'push', '-u', '-q', '-m', 'half done')
  return { r, A, B, login, menu }
}

const sidebar = (page: Page) => page.getByTestId('sidebar')
const ref = (page: Page, name: string) => page.locator(`[data-testid="sidebar-ref"][data-ref="${name}"]`)
const folder = (page: Page, path: string) => page.locator(`[data-testid="sidebar-folder"][data-section="branches"][data-path="${path}"]`)
/** The names shown in a sidebar section, top to bottom (without their badges). */
const names = (page: Page, sec: string) => page.locator(`[data-testid="sidebar-ref"][data-section="${sec}"] [data-testid="ref-label"]`)
const section = (page: Page, name: string) => page.locator(`[data-testid="sidebar-section"][data-section="${name}"]`)
const row = (page: Page, hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)
/** The sidebar's rows, top to bottom, as the text a person reads. */
const labels = (page: Page) => sidebar(page).locator('[data-testid="sidebar-section"], [data-testid="workspace-item"], [data-testid="sidebar-folder"], [data-testid="sidebar-ref"]')
  .evaluateAll((els) => els.map((e) => [e.getAttribute('data-testid'), (e.querySelector('[data-testid="ref-label"]') ?? e).textContent!.replace(/\d+$/, '').trim()].join(':')))

test('sidebar sections; branches as a folder tree that remembers what is folded', async () => {
  const { r } = setup()
  const profile = tempDir('gitgoose-profile-')
  let { app, page } = await launch(r.dir, { GITGOOSE_USER_DATA: profile })
  await expect(ref(page, 'refs/heads/main')).toBeVisible()
  expect(await labels(page)).toEqual([
    'sidebar-section:Workspace', 'workspace-item:Working Copy', 'workspace-item:History', 'workspace-item:Stashes', 'workspace-item:Reflog',
    'sidebar-section:Pinned',
    'sidebar-section:Branches', 'sidebar-folder:feature', 'sidebar-folder:ui', 'sidebar-ref:menu', 'sidebar-ref:login', 'sidebar-ref:fix', 'sidebar-ref:main',
    'sidebar-section:Remotes', 'sidebar-section:Tags', 'sidebar-section:Worktrees',
  ])
  // HEAD's branch is bold with a check; the stash sits under Stashes.
  await expect(ref(page, 'refs/heads/main')).toHaveClass(/font-semibold/)
  await expect(page.getByTestId('stash-item')).toContainText('half done')

  // Fold a folder; open Tags (newest first). Both are remembered after a restart.
  await folder(page, 'feature').click()
  await expect(ref(page, 'refs/heads/feature/login')).toHaveCount(0)
  await section(page, 'tags').getByRole('button').first().click()
  await expect(names(page, 'tags')).toHaveText(['v2', 'v1'])
  await app.close()
  ;({ app, page } = await launch(r.dir, { GITGOOSE_USER_DATA: profile }))
  await expect(ref(page, 'refs/tags/v2')).toBeVisible()
  await expect(folder(page, 'feature')).toBeVisible()
  await expect(ref(page, 'refs/heads/feature/login')).toHaveCount(0)

  // The gear turns folders off (for every repository): full names, no folders.
  await page.getByTestId('sidebar-gear').click()
  await page.getByTestId('gear-folders').click()
  await page.keyboard.press('Escape')
  await expect(folder(page, 'feature')).toHaveCount(0)
  await expect(ref(page, 'refs/heads/feature/login').getByTestId('ref-label')).toHaveText('feature/login')
  await app.close()
})

test('the filter box flattens the tree while it has text, and the tree comes back as it was', async () => {
  const { r } = setup()
  const { app, page } = await launch(r.dir)
  await folder(page, 'feature/ui').click()
  await expect(ref(page, 'refs/heads/feature/ui/menu')).toHaveCount(0)
  await page.getByTestId('sidebar-filter').fill('ME')
  // Flat, full names, matches only, folded folders searched too.
  await expect(names(page, 'branches')).toHaveText(['feature/ui/menu'])
  await expect(page.getByTestId('sidebar-folder')).toHaveCount(0)
  await page.getByTestId('sidebar-filter').fill('v')
  await expect(names(page, 'tags')).toHaveText(['v2', 'v1'])
  // Esc in the box clears it.
  await page.getByTestId('sidebar-filter').press('Escape')
  await expect(folder(page, 'feature/ui')).toBeVisible()
  await expect(ref(page, 'refs/heads/feature/ui/menu')).toHaveCount(0)
  await expect(ref(page, 'refs/heads/feature/login')).toBeVisible()
  await app.close()
})

test('a click shows the branch\'s history; Ctrl-click adds one; History and Esc show everything again', async () => {
  const { r, B, login, menu } = setup()
  const { app, page } = await launch(r.dir)
  await expect(row(page, login)).toBeVisible()
  await ref(page, 'refs/heads/feature/login').click()
  await expect(page.getByTestId('sidebar-viewing')).toContainText('Viewing the history of feature/login')
  await expect(page.getByTestId('graph-filter')).toContainText('Showing only feature/login')
  await expect(row(page, menu)).toHaveCount(0)
  // The branch's tip is selected; HEAD's branch always shows.
  await expect(row(page, login)).toHaveAttribute('data-selected', 'true')
  await expect(row(page, B)).toBeVisible()

  await ref(page, 'refs/heads/feature/ui/menu').click({ modifiers: ['ControlOrMeta'] })
  await expect(row(page, menu)).toBeVisible()
  await expect(page.getByTestId('graph-filter')).toContainText('Showing only feature/login, feature/ui/menu')

  await page.locator('[data-testid="workspace-item"][data-item="history"]').click()
  await expect(page.getByTestId('graph-filter')).toHaveCount(0)
  await expect(row(page, menu)).toBeVisible()

  await ref(page, 'refs/heads/fix').click()
  await expect(page.getByTestId('graph-filter')).toContainText('Showing only fix')
  await sidebar(page).press('Escape')
  await expect(page.getByTestId('graph-filter')).toHaveCount(0)

  // A double-click checks out, and leaves the graph showing everything.
  await ref(page, 'refs/heads/fix').dblclick()
  await expect.poll(() => r.git('branch', '--show-current').trim()).toBe('fix')
  await expect(page.getByTestId('graph-filter')).toHaveCount(0)
  await app.close()
})

test('Reveal in History jumps without filtering; the gear can make that what a click does', async () => {
  const { r, login, menu } = setup()
  const { app, page } = await launch(r.dir)
  await ref(page, 'refs/heads/feature/login').click({ button: 'right' })
  await pickFromSubmenu(page, 'In the graph', 'Reveal in History')
  await expect(row(page, login)).toHaveAttribute('data-selected', 'true')
  await expect(page.getByTestId('graph-filter')).toHaveCount(0)

  await page.getByTestId('sidebar-gear').click()
  await page.getByTestId('gear-click-reveal').click()
  await page.keyboard.press('Escape')
  await ref(page, 'refs/heads/feature/ui/menu').click()
  await expect(row(page, menu)).toHaveAttribute('data-selected', 'true')
  await expect(page.getByTestId('graph-filter')).toHaveCount(0)
  await app.close()
})

test('the keyboard: arrows move and fold, Space shows history, Enter checks out, Delete deletes with Undo, Mod+0 finds HEAD', async () => {
  const { r } = setup()
  const { app, page } = await launch(r.dir)
  const cursor = sidebar(page).locator('.bg-select')
  // A click on a folder folds it and puts the cursor there; → opens it, ← folds it, ↓ goes in.
  await folder(page, 'feature').click()
  await expect(cursor).toHaveAttribute('data-path', 'feature')
  await expect(ref(page, 'refs/heads/feature/login')).toHaveCount(0)
  await sidebar(page).press('ArrowRight')
  await expect(ref(page, 'refs/heads/feature/login')).toHaveCount(1)
  await sidebar(page).press('ArrowLeft')
  await expect(ref(page, 'refs/heads/feature/login')).toHaveCount(0)
  await sidebar(page).press('ArrowRight')
  await sidebar(page).press('ArrowDown')
  await expect(cursor).toHaveAttribute('data-path', 'feature/ui')
  await sidebar(page).press('ArrowDown')
  await sidebar(page).press('ArrowDown')
  await expect(cursor).toHaveAttribute('data-ref', 'refs/heads/feature/login')
  // ← from a branch goes to its folder.
  await sidebar(page).press('ArrowLeft')
  await expect(cursor).toHaveAttribute('data-path', 'feature')
  await sidebar(page).press('ArrowDown')
  await sidebar(page).press('ArrowDown')
  await sidebar(page).press('ArrowDown')

  await sidebar(page).press(' ')
  await expect(page.getByTestId('graph-filter')).toContainText('Showing only feature/login')
  await sidebar(page).press('Escape')
  await expect(page.getByTestId('graph-filter')).toHaveCount(0)

  await sidebar(page).press('Enter')
  await expect.poll(() => r.git('branch', '--show-current').trim()).toBe('feature/login')

  // Mod+0 goes back to HEAD's branch (opening its folder), wherever the cursor was.
  await folder(page, 'feature').click()
  await sidebar(page).press('ControlOrMeta+0')
  await expect(cursor).toHaveAttribute('data-ref', 'refs/heads/feature/login')

  // Delete a branch from the keyboard: undoable. fix is not in feature/login, so git asks first.
  await ref(page, 'refs/heads/fix').click()
  await sidebar(page).press('Delete')
  await page.getByRole('button', { name: 'Delete anyway' }).click()
  await expect(ref(page, 'refs/heads/fix')).toHaveCount(0)
  await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).first().click()
  await expect(ref(page, 'refs/heads/fix')).toHaveCount(1)
  await app.close()
})

test('Workspace: Working Copy, Stashes and Reflog, by click and by shortcut; pin from the menu', async () => {
  const { r } = setup()
  r.write('notes.txt', 'n\n')
  const { app, page } = await launch(r.dir)
  await page.locator('[data-testid="workspace-item"][data-item="history"]').click()
  await expect(page.getByTestId('wip-row')).not.toHaveAttribute('data-selected', 'true')
  await page.keyboard.press('ControlOrMeta+Alt+1')
  await expect(page.getByTestId('wip-row')).toHaveAttribute('data-selected', 'true')
  await page.locator('[data-testid="workspace-item"][data-item="stashes"]').click()
  await expect(page.getByTestId('stash-item')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Alt+3')
  await expect(page.getByTestId('stash-item')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+Alt+5')
  await expect(page.getByTestId('reflog')).toBeVisible()

  await ref(page, 'refs/heads/fix').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Pin fix' }).click()
  await expect(names(page, 'pinned')).toHaveText(['fix'])
  expect(r.git('config', '--get-all', 'gitgoose.pin').trim()).toBe('fix')
  await page.locator('[data-testid="sidebar-ref"][data-section="pinned"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Unpin fix' }).click()
  await expect(page.locator('[data-testid="sidebar-ref"][data-section="pinned"]')).toHaveCount(0)
  await app.close()
})

test('2,000 branches and tags: the sidebar renders only what is on screen', async () => {
  const r = initRepo()
  r.commit('A', { 'a.txt': 'a\n' })
  const refs = Array.from({ length: 1000 }, (_, i) => `create refs/heads/team${i % 25}/topic-${i} HEAD\ncreate refs/tags/t${i} HEAD`).join('\n')
  execFileSync('git', ['update-ref', '--stdin'], { cwd: r.dir, input: refs + '\n' })
  const { app, page } = await launch(r.dir)
  await expect(section(page, 'branches')).toContainText('1001')
  // Far below the branches, Tags is not even in the DOM until they are folded away.
  await expect(section(page, 'tags')).toHaveCount(0)
  await section(page, 'branches').getByRole('button').first().click()
  await section(page, 'tags').getByRole('button').first().click()
  // A few dozen rows in the DOM, not thousands.
  expect(await sidebar(page).locator('[data-testid="sidebar-ref"], [data-testid="sidebar-folder"]').count()).toBeLessThan(80)
  // The filter still finds any of them.
  await page.getByTestId('sidebar-filter').fill('topic-999')
  await expect(names(page, 'branches')).toHaveText(['team24/topic-999'])
  await app.close()
})
