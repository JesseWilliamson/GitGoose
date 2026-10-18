import { makeFixture } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
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

test('commit nodes show initials, and GitHub avatars when turned on, with no network until then', async () => {
  const r = makeFixture('linear')
  r.git('commit', '-q', '--allow-empty', '-m', 'from octocat', '--author', 'Octo Cat <583231+octocat@users.noreply.github.com>')
  const { server, base, hits } = await avatarServer()
  const { app, page } = await launch(r.dir, { GITGOOSE_AVATAR_GITHUB_BASE: base })
  const first = page.getByTestId('commit-row').first()
  await expect(first.getByTestId('avatar-node')).toContainText('OC')
  await expect(first.locator('image')).toHaveCount(0)
  expect(hits).toEqual([])

  await page.evaluate(() => window.gitgoose.setSettings({ avatars: 'github' }))
  await expect(first.locator('image')).toHaveAttribute('href', /gitgoose-avatar:\/\/author\/583231/)
  await expect.poll(() => hits).toContain('/u/583231?s=64&v=4')
  // The image really loads through the custom scheme: CSP allows it as an image (and only as an
  // image: fetch() from the page is still blocked), and the main process serves the bytes.
  // (The details panel shows it as an <img>; the graph node draws it in SVG.)
  await first.click()
  const img = page.getByTestId('detail-panel').locator('img[src^="gitgoose-avatar:"]').first()
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1)
  // Authors that GitHub cannot be asked about keep their initials and cost no request.
  const ada = page.getByTestId('commit-row').nth(1)
  await expect(ada.getByTestId('avatar-node')).toContainText('AL')
  expect(hits.filter((h) => !h.startsWith('/u/583231'))).toEqual([])
  await app.close()
  server.close()
})

test('merge commits are small dots', async () => {
  const r = makeFixture('branches')
  const { app, page } = await launch(r.dir)
  const merge = page.getByTestId('commit-row').filter({ hasText: 'M' }).filter({ has: page.locator('svg[data-node="merge"]') })
  await expect(merge).toHaveCount(1)
  await app.close()
})
