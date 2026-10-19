import { initRepo, makeFixture } from '@gitgoose/fixtures'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

/**
 * The drop matrix (docs/specs/003-branches-and-remotes.md), driven in the app: the badge says
 * what will happen, with and without Alt; the drop does it in git; local drops offer Undo and
 * drops that change a remote ask first.
 */

/**
 * Drag `from` over `to` with the mouse, check the badge, then drop. Alt is pressed once the drag
 * is over the target (as a person would), and one more move makes the page see it.
 */
async function drag(page: Page, from: Locator, to: Locator, opts: { alt?: boolean; badge?: string | RegExp; other?: string | RegExp; at?: number } = {}) {
  await from.scrollIntoViewIfNeeded()
  await from.hover()
  await page.mouse.down()
  await to.scrollIntoViewIfNeeded()
  const box = (await to.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height * (opts.at ?? 0.5)
  await page.mouse.move(x, y, { steps: 6 })
  if (opts.alt) await page.keyboard.down('Alt')
  await page.mouse.move(x + 1, y)
  const badge = page.getByTestId('drag-badge')
  if (opts.badge) await expect(badge.getByTestId('drag-badge-label')).toHaveText(opts.badge)
  if (opts.other) await expect(badge.getByTestId('drag-badge-alt')).toHaveText(opts.other)
  await page.mouse.up()
  if (opts.alt) await page.keyboard.up('Alt')
  await expect(badge).toBeHidden()
}

const pill = (page: Page, name: string) => page.locator(`[data-testid="ref-pill"][data-ref="${name}"]`)
const branch = (page: Page, name: string) => page.locator(`[data-testid="sidebar-ref"][data-section="branches"][data-ref="refs/heads/${name}"]`)
const sidebarRef = (page: Page, name: string) => page.locator(`[data-testid="sidebar-ref"][data-ref="${name}"]`)
const header = (page: Page, section: string) => page.locator(`[data-testid="sidebar-section"][data-section="${section}"]`)
const workspace = (page: Page, item: string) => page.locator(`[data-testid="workspace-item"][data-item="${item}"]`)
const row = (page: Page, hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)
/**
 * Fold Workspace so every section fits without scrolling. A drag near the edge of a scrolled
 * list makes Chromium scroll it, which would move another row under the pointer mid-test.
 */
const foldWorkspace = async (page: Page) => {
  await header(page, 'workspace').getByRole('button').first().click()
  await expect(workspace(page, 'history')).toHaveCount(0)
}
const undo = (page: Page) => page.getByTestId('toast-action').filter({ hasText: 'Undo' }).last().click()

/** main: A - B; topic (from A): T; pick (from A): P1 - P2; an untracked note so the WIP row shows. */
function setup() {
  const r = initRepo()
  const A = r.commit('A', { 'a.txt': 'a\n', 'shared.txt': 'one\ntwo\n' })
  r.git('checkout', '-q', '-b', 'topic')
  const T = r.commit('T', { 't.txt': 't\n' })
  r.git('checkout', '-q', '-b', 'pick', A)
  const P1 = r.commit('P1', { 'p1.txt': 'p1\n' })
  const P2 = r.commit('P2', { 'shared.txt': 'one\nTWO\n' })
  r.checkout('main')
  const B = r.commit('B', { 'b.txt': 'b\n' })
  r.write('note.txt', 'n\n')
  return { r, A, B, T, P1, P2 }
}

test('branch onto HEAD: merge, Alt: rebase; onto another branch: check it out and merge; Undo after each', async () => {
  const { r, B } = setup()
  const { app, page } = await launch(r.dir)
  await drag(page, pill(page, 'refs/heads/topic'), pill(page, 'refs/heads/main'), { badge: 'Merge topic into main', other: 'Alt: Rebase main onto topic' })
  await expect.poll(() => r.git('log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2)
  await undo(page)
  await expect.poll(() => r.head()).toBe(B)

  // From the sidebar onto the Working Copy, with Alt: rebase.
  await drag(page, branch(page, 'topic'), workspace(page, 'working-copy'), { alt: true, badge: 'Rebase main onto topic', other: 'Without Alt: Merge topic into main' })
  await expect.poll(() => r.git('merge-base', 'main', 'topic').trim()).toBe(r.git('rev-parse', 'topic').trim())
  await undo(page)
  await expect.poll(() => r.head()).toBe(B)

  // Onto a branch that is not checked out: check it out, then merge into it.
  await drag(page, branch(page, 'pick'), branch(page, 'topic'), { badge: 'Merge pick into topic (checks out topic)' })
  await expect.poll(() => r.git('log', '-1', '--format=%P', 'topic').trim().split(' ')).toHaveLength(2)
  expect(r.git('branch', '--show-current').trim()).toBe('topic')
  await undo(page)
  await expect.poll(() => r.git('branch', '--show-current').trim()).toBe('main')
  await app.close()
})

test('branch onto section headers and folders: new branch, new tag, rename into a folder, pin, worktree', async () => {
  const { r, T } = setup()
  r.git('branch', 'feature/old', 'main')
  const { app, page } = await launch(r.dir)
  await foldWorkspace(page)

  await drag(page, branch(page, 'topic'), header(page, 'branches'), { badge: 'Create a branch from topic…' })
  await page.getByTestId('dialog-input').fill('topic-copy')
  await page.getByTestId('dialog-submit').click()
  await expect.poll(() => r.gitOrNull('rev-parse', 'topic-copy')?.trim()).toBe(T)
  // Wait for the sidebar to list it: the rows below move down a row.
  await expect(branch(page, 'topic-copy')).toBeVisible()

  await drag(page, branch(page, 'topic'), header(page, 'tags'), { badge: 'Create a tag at topic…' })
  await page.getByTestId('dialog-input').fill('t1')
  await page.getByTestId('dialog-submit').click()
  await expect.poll(() => r.gitOrNull('rev-parse', 't1^{commit}')?.trim()).toBe(T)
  await expect(header(page, 'tags')).toContainText('1')

  await drag(page, branch(page, 'pick'), page.locator('[data-testid="sidebar-folder"][data-path="feature"]'), { badge: 'Rename pick to feature/pick' })
  await expect(branch(page, 'feature/pick')).toBeVisible()
  await undo(page)
  await expect(branch(page, 'pick')).toBeVisible()

  await drag(page, branch(page, 'topic'), header(page, 'pinned'), { badge: 'Pin topic' })
  await expect(page.locator('[data-testid="sidebar-ref"][data-section="pinned"] [data-testid="ref-label"]')).toHaveText(['topic'])
  // Already pinned: the header is no target for it now (no badge).
  await branch(page, 'topic').hover()
  await page.mouse.down()
  await header(page, 'pinned').hover()
  await page.mouse.move(5, 5)
  await header(page, 'pinned').hover()
  await expect(page.getByTestId('drag-badge')).toBeHidden()
  await page.mouse.up()

  await drag(page, branch(page, 'topic'), header(page, 'worktrees'), { badge: 'Check out topic in a new worktree…' })
  await expect(page.getByRole('dialog')).toContainText('Check out topic in a new worktree')
  await page.keyboard.press('Escape')
  await app.close()
})

test('commits: onto the WIP row cherry-pick, Alt reverts; onto another branch they are picked there without a checkout', async () => {
  const { r, B, P1, P2 } = setup()
  const { app, page } = await launch(r.dir)
  await foldWorkspace(page)
  await drag(page, row(page, P1), page.getByTestId('wip-row'), { badge: `Cherry-pick ${P1.slice(0, 7)} onto main`, other: `Alt: Revert ${P1.slice(0, 7)}` })
  await expect.poll(() => existsSync(join(r.dir, 'p1.txt'))).toBe(true)
  await undo(page)
  await expect.poll(() => r.head()).toBe(B)
  await expect(page.locator('[data-testid="commit-row"]')).toHaveCount(5)

  // Alt: revert instead (B, the commit HEAD is on).
  await drag(page, row(page, B), page.getByTestId('wip-row'), { alt: true, badge: `Revert ${B.slice(0, 7)}` })
  await expect.poll(() => r.git('log', '-1', '--format=%s').trim()).toMatch(/^Revert "B"/)
  await undo(page)
  await expect.poll(() => r.head()).toBe(B)
  await expect(page.locator('[data-testid="commit-row"]')).toHaveCount(5)

  // Onto topic, which stays where it is checked out: nowhere. HEAD and the working tree do not move.
  await row(page, P2).click()
  await row(page, P1).click({ modifiers: ['Shift'] })
  await drag(page, row(page, P2), branch(page, 'topic'), { badge: 'Cherry-pick 2 commits onto topic (stays on main)' })
  await expect.poll(() => r.git('log', '--format=%s', '-3', 'topic').trim().split('\n')).toEqual(['P2', 'P1', 'T'])
  expect(r.head()).toBe(B)
  await undo(page)
  await expect.poll(() => r.git('log', '--format=%s', '-1', 'topic').trim()).toBe('T')

  // A commit onto the Branches header: a new branch there. (Two commits have no one place for it,
  // so select just the one first: dragging a selected row drags the whole selection.)
  await row(page, P1).click()
  await drag(page, row(page, P1), header(page, 'branches'), { badge: `Create a branch at ${P1.slice(0, 7)}…` })
  await page.getByTestId('dialog-input').fill('at-p1')
  await page.getByTestId('dialog-submit').click()
  await expect.poll(() => r.gitOrNull('rev-parse', 'at-p1')?.trim()).toBe(P1)
  await app.close()
})

test('commits onto a commit on the branch: squash, Alt: fixup keeps the target\'s message', async () => {
  const r = initRepo()
  r.commit('one', { '1.txt': '1\n' })
  const two = r.commit('two', { '2.txt': '2\n' })
  r.commit('three', { '3.txt': '3\n' })
  const four = r.commit('four', { '4.txt': '4\n' })
  const { app, page } = await launch(r.dir)
  await drag(page, row(page, four), row(page, two), { alt: true, badge: `Fixup ${four.slice(0, 7)} into ${two.slice(0, 7)} (keeps its message)` })
  await expect.poll(() => r.git('log', '--format=%s').trim().split('\n')).toEqual(['three', 'two', 'one'])
  await undo(page)
  await expect.poll(() => r.git('log', '--format=%s').trim().split('\n')).toEqual(['four', 'three', 'two', 'one'])
  await app.close()
})

test('stashes and files: a stash onto the working copy applies, Alt pops; a commit\'s file applies its change; changed files onto Stashes stash them', async () => {
  const { r, P2 } = setup()
  r.write('a.txt', 'stashed a\n')
  r.git('stash', 'push', '-q', '-m', 'my stash')
  const { app, page } = await launch(r.dir)
  const stash = page.getByTestId('stash-item')
  await drag(page, stash, workspace(page, 'working-copy'), { badge: 'Apply stash@{0}', other: 'Alt: Pop stash@{0}' })
  await expect.poll(() => readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('stashed a\n')
  expect(r.git('stash', 'list').trim()).not.toBe('')
  r.git('checkout', '--', 'a.txt')
  await drag(page, stash, page.getByTestId('wip-row'), { alt: true, badge: 'Pop stash@{0}' })
  await expect.poll(() => r.git('stash', 'list').trim()).toBe('')
  await undo(page)
  await expect.poll(() => r.git('stash', 'list').trim()).not.toBe('')
  r.git('checkout', '--', 'a.txt')

  // One file of a commit, from its file list, onto the WIP row.
  await row(page, P2).click()
  const file = page.locator('[data-testid="commit-file"][data-path="shared.txt"]')
  await drag(page, file, page.getByTestId('wip-row'), { badge: `Apply shared.txt's change from ${P2.slice(0, 7)} to the working copy` })
  await expect.poll(() => readFileSync(join(r.dir, 'shared.txt'), 'utf8')).toBe('one\nTWO\n')
  await undo(page)
  await expect.poll(() => readFileSync(join(r.dir, 'shared.txt'), 'utf8')).toBe('one\ntwo\n')

  // A changed file onto the Stashes item: only it is stashed.
  r.write('b.txt', 'edited b\n')
  await page.getByTestId('wip-row').click()
  await drag(page, page.locator('[data-testid="unstaged-file"][data-path="b.txt"]'), workspace(page, 'stashes'), { badge: 'Stash b.txt' })
  // git lists the new stash before it resets the file: wait for the file.
  await expect.poll(() => readFileSync(join(r.dir, 'b.txt'), 'utf8')).toBe('b\n')
  expect(r.git('stash', 'list').split('\n').filter(Boolean)).toHaveLength(2)
  expect(existsSync(join(r.dir, 'note.txt'))).toBe(true)
  await app.close()
})

test('remotes: a branch onto a remote pushes after asking, Alt force-pushes with lease; a tag pushes; remote branches track and pull', async () => {
  const r = makeFixture('with-remote')
  const bare = r.git('remote', 'get-url', 'origin').trim()
  const lsRemote = () => execFileSync('git', ['ls-remote', bare], { encoding: 'utf8' })
  r.git('branch', 'topic')
  r.git('tag', 'v9')
  // A branch on origin that is not here yet, one commit ahead of main.
  r.git('checkout', '-q', '-b', 'theirs', 'origin/main')
  r.commit('their work', { 'theirs.txt': 'x\n' })
  r.git('push', '-q', 'origin', 'theirs')
  r.checkout('main')
  r.git('branch', '-D', 'theirs')
  const { app, page } = await launch(r.dir)
  const origin = page.locator('[data-testid="remote-section"][data-name="origin"]')
  // Tags start folded; open them to drag one.
  await header(page, 'tags').getByRole('button').first().click()

  // Publish: asks first (it changes the remote), then pushes and tracks.
  await drag(page, branch(page, 'topic'), origin, { badge: 'Publish topic to origin (asks first)', other: 'Alt: Force push topic to origin (with lease)' })
  await page.getByRole('button', { name: 'Publish topic to origin' }).click()
  await expect.poll(lsRemote).toContain('refs/heads/topic')
  await expect.poll(() => r.gitOrNull('rev-parse', '--abbrev-ref', 'topic@{upstream}')?.trim()).toBe('origin/topic')
  // Cancelling the question changes nothing.
  await drag(page, sidebarRef(page, 'refs/tags/v9'), origin, { badge: 'Push tag v9 to origin (asks first)' })
  await page.getByRole('button', { name: 'Cancel' }).click()
  expect(lsRemote()).not.toContain('refs/tags/v9')
  await drag(page, sidebarRef(page, 'refs/tags/v9'), origin, { badge: 'Push tag v9 to origin (asks first)' })
  await page.getByRole('button', { name: 'Push tag v9 to origin' }).click()
  await expect.poll(lsRemote).toContain('refs/tags/v9')

  // Force push with lease (Alt): a rewritten topic replaces origin/topic.
  r.git('checkout', '-q', 'topic')
  r.git('commit', '-q', '--amend', '-m', 'local only, reworded')
  r.checkout('main')
  await origin.locator('button').first().click()
  await drag(page, branch(page, 'topic'), sidebarRef(page, 'refs/remotes/origin/topic'), { alt: true, badge: 'Force push topic to origin/topic (with lease) (asks first)' })
  await page.getByRole('button', { name: 'Force push topic to origin/topic' }).click()
  await expect.poll(() => lsRemote()).toContain(r.git('rev-parse', 'topic').trim())

  // A remote branch onto Branches with Alt: a local branch tracking it, not checked out.
  await drag(page, sidebarRef(page, 'refs/remotes/origin/theirs'), header(page, 'branches'), { alt: true, badge: 'Create theirs tracking origin/theirs', other: 'Without Alt: Check out origin/theirs as theirs' })
  await expect.poll(() => r.gitOrNull('rev-parse', '--abbrev-ref', 'theirs@{upstream}')?.trim()).toBe('origin/theirs')
  expect(r.git('branch', '--show-current').trim()).toBe('main')

  // A remote branch onto the Working Copy: pull it into HEAD.
  await drag(page, sidebarRef(page, 'refs/remotes/origin/theirs'), workspace(page, 'working-copy'), { badge: 'Pull origin/theirs into main', other: 'Alt: Pull origin/theirs into main with rebase' })
  await expect.poll(() => existsSync(join(r.dir, 'theirs.txt'))).toBe(true)

  // A remote branch onto another local branch: track it.
  await drag(page, sidebarRef(page, 'refs/remotes/origin/main'), branch(page, 'topic'), { badge: 'Make topic track origin/main' })
  await expect.poll(() => r.gitOrNull('rev-parse', '--abbrev-ref', 'topic@{upstream}')?.trim()).toBe('origin/main')
  await app.close()
})

test('what is not in the matrix is not a target: no badge, nothing happens', async () => {
  const { r, A, B } = setup()
  const { app, page } = await launch(r.dir)
  for (const [from, to] of [
    [branch(page, 'topic'), workspace(page, 'stashes')],
    [branch(page, 'topic'), workspace(page, 'history')],
    // A branch onto a commit that is not HEAD's: there is no meaning for it.
    [pill(page, 'refs/heads/topic'), row(page, A).getByTestId('row-sha')],
  ] as const) {
    await from.hover()
    await page.mouse.down()
    await to.hover()
    await page.mouse.move(3, 3)
    await to.hover()
    await expect(page.getByTestId('drag-badge')).toBeHidden()
    await page.mouse.up()
  }
  expect(r.head()).toBe(B)
  await app.close()
})
