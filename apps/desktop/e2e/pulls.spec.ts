import { fakeGitHub, initRepo, makeFixture, tempDir } from '@gitsquid/fixtures'
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { launch } from './app'

test('pull requests: listed only on request, checked out from a fork, created from a branch', async () => {
  // "GitHub": a bare repository with a pull request ref from a fork, as GitHub keeps them.
  const work = makeFixture('linear')
  const prHead = work.commit('fork work', { 'fork.txt': 'f\n' })
  work.git('reset', '-q', '--hard', 'HEAD~1')
  const bare = tempDir('gitsquid-gh-bare-')
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

  const gh = await fakeGitHub({ pendingPolls: 0, pulls: [{
    number: 5, title: 'Fork improvement', html_url: 'https://github.com/acme/widgets/pull/5', user: { login: 'grace' },
    head: { ref: 'improve', sha: prHead, repo: { full_name: 'grace/widgets' } }, base: { ref: 'main' },
  }] })
  const { app, page } = await launch(r.dir, { GITSQUID_GITHUB_URL: gh.url, GITSQUID_GITHUB_CLIENT_ID: 'test-client' })
  await expect(page.getByTestId('commit-row').first()).toBeVisible()
  const section = page.getByTestId('sidebar').getByRole('button', { name: /^Pull requests/ })

  // Signed out: opening the list says how to get one; GitHub is not asked.
  await section.click()
  await expect(page.getByTestId('sidebar')).toContainText('to see pull requests')
  expect(gh.hits.filter((h) => h.includes('/pulls'))).toEqual([])
  await page.evaluate(async () => {
    await window.gitsquid.githubSignIn('repo')
    await window.gitsquid.githubWaitForSignIn()
  })
  await page.getByRole('button', { name: 'Refresh pull requests' }).click()
  const pr5 = page.locator('[data-testid="pull-item"][data-number="5"]')
  await expect(pr5).toContainText('Fork improvement')
  await expect(pr5).toContainText('fork')

  await pr5.dblclick()
  await expect.poll(() => r.git('branch', '--show-current').trim()).toBe('pr/5')
  expect(r.head()).toBe(prHead)

  // Create one: feature is not on GitHub yet, so it is pushed first.
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/feature"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Create pull request…' }).click()
  const dialog = page.getByTestId('create-pr')
  await expect(dialog.getByLabel('Title')).toHaveValue('Add the feature')
  await expect(dialog).toContainText('feature will be pushed to origin first')
  await dialog.getByLabel('Draft').check()
  await page.getByTestId('dialog-submit').click()
  await expect(page.getByRole('status').filter({ hasText: 'Opened pull request #6' })).toBeVisible()
  expect(execFileSync('git', ['branch', '--list', 'feature'], { cwd: bare, encoding: 'utf8' })).toContain('feature')
  expect(gh.pulls.at(-1)).toMatchObject({ title: 'Add the feature', head: { ref: 'feature' }, base: { ref: 'main' }, draft: true })
  await expect(page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/feature"]')).toContainText('#6')
  await app.close()
  await gh.close()
})
