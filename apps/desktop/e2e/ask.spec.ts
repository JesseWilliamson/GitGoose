import { initRepo } from '@gitsquid/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { launch } from './app'

const FAKE = join(import.meta.dirname, 'fake-agent.mjs')
const AGENT_CMD = `"${process.execPath}" "${FAKE}"`
const AGENT = { aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: AGENT_CMD, aiConsent: [`agent:${AGENT_CMD}`] }

/** Select the text of the diff line whose new line number is `n`. */
async function selectLine(page: Page, n: number) {
  await page.evaluate((no) => {
    const el = document.querySelector(`[data-testid="diff-lines"] [data-new="${no}"] span:last-child`)!
    const range = document.createRange()
    range.selectNodeContents(el)
    const s = window.getSelection()!
    s.removeAllRanges()
    s.addRange(range)
  }, n)
}

test('select lines in a diff and ask about them; follow up; the thread stays with the commit', async () => {
  const r = initRepo()
  r.commit('add pricing', {
    'src/tax.ts': 'export function taxRate(country: string): number {\n  return country === "NZ" ? 0.15 : 0.2\n}\n',
    'src/price.ts': 'export function gross(net: number, country: string): number {\n  return net\n}\n',
  })
  const apply = r.commit('apply tax', { 'src/price.ts': "import { taxRate } from './tax'\nexport function gross(net: number, country: string): number {\n  return net * (1 + taxRate(country))\n}\n" })
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitsquid.setSettings(p as never), AGENT)
  await page.locator(`[data-testid="commit-row"][data-hash="${apply}"]`).click()
  await page.getByTestId('commit-file').filter({ hasText: 'price.ts' }).click()
  await expect(page.getByTestId('diff-lines')).toContainText('taxRate(country)')

  await selectLine(page, 3)
  await page.getByTestId('ask-selection').click()
  const panel = page.getByTestId('ask-panel')
  await expect(panel).toContainText('src/price.ts:3')
  await expect(panel).toContainText('return net * (1 + taxRate(country))')
  await panel.getByTestId('ask-input').fill('Why add one?')
  await panel.getByTestId('ask-input').press('Control+Enter')
  await expect(panel.getByTestId('ask-answer')).toHaveText('You asked "Why add one?". The lines are in function gross; they use taxRate (src/tax.ts).')

  await panel.getByTestId('ask-input').fill('And for NZ?')
  await panel.getByTestId('ask-send').click()
  await expect(panel.getByTestId('ask-answer').last()).toContainText('Following up.')

  // The thread is pinned to the commit: its details list it, and it reopens.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('commit-questions')).toContainText('Why add one?')
  await page.getByTestId('commit-questions').getByRole('button').click()
  await expect(page.getByTestId('ask-panel').getByTestId('ask-answer')).toHaveCount(2)
  await app.close()
})
