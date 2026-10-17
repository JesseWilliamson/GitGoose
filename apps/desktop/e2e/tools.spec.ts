import { initRepo, tempDir } from '@gitsquid/fixtures'
import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

test('open a diff in the external diff tool; resolve a conflict in the merge tool', async () => {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'one\n', 'f.txt': '1\n' })
  r.git('checkout', '-q', '-b', 'theirs')
  r.commit('theirs', { 'f.txt': 'theirs\n' })
  r.checkout('main')
  r.commit('ours', { 'f.txt': 'ours\n' })
  r.write('a.txt', 'two\n')
  const out = join(tempDir('gitsquid-tool-'), 'seen.txt')
  r.git('config', 'difftool.record.cmd', `cat "$LOCAL" "$REMOTE" > '${out}'`)
  r.git('config', 'mergetool.taketheirs.cmd', 'cp "$REMOTE" "$MERGED"')
  r.git('config', 'mergetool.taketheirs.trustExitCode', 'true')
  r.git('config', 'mergetool.keepBackup', 'false')
  const { app, page } = await launch(r.dir)
  await page.evaluate(() => window.gitsquid.setSettings({ diffTool: 'record', mergeTool: 'taketheirs' }))

  await page.getByTestId('unstaged-file').filter({ hasText: 'a.txt' }).click()
  await page.getByTestId('open-diff-tool').click()
  await expect.poll(() => existsSync(out) && readFileSync(out, 'utf8')).toBe('one\ntwo\n')

  r.git('stash', '-q')
  expect(r.tryGit('merge', 'theirs')).not.toBe(0)
  await expect(page.getByTestId('conflicts')).toBeVisible()
  await page.getByTestId('open-merge-tool').click()
  await expect.poll(() => r.git('status', '--porcelain').trim()).toBe('M  f.txt')
  await expect(page.getByTestId('continue-op')).toBeEnabled()
  await app.close()
})
