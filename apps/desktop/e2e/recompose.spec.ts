import { initRepo } from '@gitsquid/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { launch } from './app'

const FAKE = join(import.meta.dirname, 'fake-agent.mjs')
const AGENT_CMD = `"${process.execPath}" "${FAKE}"`
const AGENT = { aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: AGENT_CMD, aiConsent: [`agent:${AGENT_CMD}`] }

const row = (page: Page, hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)

/** base - C1 (a.txt + notes.md) - C2 (b.txt) - C3 (after the range) */
function setup() {
  const r = initRepo()
  r.commit('base', { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  const C1 = r.commit('wip stuff', { 'a.txt': 'a changed\n', 'notes.md': '# notes\n' })
  const C2 = r.commit('more wip', { 'b.txt': 'b changed\n' })
  const C3 = r.commit('docs: later', { 'later.txt': 'later\n' })
  return { r, C1, C2, C3 }
}

test('recompose: the AI proposes, you reorder and edit, Create commits rewrites, Undo restores', async () => {
  const { r, C1, C2, C3 } = setup()
  const tree = r.git('rev-parse', 'HEAD^{tree}').trim()
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitsquid.setSettings(p as never), AGENT)
  await row(page, C2).click()
  await row(page, C1).click({ modifiers: ['Shift'] })
  await page.getByTestId('multi-recompose').click()

  // The fake agent's plan: the last piece (notes.md… whichever came last) alone first, then the rest.
  const commits = page.getByTestId('recompose-commit')
  const titles = page.getByTestId('recompose-title')
  await expect(commits).toHaveCount(2)
  await expect(titles.nth(1)).toHaveText('feat: everything else')
  await expect(page.getByTestId('recompose-summary')).toContainText('wip stuff · more wip')
  // Nothing has changed yet.
  expect(r.head()).toBe(C3)

  // Reorder, reset, reorder again, then edit the (now first) commit's message.
  await page.getByTestId('recompose-down').first().click()
  await expect(titles.first()).toHaveText('feat: everything else')
  await page.getByTestId('recompose-reset').click()
  await expect(titles.first()).not.toHaveText('feat: everything else')
  await page.getByTestId('recompose-down').first().click()
  await commits.first().click()
  await page.getByTestId('recompose-message').fill('feat: a and b')
  await expect(titles.first()).toHaveText('feat: a and b')

  await page.getByTestId('recompose-apply').click()
  await expect(page.getByTestId('recompose-dialog')).toHaveCount(0)
  const subjects = r.git('log', '--format=%s', '-4').trim().split('\n')
  expect(subjects[0]).toBe('docs: later')
  expect(subjects[1]).toMatch(/^chore: .* first$/)
  expect(subjects[2]).toBe('feat: a and b')
  expect(subjects[3]).toBe('base')
  // Same final code.
  expect(r.git('rev-parse', 'HEAD^{tree}').trim()).toBe(tree)

  await page.getByTestId('toolbar').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => r.head()).toBe(C3)
  await app.close()
})

test('squashing in the review, and refusing a selection that is not a range', async () => {
  const { r, C1, C3 } = setup()
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitsquid.setSettings(p as never), AGENT)
  // C1 and C3 do not follow each other: main refuses before asking the AI anything.
  await row(page, C3).click()
  await row(page, C1).click({ modifiers: ['Control'] })
  await page.getByTestId('multi-recompose').click()
  await expect(page.getByTestId('recompose-error')).toContainText('follow each other')
  await page.getByRole('button', { name: 'Close' }).click()

  // One commit can be split too; squash the proposal back into one. (A plain click first: while
  // both stay selected, the right-click menu is the one for the whole selection.)
  await row(page, C1).click()
  await row(page, C1).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Split with AI…' }).click()
  await expect(page.getByTestId('recompose-commit')).toHaveCount(2)
  await page.getByTestId('recompose-squash').first().click()
  await expect(page.getByTestId('recompose-commit')).toHaveCount(1)
  await expect(page.getByTestId('recompose-apply')).toHaveText('Create 1 commit')
  await page.getByTestId('recompose-apply').click()
  await expect(page.getByTestId('recompose-dialog')).toHaveCount(0)
  // C2 and C3 sit above the rebuilt C1, with their own messages and new parents.
  expect(r.git('log', '--format=%s', '-3').trim().split('\n')).toEqual(['docs: later', 'more wip', 'feat: everything else'])
  await app.close()
})

test('move a change to another commit or a new one; empty commits block until removed', async () => {
  const { r, C1, C2 } = setup()
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitsquid.setSettings(p as never), AGENT)
  await row(page, C2).click()
  await row(page, C1).click({ modifiers: ['Shift'] })
  await page.getByTestId('multi-recompose').click()
  const commits = page.getByTestId('recompose-commit')
  await expect(commits).toHaveCount(2)
  // The first proposed commit has one change; move it into the second: the first is now empty.
  await expect(page.getByTestId('recompose-unit')).toHaveCount(1)
  await page.getByTestId('recompose-move').click()
  await page.getByRole('menuitem', { name: '2. feat: everything else' }).click()
  await expect(commits.first()).toContainText('No changes')
  await expect(page.getByTestId('recompose-problems')).toContainText('Commit 1 has no changes')
  await expect(page.getByTestId('recompose-apply')).toBeDisabled()
  await page.getByTestId('recompose-remove-empty').click()
  await expect(commits).toHaveCount(1)

  // Back out of it into a new commit, which needs a message before it can be created.
  await commits.first().click()
  await expect(page.getByTestId('recompose-unit')).toHaveCount(3)
  await page.getByTestId('recompose-move').first().click()
  await page.getByRole('menuitem', { name: 'A new commit' }).click()
  await expect(commits).toHaveCount(2)
  await expect(page.getByTestId('recompose-problems')).toContainText('Commit 2 needs a message')
  await commits.nth(1).click()
  await page.getByTestId('recompose-message').fill('chore: split out')
  await page.getByTestId('recompose-apply').click()
  await expect(page.getByTestId('recompose-dialog')).toHaveCount(0)
  expect(r.git('log', '--format=%s', '-3').trim().split('\n')).toEqual(['docs: later', 'chore: split out', 'feat: everything else'])
  await app.close()
})
