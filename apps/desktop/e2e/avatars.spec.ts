import { fakeGitHub, makeFixture, tempDir } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { launch } from './app'

// A real 1x1 PNG, served by a local stand-in for avatars.githubusercontent.com.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

async function avatarServer(): Promise<{ server: Server; base: string; hits: string[] }> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url!)
    if (req.url!.startsWith('/u/583231')) {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits }
}

/**
 * The linear fixture (Ada Lovelace's commits) plus one by a GitHub noreply address and one by
 * Grace, all already on the repository's GitHub remote. The fake GitHub knows Grace's commit.
 */
async function setup() {
  const r = makeFixture('linear')
  r.git('commit', '-q', '--allow-empty', '-m', 'from octocat', '--author', 'Octo Cat <583231+octocat@users.noreply.github.com>')
  r.git('commit', '-q', '--allow-empty', '-m', 'by grace', '--author', 'Grace Hopper <grace@example.com>')
  const grace = r.head()
  r.git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  // A remote-tracking ref stands in for a push: these commits are "on GitHub".
  r.git('update-ref', 'refs/remotes/origin/main', grace)
  const avatars = await avatarServer()
  const gh = await fakeGitHub({ commits: { [grace]: 'ghopper' } })
  const env = { GITGOOSE_AVATAR_GITHUB_BASE: avatars.base, GITGOOSE_GITHUB_API: gh.url }
  return { r, grace, avatars, gh, env }
}

test('with initials only, no avatar is requested from anywhere', async () => {
  const { r, avatars, gh, env } = await setup()
  const profile = tempDir('gitgoose-profile-')
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ settingsVersion: 5, avatars: 'initials' }))
  const { app, page } = await launch(r.dir, { ...env, GITGOOSE_USER_DATA: profile })
  const octo = page.getByTestId('commit-row').filter({ hasText: 'from octocat' })
  await expect(octo.getByTestId('row-avatar')).toContainText('OC')
  await expect(page.getByTestId('commit-row').locator('img')).toHaveCount(0)
  await octo.click()
  await expect(page.getByTestId('detail-panel')).toContainText('Octo Cat')
  await expect(page.getByTestId('detail-panel').locator('img')).toHaveCount(0)
  expect(avatars.hits).toEqual([])
  expect(gh.hits).toEqual([])
  await app.close()
  avatars.server.close()
  await gh.close()
})

test('GitHub avatars by default, without signing in; initials only until an image loads', async () => {
  const { r, grace, avatars, gh, env } = await setup()
  const { app, page } = await launch(r.dir, env)
  const row = (subject: string) => page.getByTestId('commit-row').filter({ hasText: subject }).first().getByTestId('row-avatar').locator('[data-avatar]')

  // A noreply address names the account: its picture comes straight from the avatars host.
  const octo = row('from octocat')
  await expect(octo.locator('img')).toHaveAttribute('src', /gitgoose-avatar:\/\/author\/583231/)
  await expect(octo).toHaveAttribute('data-avatar', 'loaded')
  expect(avatars.hits).toContain('/u/583231?s=64&v=4')
  // Loaded: the initials and their coloured disc are gone, so nothing shows through a transparent picture.
  await expect(octo).not.toContainText('OC')
  expect(await octo.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')

  // Any other author: GitHub's public commits API says whose a pushed commit is.
  const graceAvatar = row('by grace')
  await expect(graceAvatar).toHaveAttribute('data-avatar', 'loaded')
  expect(gh.hits).toContain(`GET /repos/acme/widgets/commits/${grace}`)
  expect(gh.hits).toContain('GET /avatars/ghopper.png')
  expect(gh.authorization.filter(Boolean)).toEqual([])

  // An author GitHub has no account for: the image fails (a 404) and the initials stay.
  const ada = row('Commit 4')
  await expect(ada).toHaveAttribute('data-avatar', 'failed')
  await expect(ada).toContainText('AL')
  await expect(ada.locator('img')).toHaveCount(0)

  // The image really loads through the custom scheme: CSP allows it as an image (and only as an
  // image: fetch() from the page is still blocked), and the main process serves the bytes.
  await page.getByTestId('commit-row').filter({ hasText: 'from octocat' }).click()
  const img = page.getByTestId('detail-panel').locator('img[src^="gitgoose-avatar:"]').first()
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1)
  await app.close()
  avatars.server.close()
  await gh.close()
})

test('merge commits are marked as merges', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  const merge = page.getByTestId('commit-row').filter({ hasText: 'M' }).filter({ has: page.locator('svg[data-node="merge"]') })
  await expect(merge).toHaveCount(1)
  await app.close()
})
