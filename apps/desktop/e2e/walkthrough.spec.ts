import { initRepo } from '@gitsquid/fixtures'
import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { launch } from './app'

const FAKE = join(import.meta.dirname, 'fake-agent.mjs')
const AGENT_CMD = `"${process.execPath}" "${FAKE}"`
const AGENT = { aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: AGENT_CMD, aiConsent: [`agent:${AGENT_CMD}`] }

test('walkthrough of a commit: summary, effort, checked groups, sequence diagram, reading order, history', async () => {
  const r = initRepo()
  r.commit('root', { 'src/calc.ts': 'export function total(a: number, b: number) {\n  return a - b\n}\n', 'src/calc.test.ts': 'test("t", () => {})\n' })
  const fix = r.commit('fix the total', {
    'src/calc.ts': "import { log } from './log'\nexport function total(a: number, b: number) {\n  return a + b\n}\n",
    'src/calc.test.ts': 'test("t", () => {\n  expect(total(1, 2)).toBe(3)\n})\n',
  })
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitsquid.setSettings(p as never), AGENT)
  await page.locator(`[data-testid="commit-row"][data-hash="${fix}"]`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Walk me through this commit' }).click()

  const w = page.getByTestId('walkthrough')
  await expect(w.getByTestId('walkthrough-summary')).toHaveText('Changes 2 files to make totals right.')
  await expect(w.getByTestId('effort')).toHaveText('Review effort 2/5')
  // The invented file is gone; the file nobody grouped gets "Other changes".
  const groups = w.getByTestId('walkthrough-groups')
  await expect(groups).not.toContainText('invented.ts')
  await expect(groups).toContainText('Other changes')
  await expect(w.getByTestId('sequence').locator('text', { hasText: 'total(a, b)' })).toHaveCount(1)
  // Reading order: implementation before tests, each with its summary.
  const hunks = w.getByTestId('reading-hunk')
  await expect(hunks.first()).toContainText('src/calc.ts')
  await expect(hunks.last()).toContainText('src/calc.test.ts')
  await expect(hunks.first()).toContainText('Piece H1 of src/calc.ts')
  await expect(w).toContainText('root') // recent history of these files
  await app.close()
})
