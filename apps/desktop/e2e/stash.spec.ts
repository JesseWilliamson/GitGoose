import { initRepo } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

function setup() {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  r.write('a.txt', 'a2\n').write('b.txt', 'b2\n')
  return r
}
const item = (page: import('@playwright/test').Page, name: string) => page.getByRole('menuitem', { name })

test('stash only the staged changes; stash a single file', async () => {
  const r = setup()
  r.git('add', 'a.txt')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('stash-menu').click()
  await item(page, 'Stash only the staged changes').click()
  await expect(page.getByTestId('staged-file')).toHaveCount(0)
  await expect(page.getByTestId('unstaged-file')).toHaveCount(1)
  await expect(page.getByTestId('unstaged-file')).toContainText('b.txt')
  await expect(page.getByTestId('stash-item')).toHaveCount(1)

  await page.getByTestId('unstaged-file').filter({ hasText: 'b.txt' }).click({ button: 'right' })
  await item(page, 'Stash this file').click()
  await expect(page.getByTestId('stash-item')).toHaveCount(2)
  expect(r.git('status', '--porcelain')).toBe('')
  await app.close()
})

test('take one file out of a stash; turn a stash into a branch', async () => {
  const r = setup()
  r.git('stash', 'push', '-q', '-m', 'two files')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('stash-item').click()
  await page.getByTestId('commit-file').filter({ hasText: 'a.txt' }).click({ button: 'right' })
  await item(page, 'Take this file from the stash').click()
  await expect.poll(() => readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('a2\n')
  expect(readFileSync(join(r.dir, 'b.txt'), 'utf8')).toBe('b\n')
  await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).last().click()
  await expect.poll(() => r.git('status', '--porcelain')).toBe('')

  await page.getByTestId('stash-item').click({ button: 'right' })
  await item(page, 'Create a branch from this stash…').click()
  await page.getByTestId('dialog-input').fill('rescued')
  await page.getByTestId('dialog-submit').click()
  await expect.poll(() => r.git('branch', '--show-current').trim()).toBe('rescued')
  await expect(page.getByTestId('stash-item')).toHaveCount(0)
  await expect(page.getByTestId('unstaged-file')).toHaveCount(2)
  await app.close()
})

test('a snapshot saves the changes in the stash list and leaves them in place; undo removes it', async () => {
  const r = setup()
  r.write('new.txt', 'n\n')
  const { app, page } = await launch(r.dir)
  await page.getByTestId('stash-menu').click()
  await item(page, 'Save a snapshot (changes stay as they are)').click()
  await expect(page.getByTestId('stash-item')).toHaveCount(1)
  await expect(page.getByTestId('unstaged-file')).toHaveCount(3)
  expect(r.git('status', '--porcelain').trim().split('\n')).toHaveLength(3)
  await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).last().click()
  await expect(page.getByTestId('stash-item')).toHaveCount(0)
  await expect(page.getByTestId('unstaged-file')).toHaveCount(3)
  await app.close()
})
