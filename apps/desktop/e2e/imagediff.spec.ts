import { FAKE_AVATAR_PNG, initRepo } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

/** A 2×1 red PNG (the other side is the 1×1 fixture avatar). */
const WIDE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGP4z8AARAAI/gH/xp559wAAAABJRU5ErkJggg==', 'base64')

test('an image change shows before and after, with sizes and dimensions, and swipe / onion modes', async () => {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'a\n' })
  writeFileSync(join(r.dir, 'logo.png'), FAKE_AVATAR_PNG)
  r.git('add', 'logo.png')
  r.git('commit', '-q', '-m', 'add logo')
  writeFileSync(join(r.dir, 'logo.png'), WIDE_PNG)
  const { app, page } = await launch(r.dir)
  await page.getByTestId('unstaged-file').filter({ hasText: 'logo.png' }).click()
  const diff = page.getByTestId('image-diff')
  // The text-diff hint (click lines to select them) means nothing for an image.
  await expect(page.getByTestId('diff-hint')).toHaveText('')
  await expect(page.getByTestId('commit-count')).toHaveText('2 commits')
  await expect(diff.getByTestId('image-old')).toContainText('Before · 69 B · 1×1')
  await expect(diff.getByTestId('image-new')).toContainText(`After · ${WIDE_PNG.length} B · 2×1`)
  await diff.getByRole('button', { name: 'Swipe' }).click()
  await expect(diff.getByLabel('Divider')).toBeVisible()
  await diff.getByRole('button', { name: 'Onion skin' }).click()
  await expect(diff.getByLabel('Opacity')).toBeVisible()
  await app.close()
})

test('an SVG shows rendered by default, with a toggle to its text diff', async () => {
  const r = initRepo()
  const svg = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><rect width="4" height="2" fill="${fill}"/></svg>\n`
  r.commit('root', { 'icon.svg': svg('red') })
  writeFileSync(join(r.dir, 'icon.svg'), svg('blue'))
  const { app, page } = await launch(r.dir)
  await page.getByTestId('unstaged-file').filter({ hasText: 'icon.svg' }).click()
  const diff = page.getByTestId('image-diff')
  await expect(diff.getByTestId('image-old')).toContainText('Before')
  await expect(diff.getByTestId('image-new')).toContainText('After')
  await expect(diff.getByTestId('image-new')).toContainText('4×2')
  await expect(page.getByTestId('diff-hint')).toHaveText('')
  // The text diff is still there for staging lines, and the choice sticks for the next SVG.
  await page.getByTestId('svg-view').getByRole('button', { name: 'Text' }).click()
  await expect(page.getByTestId('diff-lines')).toContainText('fill="blue"')
  await expect(page.getByTestId('image-diff')).toHaveCount(0)
  await page.getByTestId('svg-view').getByRole('button', { name: 'Image' }).click()
  await expect(diff).toBeVisible()
  await app.close()
})
