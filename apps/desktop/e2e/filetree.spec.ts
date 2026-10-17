import { initRepo } from '@gitsquid/fixtures'
import { expect, test } from '@playwright/test'
import { launch } from './app'

test('changed files as a tree: stage a whole folder; filter the list', async () => {
  const r = initRepo()
  r.commit('root', { 'README.md': 'r\n' })
  r.write('src/app/main.ts', 'm\n').write('src/app/util.ts', 'u\n').write('docs/guide.md', 'g\n').write('README.md', 'changed\n')
  const { app, page } = await launch(r.dir)
  await expect(page.getByTestId('unstaged-file')).toHaveCount(4)
  await expect(page.getByTestId('commit-count')).toHaveText('1 commit')

  await page.getByTestId('file-tree-toggle').click()
  const folder = page.locator('[data-testid="unstaged-folder"][data-path="src/app"]')
  await expect(folder).toContainText('2')
  // Collapsing hides the files under it.
  await folder.click()
  await expect(page.getByTestId('unstaged-file')).toHaveCount(2)
  await folder.click()
  await folder.hover()
  await folder.getByTitle('Stage folder').click()
  await expect(page.getByTestId('staged-file')).toHaveCount(2)
  expect(r.git('diff', '--cached', '--name-only').trim().split('\n')).toEqual(['src/app/main.ts', 'src/app/util.ts'])

  await page.getByTestId('file-filter').fill('guide')
  await expect(page.getByTestId('unstaged-file')).toHaveCount(1)
  await expect(page.getByTestId('staged-file')).toHaveCount(0)
  await page.getByTestId('file-filter').press('Escape')
  await expect(page.getByTestId('unstaged-file')).toHaveCount(2)

  // The choice is remembered (a setting), and applies to commit file lists too.
  await page.getByTestId('file-tree-toggle').click()
  await expect(page.getByTestId('unstaged-folder')).toHaveCount(0)
  await app.close()
})
