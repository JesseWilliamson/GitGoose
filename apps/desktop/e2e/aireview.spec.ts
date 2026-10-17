import { initRepo } from '@gitsquid/fixtures'
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

const FAKE = join(import.meta.dirname, 'fake-agent.mjs')
const AGENT_CMD = `"${process.execPath}" "${FAKE}"`
const AGENT = { aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: AGENT_CMD, aiConsent: [`agent:${AGENT_CMD}`], reviewProfile: 'assertive' }

test('AI review: verified findings in the review view and the diff gutter; invented ones are thrown out', async () => {
  const r = initRepo()
  r.commit('root', { 'src/calc.ts': 'export function total(a: number, b: number) {\n  return a + b\n}\n' })
  r.write('src/calc.ts', 'export function total(a: number, b: number) {\n  return a - b\n}\n')
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitsquid.setSettings(p as never), AGENT)

  await page.getByTestId('review-menu').click()
  await page.getByRole('menuitem', { name: 'Review all uncommitted changes' }).click()
  const review = page.getByTestId('review')
  await expect(review.getByTestId('finding')).toHaveCount(1)
  const finding = review.getByTestId('finding')
  await expect(finding).toContainText('Possible bug here')
  await expect(finding).toContainText('lines 2')
  await expect(finding.getByTestId('suggestion')).toContainText('-   return a - b')
  await expect(finding.getByTestId('suggestion')).toContainText('+   return a + b')
  await expect(review.getByTestId('review-summary')).toHaveText('Adds a small change; one thing to fix.')
  await review.getByTestId('dropped-toggle').click()
  await expect(review.getByTestId('dropped')).toContainText('Hallucinated: invented/file.ts is not in this change')

  // Show in diff: the marker sits on line 2; clicking it comes back to the finding.
  await finding.getByRole('button', { name: 'Show in diff' }).click()
  await expect(page.getByTestId('finding-marker')).toHaveCount(1)
  await page.getByTestId('finding-marker').click()
  await expect(review).toBeVisible()

  await finding.getByRole('button', { name: 'Dismiss' }).click()
  await expect(review.getByTestId('finding')).toHaveCount(0)
  await app.close()
})

async function reviewed(page: import('@playwright/test').Page) {
  await page.getByTestId('review-menu').click()
  await page.getByRole('menuitem', { name: 'Review all uncommitted changes' }).click()
  await expect(page.getByTestId('finding')).toHaveCount(1)
  return page.getByTestId('finding')
}

test('apply a suggestion (undoable); fix with AI shows the change before writing anything', async () => {
  const r = initRepo()
  r.commit('root', { 'src/calc.ts': 'export function total(a: number, b: number) {\n  return a + b\n}\n' })
  const broken = 'export function total(a: number, b: number) {\n  return a - b\n}\n'
  r.write('src/calc.ts', broken)
  const file = () => readFileSync(join(r.dir, 'src/calc.ts'), 'utf8')
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitsquid.setSettings(p as never), AGENT)

  let finding = await reviewed(page)
  await finding.getByTestId('apply-suggestion').click()
  await expect.poll(file).toContain('return a + b')
  await expect(page.getByTestId('finding')).toHaveCount(0)
  await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).last().click()
  await expect.poll(file).toBe(broken)

  // Fix with AI: the agent asks to edit; its version is shown as a diff; Use writes it.
  finding = await reviewed(page)
  await finding.getByTestId('fix-with-ai').click()
  await page.getByTestId('ai-permission-allow_once').click()
  const diff = page.getByTestId('ai-fix-diff')
  await expect(diff).toContainText('-   return a - b')
  await expect(diff).toContainText('+   return a + b')
  expect(file()).toBe(broken) // nothing written yet
  await page.getByTestId('ai-fix-accept').click()
  await expect.poll(file).toContain('return a + b')
  await app.close()
})

test('the review follows the project: guideline files shown; a remembered dismissal stops the finding next time', async () => {
  const r = initRepo()
  r.commit('root', { 'src/calc.ts': 'export function total(a: number, b: number) {\n  return a + b\n}\n', 'CLAUDE.md': 'Prefer small functions.\n' })
  r.write('src/calc.ts', 'export function total(a: number, b: number) {\n  return a - b\n}\n')
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitsquid.setSettings(p as never), AGENT)
  const finding = await reviewed(page)
  await expect(page.getByTestId('review-context')).toContainText('Followed CLAUDE.md')
  await expect(page.getByTestId('review-context')).toContainText('0 learnings')

  await finding.getByTestId('remember-dismissal').click()
  await expect(page.getByTestId('dialog-input')).toHaveValue('Do not flag "Possible bug here"')
  await page.getByTestId('dialog-submit').click()
  await expect(page.getByTestId('finding')).toHaveCount(0)

  await page.getByTestId('review').getByRole('button', { name: 'Review again' }).click()
  await expect(page.getByTestId('review-summary')).toHaveText("Fine by the team's rules.")
  await expect(page.getByTestId('review-context')).toContainText('1 learning')
  await page.getByRole('button', { name: 'Manage learnings' }).click()
  await expect(page.getByTestId('learnings')).toContainText('Do not flag "Possible bug here"')
  await page.getByTestId('learnings').getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByTestId('learnings')).not.toContainText('possible bug')
  await app.close()
})

test('review again: unchanged findings stay open, changed code counts as addressed and is re-reviewed', async () => {
  const r = initRepo()
  r.commit('root', { 'src/calc.ts': 'export function total(a: number, b: number) {\n  return a + b\n}\n' })
  r.write('src/calc.ts', 'export function total(a: number, b: number) {\n  return a - b\n}\n')
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitsquid.setSettings(p as never), AGENT)
  await reviewed(page)
  const review = page.getByTestId('review')

  // Nothing changed: the finding is carried over without asking again.
  await review.getByRole('button', { name: 'Review again' }).click()
  await expect(review.getByTestId('review-incremental')).toContainText('Re-review: 0 changed pieces sent, 1 unchanged.')
  await expect(review.getByTestId('finding-status')).toHaveText('still open')

  // Change the flagged line: the old finding is addressed, the new code is reviewed.
  r.write('src/calc.ts', 'export function total(a: number, b: number) {\n  return a * b\n}\n')
  await review.getByRole('button', { name: 'Review again' }).click()
  await expect(review.getByTestId('review-incremental')).toContainText('1 changed piece sent, 0 unchanged.')
  await expect(review.getByTestId('review-addressed')).toContainText('Possible bug here (src/calc.ts)')
  await expect(review.getByTestId('finding-status')).toHaveText('new')
  await expect(review.getByTestId('finding')).toContainText('return a * b')
  await app.close()
})
