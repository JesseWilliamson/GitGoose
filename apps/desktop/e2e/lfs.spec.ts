import { initRepo } from '@gitsquid/fixtures'
import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

test.skip(spawnSync('git', ['lfs', 'version']).status !== 0, 'needs git-lfs')

test('track a file type with LFS from its menu; set LFS up; stop tracking from the sidebar', async () => {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'a\n' })
  r.write('art.psd', 'pretend this is big\n')
  // No global or system config: whether LFS is "set up" must come from this repository alone.
  const { app, page } = await launch(r.dir, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
  await page.getByTestId('unstaged-file').filter({ hasText: 'art.psd' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Track *.psd with Git LFS' }).click()
  await expect.poll(() => existsSync(join(r.dir, '.gitattributes')) && readFileSync(join(r.dir, '.gitattributes'), 'utf8')).toContain('*.psd filter=lfs')
  const section = page.getByTestId('sidebar').getByRole('button', { name: /^Git LFS/ })
  await section.click()
  await expect(page.getByTestId('lfs-pattern')).toHaveText('*.psd')
  await page.getByTestId('lfs-setup').getByRole('button', { name: 'Set up' }).click()
  await expect(page.getByTestId('lfs-setup')).toHaveCount(0)

  await page.getByTestId('lfs-pattern').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Stop tracking with LFS' }).click()
  await expect(page.getByTestId('lfs-pattern')).toHaveCount(0)
  await app.close()
})
