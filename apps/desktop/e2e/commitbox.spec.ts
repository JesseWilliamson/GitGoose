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

function setup() {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'a\n' })
  r.git('commit', '-q', '--allow-empty', '-m', 'by grace', '--author=Grace Hopper <grace@example.com>')
  r.write('a.txt', 'changed\n')
  r.git('add', 'a.txt')
  return r
}

test('a commit template prefills the message; add a co-author; change identity for this repository', async () => {
  const r = setup()
  writeFileSync(join(r.dir, '.gitmessage'), 'fix: \n\n# Explain why, not what.\n')
  r.git('config', 'commit.template', '.gitmessage')
  const { app, page } = await launch(r.dir, isolatedGlobal())
  await expect(page.getByTestId('commit-summary')).toHaveValue('fix:')
  await expect(page.getByTestId('commit-body')).toHaveAttribute('placeholder', 'Explain why, not what.')
  // Still just the template: nothing has been written yet.
  await expect(page.getByTestId('commit-button')).toBeDisabled()
  await page.getByTestId('commit-summary').fill('fix: handle empty input')

  await page.getByTestId('commit-options').click()
  await page.getByRole('menuitem', { name: 'Add co-author…' }).click()
  await page.getByTestId('pick-filter').fill('grace')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('commit-body')).toHaveValue('Co-authored-by: Grace Hopper <grace@example.com>')

  await expect(page.getByTestId('commit-identity')).toContainText('as Ada Lovelace <ada@example.com> · this repository')
  await page.getByTestId('commit-identity').click()
  await page.getByLabel('Name').fill('Ada King')
  await page.getByTestId('dialog-submit').click()
  await expect(page.getByTestId('commit-identity')).toContainText('as Ada King')
  await page.getByTestId('commit-button').click()
  await expect.poll(() => r.git('log', '-1', '--format=%an|%B').trim()).toBe('Ada King|fix: handle empty input\n\nCo-authored-by: Grace Hopper <grace@example.com>')

  // Drop the repository's own identity: the global one applies.
  await page.getByTestId('commit-identity').click()
  await page.getByRole('button', { name: 'Use the global one here' }).click()
  await expect(page.getByTestId('commit-identity')).toHaveText('as Global Person <global@example.com>')
  await app.close()
})

test('a failing pre-commit hook shows its output; Skip hooks commits anyway', async () => {
  const r = setup()
  writeFileSync(join(r.dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho "lint: a.txt is not formatted" >&2\nexit 1\n', { mode: 0o755 })
  const { app, page } = await launch(r.dir, isolatedGlobal())
  await page.getByTestId('commit-summary').fill('change a')
  await page.getByTestId('commit-button').click()
  await expect(page.getByTestId('attention-row').first()).toContainText('Commit failed')
  await page.getByTestId('attention-row').first().getByRole('button', { name: 'Details' }).click()
  await expect(page.getByTestId('attention-row').first()).toContainText('lint: a.txt is not formatted')

  await page.getByTestId('commit-options').click()
  await page.getByTestId('skip-hooks').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('commit-options')).toContainText('no hooks')
  await page.getByTestId('commit-button').click()
  await expect.poll(() => r.git('log', '-1', '--format=%s').trim()).toBe('change a')
  await expect(page.getByTestId('commit-options')).not.toContainText('no hooks')
  await app.close()
})

test('with AI on, the target button, Write and Commit all fit in the footer without overlapping', async () => {
  const r = setup()
  const { app, page } = await launch(r.dir, isolatedGlobal())
  await page.evaluate(() => window.gitgoose.setSettings({ aiProvider: 'agent', aiAgent: 'claude' } as never))
  const box = page.getByTestId('commit-box')
  await expect(box.getByTestId('ai-commit-message')).toBeVisible()
  // One quiet button names who answers ("Claude · default"); the selects and Prompt are in its popover.
  const target = box.getByTestId('ai-target-commit')
  await expect(target).toHaveText('Claude · default')
  const bounds = (await box.boundingBox())!
  type Rect = { x: number; y: number; width: number; height: number }
  const rects: Rect[] = [(await page.getByTestId('commit-button').boundingBox())!, (await box.getByTestId('ai-commit-message').boundingBox())!]
  rects.push((await target.boundingBox())!)
  for (const rect of rects) {
    expect(rect.x).toBeGreaterThanOrEqual(bounds.x)
    expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width + 0.5)
  }
  const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i]!, rects[j]!), `${i} overlaps ${j}`).toBe(false)
  await app.close()
})
