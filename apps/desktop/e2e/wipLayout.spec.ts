import { initRepo, tempDir } from '@gitgoose/fixtures'
import { expect, test, type Locator } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

/** Keep the real ~/.gitconfig out of it. */
function isolatedGlobal() {
  const file = join(tempDir('gitgoose-global-'), 'gitconfig')
  writeFileSync(file, '[user]\n\tname = Global Person\n\temail = global@example.com\n')
  return { GIT_CONFIG_GLOBAL: file }
}

const heightOf = async (loc: Locator) => Math.round((await loc.boundingBox())!.height)

test('Unstaged and Staged share the height by content; the identity follows the commit fields', async () => {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'a\n' })
  // Three untracked files and nothing staged.
  for (const n of ['one', 'two', 'three']) r.write(`${n}.txt`, `${n}\n`)
  const { app, page } = await launch(r.dir, isolatedGlobal(), { keepSize: true })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 900))
  // The sections themselves (the lists inside carry the same test ids).
  const unstaged = page.locator('[data-testid="unstaged"]').first()
  const staged = page.locator('[data-testid="staged"]').first()
  await expect(page.getByTestId('unstaged-file')).toHaveCount(3)
  // A header (28 px) and three rows (24 px each), not half the panel; an empty Staged is a
  // header and one muted line.
  await expect.poll(() => heightOf(unstaged)).toBeLessThanOrEqual(28 + 3 * 28)
  await expect.poll(() => heightOf(staged)).toBeLessThanOrEqual(28 + 28)
  await expect(staged).toContainText('Nothing staged')

  // Many unstaged files and one staged: Staged keeps its natural height, Unstaged gets the rest.
  for (let i = 0; i < 40; i++) r.write(`many-${i}.txt`, 'x\n')
  r.write('a.txt', 'staged change\n')
  r.git('add', 'a.txt')
  await expect(page.getByTestId('staged-file')).toHaveCount(1)
  await expect.poll(() => heightOf(staged)).toBeLessThanOrEqual(28 + 40)
  expect(await heightOf(unstaged)).toBeGreaterThan(3 * (await heightOf(staged)))

  // The identity is information about the commit: it comes after the fields and the buttons.
  const y = async (id: string) => (await page.getByTestId(id).boundingBox())!.y
  expect(await y('commit-identity')).toBeGreaterThan(await y('commit-button'))
  expect(await y('commit-identity')).toBeGreaterThan(await y('commit-body'))
  await app.close()
})
