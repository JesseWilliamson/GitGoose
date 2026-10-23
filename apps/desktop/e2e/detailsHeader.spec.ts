import { initRepo, tempDir } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

/** Keep the real ~/.gitconfig out of it. */
function isolatedGlobal() {
  const file = join(tempDir('gitgoose-global-'), 'gitconfig')
  writeFileSync(file, '[user]\n\tname = Global Person\n\temail = global@example.com\n')
  return { GIT_CONFIG_GLOBAL: file }
}

test('the Details header shows the author\'s name and a relative date; the e-mail is a tooltip, never truncated mid-address', async () => {
  const r = initRepo()
  const h = r.commit('root', { 'a.txt': 'a\n' })
  const { app, page } = await launch(r.dir, isolatedGlobal())
  await page.locator(`[data-testid="commit-row"][data-hash="${h}"]`).click()
  const author = page.getByTestId('details-author')
  await expect(author).toHaveText('Ada Lovelace')
  await expect(page.getByTestId('details-author').locator('b')).toHaveAttribute('title', 'Ada Lovelace <ada@example.com>')
  // No address anywhere in the header text.
  const header = author.locator('..')
  expect(await header.innerText()).not.toContain('@')
  // The date is relative ("2 min ago", or a date once it is old), with the exact time on hover.
  await expect(page.getByTestId('details-date')).not.toHaveText(/authored/)
  await expect(page.getByTestId('details-date')).toHaveAttribute('title', /\d/)
  await app.close()
})
