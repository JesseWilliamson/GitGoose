import { CONFLICT_BRANCH, FixtureRepo, initRepo, makeDevRepo } from '@gitsquid/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { launch } from './app'

/**
 * A file where each kind of three-way block appears once:
 *   line 2 changed only by us, line 6 only by them, line 10 the same by both,
 *   line 14 differently by both (the one real conflict).
 */
function mergeRepo() {
  const r = initRepo()
  const lines = Array.from({ length: 16 }, (_, i) => `line ${i + 1}`)
  const file = (edits: Record<number, string>) => lines.map((l, i) => edits[i + 1] ?? l).join('\n') + '\n'
  r.commit('base', { 'f.txt': file({}) })
  r.git('checkout', '-q', '-b', 'other')
  r.commit('theirs', { 'f.txt': file({ 6: 'theirs 6', 10: 'same 10', 14: 'theirs 14' }) })
  r.checkout('main')
  r.commit('ours', { 'f.txt': file({ 2: 'ours 2', 10: 'same 10', 14: 'ours 14' }) })
  r.tryGit('merge', 'other')
  return { r, file }
}

const result = (page: Page) => page.getByTestId('merge-result').locator('.cm-content')

test('three panes: non-conflicting changes start applied; taking both sides of a conflict', async () => {
  const { r, file } = mergeRepo()
  const { app, page } = await launch(r.dir)
  await expect(page.getByTestId('merge-panes')).toBeVisible()
  await expect(page.getByTestId('conflicts-left')).toHaveText('1 of 1 conflict left')
  await expect(page.getByTestId('merge-save')).toBeDisabled()
  // The middle already has both one-sided changes and the shared one; the conflict shows the base.
  await expect(result(page)).toContainText('ours 2')
  await expect(result(page)).toContainText('theirs 6')
  await expect(result(page)).toContainText('line 14')
  // Only the conflict still has buttons.
  await expect(page.getByTestId('apply-ours')).toHaveCount(1)
  await page.getByTestId('apply-ours').click()
  await expect(page.getByTestId('conflicts-left')).toHaveText('All conflicts resolved')
  // Taking the other side too keeps both, ours first.
  await page.getByTestId('apply-theirs').click()
  await page.getByTestId('merge-save').click()
  await expect(page.getByTestId('conflict-file')).toHaveCount(0)
  expect(r.git('show', ':f.txt')).toBe(file({ 2: 'ours 2', 6: 'theirs 6', 10: 'same 10', 14: 'ours 14\ntheirs 14' }))
  await app.close()
})

test('three panes: start from the ancestor, apply all, undo an apply, ignore both sides', async () => {
  const { r, file } = mergeRepo()
  const { app, page } = await launch(r.dir)
  await page.getByTestId('merge-start').selectOption('base')
  await expect(result(page)).not.toContainText('ours 2')
  await expect(page.getByTestId('apply-non-conflicting')).toHaveText('Apply non-conflicting (3)')
  await page.getByTestId('apply-non-conflicting').click()
  await expect(result(page)).toContainText('ours 2')
  await expect(result(page)).toContainText('theirs 6')
  await page.getByTestId('apply-theirs').click()
  await expect(page.getByTestId('conflicts-left')).toHaveText('All conflicts resolved')
  // Undo is the editor's: it reverts the text and the "applied" status together.
  await result(page).click()
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('conflicts-left')).toHaveText('1 of 1 conflict left')
  await expect(result(page)).not.toContainText('theirs 14')
  await expect(page.getByTestId('apply-theirs')).toHaveCount(1)
  await page.getByTestId('ignore-ours').click()
  await page.getByTestId('ignore-theirs').click()
  await expect(page.getByTestId('conflicts-left')).toHaveText('All conflicts resolved')
  await page.getByTestId('merge-save').click()
  await expect(page.getByTestId('conflict-file')).toHaveCount(0)
  expect(r.git('show', ':f.txt')).toBe(file({ 2: 'ours 2', 6: 'theirs 6', 10: 'same 10' }))
  await app.close()
})

test('three panes: markers start blocks saving until removed; typing in a conflict resolves it', async () => {
  const { r, file } = mergeRepo()
  const { app, page } = await launch(r.dir)
  await page.getByTestId('merge-start').selectOption('markers')
  await expect(result(page)).toContainText('<<<<<<<')
  await result(page).locator('.cm-line', { hasText: 'theirs 14' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' (edited)')
  // Edited by hand counts as resolved, but the markers are still in the text.
  await expect(page.getByTestId('conflicts-left')).toHaveText('Remove the conflict markers')
  await expect(page.getByTestId('merge-save')).toBeDisabled()
  for (const marker of ['<<<<<<<', '=======', '>>>>>>>', 'ours 14']) {
    await result(page).locator('.cm-line', { hasText: marker }).click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Delete')
  }
  await expect(page.getByTestId('conflicts-left')).toHaveText('All conflicts resolved')
  await page.getByTestId('merge-save').click()
  await expect(page.getByTestId('conflict-file')).toHaveCount(0)
  expect(r.git('show', ':f.txt')).toBe(file({ 2: 'ours 2', 6: 'theirs 6', 10: 'same 10', 14: 'theirs 14 (edited)' }))
  await app.close()
})

test('three panes on the dev repository: a renamed file, accept left, edit by hand, continue', async () => {
  test.setTimeout(120_000)
  const { dir } = makeDevRepo({ commits: 300 })
  const r = new FixtureRepo(dir)
  // The dev repo has a dirty working tree on purpose; git will not merge over a staged change.
  r.git('reset', '-q', '--hard')
  r.git('clean', '-fdq')
  r.tryGit('merge', CONFLICT_BRANCH)
  const { app, page } = await launch(dir)
  await expect(page.getByTestId('conflict-file')).toHaveCount(2)

  await page.getByTestId('conflict-file').filter({ hasText: 'src/config.ts' }).click()
  await expect(page.getByTestId('merge-panes')).toBeVisible()
  await expect(page.getByTestId('merge-ours')).toContainText('retries: 2')
  await expect(page.getByTestId('merge-theirs')).toContainText('retries: 5')
  await page.getByTestId('apply-ours').click()
  await page.getByTestId('merge-save').click()
  await expect(page.getByTestId('conflict-file')).toHaveCount(1)

  // The renamed file: base and ours come from format.ts, theirs from formatting.ts.
  await expect(page.getByTestId('conflict-file')).toContainText('src/utils/formatting.ts')
  await expect(page.getByTestId('merge-theirs')).toContainText('toLowerCase')
  await result(page).locator('.cm-line', { hasText: 'const trimmed' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type('.replace(/\\s+/g, " ").toLowerCase()')
  await expect(page.getByTestId('conflicts-left')).toHaveText('All conflicts resolved')
  await page.getByTestId('merge-save').click()
  await expect(page.getByTestId('conflict-file')).toHaveCount(0)
  await page.getByTestId('continue-op').click()
  await expect(page.getByTestId('conflicts')).toHaveCount(0)
  expect(r.git('rev-list', '--parents', '-n1', 'HEAD').trim().split(' ')).toHaveLength(3)
  expect(r.git('show', 'HEAD:src/config.ts')).toContain('retries: 2,\n  timeoutMs: 3000,')
  expect(r.git('show', 'HEAD:src/utils/formatting.ts')).toContain('const trimmed = value.trim().replace(/\\s+/g, " ").toLowerCase()\n')
  expect(r.tryGit('cat-file', '-e', 'HEAD:src/utils/format.ts')).not.toBe(0)
  await app.close()
})
