import { initRepo, makeFixture, tempDir } from '@gitsquid/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

const set = (page: Page, patch: Record<string, unknown>) => page.evaluate((p) => window.gitsquid.setSettings(p as never), patch)

test('opens the settings page, searches it, and closes with Esc', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-row').first().click()
  await page.keyboard.press('Control+,')
  await expect(page.getByTestId('settings-page')).toBeVisible()
  await page.getByTestId('settings-search').fill('whitespace')
  await expect(page.getByTestId('setting-ignoreWhitespace')).toBeVisible()
  await expect(page.getByTestId('setting-uiScale')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-page')).toHaveCount(0)
  await expect(page.getByTestId('commit-row').first()).toBeVisible()
  await app.close()
})

test('UI scale zooms the whole window, from the keyboard, and persists', async () => {
  const profile = tempDir('gitsquid-profile-')
  const r = makeFixture('linear')
  const first = await launch(r.dir, { GITSQUID_USER_DATA: profile })
  await first.page.getByTestId('commit-row').first().click()
  await first.page.keyboard.press('Control+=')
  await first.page.keyboard.press('Control+=')
  await first.page.keyboard.press('Control+=')
  const zoom = () => first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())
  await expect.poll(zoom).toBeCloseTo(1.3, 2)
  await first.app.close()

  const second = await launch(r.dir, { GITSQUID_USER_DATA: profile })
  await expect(second.page.getByTestId('commit-row').first()).toBeVisible()
  await expect.poll(() => second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())).toBeCloseTo(1.3, 2)
  await second.page.keyboard.press('Control+0')
  await expect.poll(() => second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())).toBe(1)
  await second.app.close()
})

test('migrates the old font size setting to UI scale', async () => {
  const profile = tempDir('gitsquid-profile-')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ gitPath: 'git', theme: 'dark', fontSize: 16, recentRepos: [], openRepos: [] }))
  const { app, page } = await launch(undefined, { GITSQUID_USER_DATA: profile })
  await expect(page.getByTestId('welcome')).toBeVisible()
  const s = await page.evaluate(() => window.gitsquid.getSettings())
  expect(s.uiScale).toBe(1.25)
  expect(s.theme).toBe('dark')
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())).toBe(1.25)
  await app.close()
})

test('code font size sets diff line height; context lines and whitespace reach git', async () => {
  const r = initRepo()
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
  r.commit('base', { 'f.txt': lines.join('\n') + '\n' })
  const edited = [...lines]
  edited[9] = 'CHANGED'
  edited[2] = 'line 3   ' // whitespace-only change
  r.write('f.txt', edited.join('\n') + '\n')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('wip-row').click()
  await page.getByTestId('unstaged-file').first().click()
  await expect(page.getByTestId('diff-line').first()).toBeVisible()
  expect((await page.getByTestId('diff-line').first().boundingBox())!.height).toBe(Math.round(12 * 1.6))

  await set(page, { codeFontSize: 16, contextLines: 1 })
  // One context line on each side of the two changes: two hunks of 1 + 2 + 1 lines.
  await expect(page.getByTestId('diff-line').filter({ hasText: 'CHANGED' })).toBeVisible()
  await expect(page.getByTestId('diff-line')).toHaveCount(8)
  expect((await page.getByTestId('diff-line').first().boundingBox())!.height).toBe(Math.round(16 * 1.6))

  await set(page, { ignoreWhitespace: true })
  await expect(page.getByTestId('diff-line')).toHaveCount(4)
  await expect(page.getByTestId('diff-hint')).toContainText('staging are off')
  await expect(page.getByTestId('stage-hunk')).toHaveCount(0)
  await app.close()
})

