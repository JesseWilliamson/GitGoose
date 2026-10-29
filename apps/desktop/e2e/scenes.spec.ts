import { initRepo, makeFixture, tempDir } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

/** A history to read: a commit that adds a whole file, then one that changes another a little. */
function repo() {
  const r = initRepo()
  const code = (n: number) => Array.from({ length: n }, (_, i) => `const value${i} = ${i}`).join('\n') + '\n'
  r.commit('Base', { 'src/keep.ts': code(30) })
  r.commit('Add a module', { 'src/added.ts': code(40) })
  const lines = code(30).split('\n')
  lines[5] = 'const value5 = 500'
  r.commit('Change a value', { 'src/keep.ts': lines.join('\n'), 'src/other.ts': 'export {}\n' })
  return r
}

test('Space reads the selected commit in the Read scene; Esc and the digits move between scenes', async () => {
  const r = repo()
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').filter({ hasText: 'Add a module' }).click()
  await page.keyboard.press('Space')
  await expect(page.getByTestId('scene-read')).toBeVisible()
  // A whole added file that fits flows in two columns, the header saying why.
  await expect(page.getByTestId('stream-file').first()).toHaveAttribute('data-path', 'src/added.ts')
  await expect(page.getByTestId('layout-chip').first()).toHaveAttribute('data-layout', 'flow')
  await expect(page.getByTestId('flow-row').first()).toBeVisible()
  // The narrow graph is beside it, with the commit selected.
  await expect(page.getByTestId('left-column').getByTestId('commit-row').filter({ hasText: 'Add a module' })).toHaveAttribute('data-selected', 'true')
  // Esc goes back to Browse; 2 comes back to Read; 1 to Browse.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('scene-read')).toHaveCount(0)
  await page.keyboard.press('2')
  await expect(page.getByTestId('scene-read')).toBeVisible()
  await page.keyboard.press('1')
  await expect(page.getByTestId('scene-read')).toHaveCount(0)
  await app.close()
})

test('a modified file reads side by side; v marks it viewed; \\ folds the left column', async () => {
  const r = repo()
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').filter({ hasText: 'Change a value' }).click()
  await page.getByTestId('scene-tab-read').click()
  await expect(page.getByTestId('stream-file')).toHaveCount(2)
  await expect(page.getByTestId('stream-file').first()).toHaveAttribute('data-path', 'src/keep.ts')
  await expect(page.getByTestId('layout-chip').first()).toHaveAttribute('data-layout', 'split')
  await expect(page.locator('[data-testid="diff-cell"][data-kind="+"]')).toContainText('const value5 = 500')
  await page.keyboard.press('v')
  await expect(page.getByTestId('files-now')).toContainText('1 of 2 viewed')
  await page.keyboard.press('\\')
  await expect(page.getByTestId('left-rail')).toBeVisible()
  await page.keyboard.press('\\')
  await expect(page.getByTestId('left-column')).toBeVisible()
  await app.close()
})

test('Shift+R takes selected lines of a commit back out of the working copy, undoably', async () => {
  const r = repo()
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').filter({ hasText: 'Change a value' }).click()
  await page.getByTestId('scene-tab-read').click()
  await page.locator('[data-testid="diff-cell"][data-kind="+"]').filter({ hasText: 'const value5 = 500' }).click()
  await page.locator('[data-testid="diff-cell"][data-kind="-"]').filter({ hasText: 'const value5 = 5' }).click()
  await page.keyboard.press('Shift+R')
  await expect.poll(() => readFileSync(join(r.dir, 'src/keep.ts'), 'utf8').split('\n')[5]).toBe('const value5 = 5')
  await expect(page.getByTestId('scene-changes')).toHaveCount(0)
  await app.close()
})

test('Changes reads every changed file in one stream, and stages lines from it', async () => {
  const r = repo()
  r.write('src/keep.ts', readFileSync(join(r.dir, 'src/keep.ts'), 'utf8').replace('const value1 = 1', 'const value1 = 100'))
  r.write('notes.md', '# notes\n')
  const { app, page } = await launch(r.dir)
  await page.keyboard.press('3')
  await expect(page.getByTestId('scene-changes')).toBeVisible()
  await expect(page.getByTestId('stream-file')).toHaveCount(2)
  await page.locator('[data-testid="diff-line"][data-kind="+"]').filter({ hasText: 'const value1 = 100' }).click()
  await page.locator('[data-testid="diff-line"][data-kind="-"]').filter({ hasText: 'const value1 = 1' }).click()
  await page.getByTestId('stream-selection').getByTestId('stage-lines').click()
  await expect.poll(() => r.git('diff', '--cached', '--name-only').trim()).toBe('src/keep.ts')
  await expect(page.getByTestId('stream-block')).toHaveCount(2)
  await app.close()
})

