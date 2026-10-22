import { fakeGitHub, initRepo, makeFixture, tempDir } from '@gitgoose/fixtures'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { launch } from './app'

/** Replace shell.openExternal in the main process, so a test sees which URLs the app opens. */
async function captureOpened(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] }
    g.opened = []
    shell.openExternal = async (url: string) => {
      g.opened.push(url)
    }
  })
  return () => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)
}

test('pull requests without signing in: listed on request, checked out from a fork, created on GitHub\'s page', async () => {
  // "GitHub": a bare repository with a pull request ref from a fork, as GitHub keeps them.
  const work = makeFixture('linear')
  const prHead = work.commit('fork work', { 'fork.txt': 'f\n' })
  work.git('reset', '-q', '--hard', 'HEAD~1')
  const bare = tempDir('gitgoose-gh-bare-')
  execFileSync('git', ['clone', '-q', '--bare', work.dir, bare])
  execFileSync('git', ['update-ref', 'refs/pull/5/head', prHead], { cwd: bare })

  const r = initRepo()
  r.git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  r.git('config', `url.${bare}.insteadOf`, 'https://github.com/acme/widgets.git')
  r.git('fetch', '-q', 'origin')
  r.git('reset', '-q', '--hard', 'origin/main')
  r.git('checkout', '-q', '-b', 'feature')
  r.commit('Add the feature', { 'feature.txt': 'x\n' })
  r.checkout('main')

  const gh = await fakeGitHub({ pulls: [{
    number: 5, title: 'Fork improvement', html_url: 'https://github.com/acme/widgets/pull/5', user: { login: 'grace' },
    head: { ref: 'improve', sha: prHead, repo: { full_name: 'grace/widgets' } }, base: { ref: 'main' },
  }] })
  const pullHits = () => gh.hits.filter((h) => h.endsWith('/pulls'))
  const { app, page } = await launch(r.dir, { GITGOOSE_GITHUB_URL: gh.url })
  const opened = await captureOpened(app)
  await expect(page.getByTestId('commit-row').first()).toBeVisible()
  // Nothing asks GitHub for pull requests until the list is opened.
  expect(pullHits()).toEqual([])

  // Pull Requests is a Workspace item in the sidebar; opening it asks GitHub.
  await page.locator('[data-testid="workspace-item"][data-item="pulls"]').click()
  const pr5 = page.locator('[data-testid="pull-item"][data-number="5"]')
  await expect(pr5).toContainText('Fork improvement')
  await expect(pr5).toContainText('fork')
  await page.getByRole('button', { name: 'Refresh pull requests' }).click()
  await expect.poll(pullHits).toEqual(['GET /repos/acme/widgets/pulls', 'GET /repos/acme/widgets/pulls'])
  // Not signed in: no request to the fake GitHub carries credentials.
  expect(gh.authorization.filter(Boolean)).toEqual([])

  await pr5.dblclick()
  await expect.poll(() => r.git('branch', '--show-current').trim()).toBe('pr/5')
  expect(r.head()).toBe(prHead)

  // Create one: feature is not on GitHub yet, so it is pushed first, then GitHub's own page opens.
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/feature"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Create pull request…' }).click()
  const dialog = page.getByTestId('create-pr')
  await expect(dialog.getByLabel('Title')).toHaveValue('Add the feature')
  await expect(dialog).toContainText('feature will be pushed to origin first')
  await expect(dialog.getByLabel('Draft')).toHaveCount(0)
  await dialog.getByPlaceholder('What this changes and why').fill('Because & why')
  await page.getByTestId('dialog-submit').click()
  await expect.poll(opened).toHaveLength(1)
  expect(execFileSync('git', ['branch', '--list', 'feature'], { cwd: bare, encoding: 'utf8' })).toContain('feature')
  const url = new URL((await opened())[0]!)
  expect(url.origin).toBe(gh.url)
  expect(url.pathname).toBe('/acme/widgets/compare/main...feature')
  expect(url.searchParams.get('expand')).toBe('1')
  expect(url.searchParams.get('title')).toBe('Add the feature')
  expect(url.searchParams.get('body')).toBe('Because & why')
  await expect(page.getByRole('status').filter({ hasText: 'Finish the pull request on GitHub' })).toBeVisible()
  // The app never tries to create it through the API.
  expect(gh.hits.filter((h) => h.startsWith('POST'))).toEqual([])
  await app.close()
  await gh.close()
})