test('Pull uses the mode from settings', async () => {
  const r = makeFixture('with-remote')
  const other = tempDir('gitsquid-other-')
  execFileSync('git', ['clone', '-q', r.git('remote', 'get-url', 'origin').trim(), other])
  execFileSync('git', ['-c', 'user.name=B', '-c', 'user.email=b@x', 'commit', '-q', '--allow-empty', '-m', 'Theirs'], { cwd: other })
  execFileSync('git', ['push', '-q'], { cwd: other })
  const { app, page } = await launch(r.dir)
  await set(page, { pullMode: 'rebase' })
  await page.getByTestId('toolbar').getByRole('button', { name: 'Pull' }).first().click()
  await expect(page.locator('[role=status]').filter({ hasText: 'Pulled' })).toBeVisible()
  // Rebased, not merged: the local commit now sits on top of theirs, and there is no merge commit.
  expect(r.git('log', '-2', '--format=%s').trim().split('\n')).toEqual(['local only', 'Theirs'])
  await app.close()
})

test('rebinds a shortcut and shows the conflict when two commands share keys', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('toolbar').getByRole('button', { name: 'Settings' }).click()
  await page.getByTestId('keybinding-palette').click()
  await page.keyboard.press('Control+Shift+Y')
  await expect(page.getByTestId('keybinding-palette')).toHaveText('Ctrl+Shift+Y')
  await page.getByTestId('keybinding-fetch').click()
  await page.keyboard.press('Control+Shift+Y')
  await expect(page.getByTestId('setting-keybindings')).toContainText('conflict')
  await page.getByTestId('keybinding-fetch').click()
  await page.keyboard.press('Backspace') // back to the default
  await expect(page.getByTestId('setting-keybindings')).not.toContainText('conflict')
  await page.getByTestId('settings-close').click()
  await page.getByTestId('commit-row').first().click()
  await page.keyboard.press('Control+Shift+Y')
  await expect(page.getByTestId('palette-input')).toBeVisible()
  await app.close()
})

test('discard asks first when the confirmation setting is on', async () => {
  const r = makeFixture('linear')
  r.write('file.txt', 'edited\n')
  const { app, page } = await launch(r.dir)
  await set(page, { confirmDiscard: true })
  await page.getByTestId('wip-row').click()
  const row = page.getByTestId('unstaged-file').first()
  await row.hover()
  await row.getByTitle('Discard changes (undoable)').click()
  await expect(page.getByRole('dialog')).toContainText('Discard changes?')
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByTestId('wip-row')).toHaveCount(0)
  await app.close()
})

test('compact rows and hiding tags change the graph', async () => {
  const r = makeFixture('tags')
  const { app, page } = await launch(r.dir)
  await expect(page.locator('[data-testid="ref-pill"][data-ref="refs/tags/v0.2"]')).toBeVisible()
  expect((await page.getByTestId('commit-row').first().boundingBox())!.height).toBe(32)
  await set(page, { compactRows: true, showTags: false })
  await expect(page.locator('[data-testid="ref-pill"][data-ref="refs/tags/v0.2"]')).toHaveCount(0)
  await expect.poll(async () => (await page.getByTestId('commit-row').first().boundingBox())!.height).toBe(24)
  await app.close()
})

test('opens files in the configured editor at a line, and a terminal in the repository', async () => {
  test.skip(process.platform === 'win32', 'uses a shell script as the fake editor')
  const r = makeFixture('linear')
  r.write('file.txt', 'one\ntwo\nthree\n')
  const dir = tempDir('gitsquid-tools-')
  const log = join(dir, 'log.txt')
  const script = join(dir, 'fake-tool.sh')
  writeFileSync(script, `#!/bin/sh\necho "$PWD|$*" >> "${log}"\n`, { mode: 0o755 })
  const { app, page } = await launch(r.dir)
  await set(page, { editorCommand: `"${script}" --goto {file}:{line}`, terminalCommand: `"${script}" term` })
  await page.getByTestId('wip-row').click()
  await page.getByTestId('unstaged-file').first().click()
  await page.getByTestId('diff-line').filter({ hasText: 'three' }).dblclick()
  const { readFileSync, existsSync } = await import('node:fs')
  await expect.poll(() => existsSync(log) && readFileSync(log, 'utf8')).toContain(`--goto ${r.dir}/file.txt:3`)
  await page.keyboard.press('Escape') // back to the graph
  await page.getByTestId('commit-row').first().click()
  await page.keyboard.press('Control+Shift+T')
  await expect.poll(() => readFileSync(log, 'utf8')).toContain(`${r.dir}|term`)
  await app.close()
})
