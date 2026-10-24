import { initRepo } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { launch, sendComposed } from './app'

const FAKE = join(import.meta.dirname, 'fake-agent.mjs')
const AGENT_CMD = `"${process.execPath}" "${FAKE}"`
const AGENT = { aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: AGENT_CMD, aiConsent: [`agent:${AGENT_CMD}`] }

test('impact of uncommitted changes: touched definitions, uses elsewhere, tests; the AI flags only listed uses', async () => {
  const r = initRepo()
  r.commit('root', {
    'src/price.ts': 'export function total(a: number, b: number) {\n  return a + b\n}\n',
    'src/cart.ts': "import { total } from './price'\nexport function checkout() {\n  return total(1, 2)\n}\n",
    'src/price.test.ts': "import { total } from './price'\ntest('total', () => expect(total(1, 2)).toBe(3))\n",
  })
  r.write('src/price.ts', 'export function total(a: number, b: number) {\n  return Math.round(a + b)\n}\n')
  const { app, page } = await launch(r.dir)

  // Local, no AI needed.
  await page.getByTestId('review-menu').click()
  await page.getByRole('menuitem', { name: 'What could these changes affect?…' }).click()
  await sendComposed(page, 'impact')
  const view = page.getByTestId('impact')
  await expect(view.getByTestId('impact-symbols')).toContainText('changedtotalfunction')
  await expect(view.getByTestId('impact-caller')).toHaveCount(4)
  await expect(view.getByTestId('impact-callers')).toContainText('function checkout')
  await expect(view.getByTestId('impact-tests')).toHaveText('src/price.test.ts')
  await expect(view.getByTestId('assess-impact')).toHaveCount(0) // AI is off

  await page.evaluate((p) => window.gitgoose.setSettings(p as never), AGENT)
  await view.getByTestId('assess-impact').click()
  await expect(view.getByTestId('impact-assessment')).toContainText('One caller relies on the old rounding.')
  await expect(view.getByTestId('impact-assessment')).toContainText('1 use at risk · 1 answer ignored')
  const risky = view.locator('[data-testid="impact-caller"][data-risk]')
  await expect(risky).toHaveCount(1)
  await expect(risky).toContainText('It expects unrounded totals.')
  await app.close()
})
