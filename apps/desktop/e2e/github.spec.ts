import { fakeGitHub, makeFixture, tempDir } from '@gitsquid/fixtures'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

async function openAccounts(page: Page) {
  await page.getByTestId('toolbar').getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByTestId('github-account')).toBeVisible()
}

/** Record the URLs the app asks the OS to open, instead of starting a browser. */
async function captureOpened(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] }
    g.opened = []
    shell.openExternal = async (url: string) => {
      g.opened.push(url)
    }
  })
  return () => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)
}

test('signs in with the device flow, finds avatars through GitHub, and signs out', async () => {
  const r = makeFixture('linear')
  r.git('commit', '-q', '--allow-empty', '-m', 'by grace', '--author', 'Grace Hopper <grace@example.com>')
  const grace = r.head()
  r.git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  r.git('update-ref', 'refs/remotes/origin/main', grace)
  const gh = await fakeGitHub({ pendingPolls: 1, commits: { [grace]: 'ghopper' } })
  const profile = tempDir('gitsquid-profile-')
  const { app, page } = await launch(r.dir, {
    GITSQUID_USER_DATA: profile,
    GITSQUID_GITHUB_URL: gh.url,
    GITSQUID_GITHUB_CLIENT_ID: 'test-client',
  })
  const opened = await captureOpened(app)
  await page.evaluate(() => window.gitsquid.setSettings({ avatars: 'github' }))
  // Signed out: GitHub is never contacted, whatever the graph shows.
  await expect(page.getByTestId('commit-row').first().locator('image')).toHaveCount(1)
  expect(gh.hits).toEqual([])

  await openAccounts(page)
  await page.getByTestId('github-sign-in').click()
  await expect(page.getByTestId('github-user-code')).toHaveText('WDJB-MJHT')
  await page.getByTestId('github-open').click()
  await expect.poll(opened).toEqual([`${gh.url}/login/device`])
  await expect(page.getByTestId('github-login')).toContainText('octocat', { timeout: 15_000 })
  await expect(page.getByTestId('github-dialog')).toHaveCount(0)
  await expect(page.getByTestId('github-login')).toContainText('profile only')
  // The token is in the keychain-encrypted file, or (no keychain on this machine) nowhere on disk.
  const file = join(profile, 'github.json')
  if (existsSync(file)) expect(readFileSync(file, 'utf8')).not.toContain('gho_fake1')

  // Back on the graph, Grace's commit asks GitHub who wrote it and shows that account's picture.
  await page.getByTestId('settings-close').click()
  await expect(page.getByTestId('commit-row').first().locator('image')).toHaveAttribute('href', /\?v=gh$/)
  await expect.poll(() => gh.hits).toContain(`GET /repos/acme/widgets/commits/${grace}`)
  await expect.poll(() => gh.hits).toContain('GET /avatars/ghopper.png')

  await openAccounts(page)
  await page.getByTestId('github-sign-out').click()
  await expect(page.getByTestId('github-sign-in')).toBeVisible()
  if (existsSync(file)) throw new Error('github.json should be gone after signing out')
  await app.close()
  await gh.close()
})

test('a sign-in denied on GitHub says so, and leaves you signed out', async () => {
  const gh = await fakeGitHub({ outcome: 'access_denied' })
  const { app, page } = await launch(makeFixture('linear').dir, { GITSQUID_GITHUB_URL: gh.url, GITSQUID_GITHUB_CLIENT_ID: 'test-client' })
  await openAccounts(page)
  await page.getByTestId('github-sign-in').click()
  await expect(page.getByTestId('github-error')).toContainText('cancelled on GitHub', { timeout: 15_000 })
  await page.getByTestId('github-cancel').click()
  await expect(page.getByTestId('github-sign-in')).toBeVisible()
  await app.close()
  await gh.close()
})

test('without a client id, sign-in is explained instead of offered', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir, { GITSQUID_GITHUB_CLIENT_ID: '' })
  await openAccounts(page)
  await expect(page.getByTestId('github-account')).toContainText('not set up in this build')
  await expect(page.getByTestId('github-sign-in')).toHaveCount(0)
  await app.close()
})

test('turning on HTTPS push asks GitHub for repository access in a second, separate grant', async () => {
  const gh = await fakeGitHub({ pendingPolls: 0 })
  const { app, page } = await launch(makeFixture('linear').dir, { GITSQUID_GITHUB_URL: gh.url, GITSQUID_GITHUB_CLIENT_ID: 'test-client' })
  await openAccounts(page)
  await page.getByTestId('github-sign-in').click()
  await expect(page.getByTestId('github-login')).toContainText('profile only', { timeout: 15_000 })
  await expect(page.getByTestId('github-grant-repo')).toHaveCount(0)
  await page.evaluate(() => window.gitsquid.setSettings({ githubHttps: true }))
  await page.getByTestId('github-grant-repo').click()
  await expect(page.getByTestId('github-dialog')).toContainText('scope "repo"')
  await expect(page.getByTestId('github-login')).toContainText('profile and repositories', { timeout: 15_000 })
  await expect(page.getByTestId('github-grant-repo')).toHaveCount(0)
  await app.close()
  await gh.close()
})