test('a fetch that brings commits marks them and offers to read them, oldest first', async () => {
  const r = makeFixture('with-remote')
  const other = initRepo(tempDir('gitgoose-other-'))
  rmSync(other.dir, { recursive: true, force: true })
  execFileSync('git', ['clone', '-q', r.git('remote', 'get-url', 'origin').trim(), other.dir])
  other.commit('first from elsewhere', { 'x.txt': 'x\n' })
  other.commit('second from elsewhere', { 'y.txt': 'y\n' })
  other.git('push', '-q', 'origin', 'HEAD')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('toolbar').getByRole('button', { name: 'Fetch' }).click()
  await expect(page.getByTestId('fresh-bar')).toContainText('2 new commits since the fetch')
  await expect(page.getByTestId('row-fresh')).toHaveCount(2)
  await page.getByTestId('fresh-read').click()
  await expect(page.getByTestId('scene-read')).toBeVisible()
  await expect(page.getByTestId('stream-block').first()).toContainText('first from elsewhere')
  await app.close()
})

test('R reviews the current branch: its commits that the trunk lacks, oldest first', async () => {
  const r = initRepo()
  r.commit('base', { 'a.txt': 'a\n' })
  r.git('checkout', '-q', '-b', 'topic')
  r.commit('topic one', { 'b.txt': 'b\n' })
  r.commit('topic two', { 'c.txt': 'c\n' })
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').first().click()
  await page.keyboard.press('r')
  await expect(page.getByTestId('review-range')).toContainText('2 commits, oldest first')
  await expect(page.getByTestId('stream-block').first()).toContainText('topic one')
  await expect(page.getByTestId('stream-block')).toHaveCount(2)
  await app.close()
})

test('B opens the branch table beside the graph: pick the merged branches, delete them, Undo brings them back', async () => {
  const r = initRepo()
  r.commit('base', { 'a.txt': 'a\n' })
  r.git('branch', 'done-1')
  r.git('branch', 'done-2')
  r.git('checkout', '-q', '-b', 'wip')
  r.commit('unfinished', { 'b.txt': 'b\n' })
  r.git('checkout', '-q', 'main')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').first().click()
  await page.keyboard.press('b')
  const table = page.getByTestId('branch-table')
  await expect(table).toBeVisible()
  await expect(page.getByTestId('graph-scroll')).toBeVisible()
  await expect(table.getByTestId('branch-row')).toHaveCount(4)
  await table.getByTestId('branch-filter-merged').click()
  await expect(table.getByTestId('branch-row')).toHaveCount(2)
  for (const name of ['done-1', 'done-2']) await table.getByRole('checkbox', { name: `Pick ${name}` }).check()
  await expect(table.getByTestId('branch-bulk')).toContainText('all merged, nothing is lost')
  await table.getByTestId('branch-delete').click()
  await expect.poll(() => r.git('branch', '--format=%(refname:short)').trim().split('\n').sort()).toEqual(['main', 'wip'])
  await page.getByTestId('toolbar').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => r.git('branch', '--format=%(refname:short)').trim().split('\n').length).toBe(4)
  await page.keyboard.press('b')
  await expect(table).toHaveCount(0)
  await app.close()
})

test('Y blames the file being read; a commit picked in the blame is read next, at that file', async () => {
  const r = repo()
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').filter({ hasText: 'Change a value' }).click()
  await page.keyboard.press('Space')
  await expect(page.getByTestId('stream-file').first()).toHaveAttribute('data-path', 'src/keep.ts')
  await page.keyboard.press('y')
  await expect(page.getByTestId('lens-blame')).toBeVisible()
  await expect(page.getByTestId('blame')).toContainText('const value5 = 500')
  // The first line was written by Base: pick it, and Read shows Base.
  await page.getByTestId('blame').getByText('Base').first().click()
  await expect(page.getByTestId('lens-blame')).toHaveCount(0)
  await expect(page.getByTestId('stream-block').first()).toContainText('Base')
  await page.keyboard.press('h')
  await expect(page.getByTestId('lens-history')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('lens-history')).toHaveCount(0)
  await expect(page.getByTestId('scene-read')).toBeVisible()
  await app.close()
})
