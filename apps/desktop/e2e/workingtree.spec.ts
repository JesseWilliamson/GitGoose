import { makeFixture, tempDir } from '@gitsquid/fixtures'
import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { launch } from './app'

test('stages a file, commits, and undoes the commit', async () => {
  const r = makeFixture('linear')
  r.write('notes.md', '# notes\n')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('wip-row').click()
  await expect(page.getByTestId('unstaged-file')).toHaveCount(1)
  await page.getByTestId('stage-all').click()
  await expect(page.getByTestId('staged-file')).toHaveCount(1)
  await page.getByTestId('commit-summary').fill('Add notes')
  await page.getByTestId('commit-button').click()
  await expect(page.getByTestId('commit-row').first()).toContainText('Add notes')
  await expect(page.getByTestId('wip-row')).toHaveCount(0)
  expect(r.git('log', '-1', '--format=%s').trim()).toBe('Add notes')

  // Undo from the toast.
  await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).first().click()
  await expect(page.getByTestId('wip-row')).toBeVisible()
  expect(r.git('log', '-1', '--format=%s').trim()).toBe('Commit 5')
  expect(r.git('diff', '--cached', '--name-only').trim()).toBe('notes.md')
  await app.close()
})

test('stages selected lines from the diff view', async () => {
  const r = makeFixture('linear')
  r.write('file.txt', 'line 5\nline 5\nKEEP ME\nline 5\nline 5\nline 5\nNOT YET\n')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('wip-row').click()
  await page.getByTestId('unstaged-file').first().click()
  await expect(page.getByTestId('file-view')).toBeVisible()
  await page.getByTestId('diff-line').filter({ hasText: 'KEEP ME' }).click()
  await page.getByTestId('stage-lines').click()
  await expect(page.getByTestId('staged-file')).toHaveCount(1)
  const staged = r.git('show', ':file.txt')
  expect(staged).toContain('KEEP ME')
  expect(staged).not.toContain('NOT YET')
  await app.close()
})

test('discards a file and brings it back with Ctrl+Z', async () => {
  const r = makeFixture('linear')
  r.write('file.txt', 'precious edit\n')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('wip-row').click()
  const row = page.getByTestId('unstaged-file').first()
  await row.hover()
  await row.getByTitle('Discard changes (undoable)').click()
  await expect(page.getByTestId('wip-row')).toHaveCount(0)
  await page.getByTestId('graph-scroll').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.getByTestId('wip-row')).toBeVisible()
  expect(r.git('diff').includes('precious edit')).toBe(true)
  await app.close()
})

test('creates a branch from the toolbar and checks branches out from the sidebar', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('toolbar').getByRole('button', { name: 'Branch' }).click()
  await page.getByTestId('dialog-input').fill('topic')
  await page.getByTestId('dialog-submit').click()
  await expect(page.getByTestId('status-bar')).toContainText('topic')
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/feature"]').dblclick()
  await expect(page.getByTestId('status-bar')).toContainText('feature')
  expect(r.git('branch', '--show-current').trim()).toBe('feature')
  await app.close()
})

test('pushes, then pulls a commit someone else pushed', async () => {
  const r = makeFixture('with-remote')
  const { app, page } = await launch(r.dir)
  const toolbar = page.getByTestId('toolbar')
  await toolbar.getByRole('button', { name: 'Push' }).first().click()
  await expect(page.locator('[role=status]').filter({ hasText: 'Pushed' })).toBeVisible()
  expect(r.git('rev-parse', 'origin/main').trim()).toBe(r.head())

  // A second clone pushes a commit; Pull brings it in.
  const other = tempDir('gitsquid-other-')
  execFileSync('git', ['clone', '-q', r.git('remote', 'get-url', 'origin').trim(), other])
  execFileSync('git', ['-c', 'user.name=B', '-c', 'user.email=b@x', 'commit', '-q', '--allow-empty', '-m', 'From another machine'], { cwd: other })
  execFileSync('git', ['push', '-q'], { cwd: other })
  await toolbar.getByRole('button', { name: 'Pull' }).first().click()
  await expect(page.getByTestId('commit-row').first()).toContainText('From another machine')
  await app.close()
})

test('notices changes made outside the app', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await expect(page.getByTestId('commit-row')).toHaveCount(5)
  r.write('file.txt', 'edited in another editor\n')
  await expect(page.getByTestId('wip-row')).toBeVisible()
  r.commit('Committed in a terminal')
  await expect(page.getByTestId('commit-row').first()).toContainText('Committed in a terminal')
  await expect(page.getByTestId('wip-row')).toHaveCount(0)
  await app.close()
})

test('ignores an untracked file from its context menu, undoably', async () => {
  const r = makeFixture('linear')
  r.write('debug.log', 'noise\n')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('wip-row').click()
  await page.getByTestId('unstaged-file').filter({ hasText: 'debug.log' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add to .gitignore' }).click()
  await expect(page.getByTestId('unstaged-file')).toHaveText([/\.gitignore/])
  await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).first().click()
  await expect(page.getByTestId('unstaged-file')).toHaveText([/debug\.log/])
  await app.close()
})
