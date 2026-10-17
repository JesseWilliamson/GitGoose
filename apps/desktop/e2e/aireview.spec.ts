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
