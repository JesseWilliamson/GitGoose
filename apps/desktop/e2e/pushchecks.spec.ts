import { makeFixture } from '@gitsquid/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { launch } from './app'

const FAKE = join(import.meta.dirname, 'fake-agent.mjs')
const AGENT_CMD = `"${process.execPath}" "${FAKE}"`
const AGENT = { aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: AGENT_CMD, aiConsent: [`agent:${AGENT_CMD}`] }
const YAML = 'reviews:\n  pre_merge_checks:\n    custom_checks:\n      - name: No debug logging\n        mode: error\n        instructions: No console.log calls.\n'

const remoteMain = (bare: string) => execFileSync('git', ['rev-parse', 'main'], { cwd: bare, encoding: 'utf8' }).trim()

async function palette(page: Page, command: string) {
  await page.getByTestId('commit-row').first().click()
  await page.keyboard.press('Control+p')
  await page.getByTestId('palette-input').fill(command)
  await page.keyboard.press('Enter')
}

test('pre-push checks: a failing blocking check stops the push until Push anyway; your own checks run too', async () => {
  const r = makeFixture('with-remote')
  const bare = r.git('remote', 'get-url', 'origin').trim()
  r.commit('chore: review rules', { '.coderabbit.yaml': YAML })
  r.commit('feat: say hello', { 'src/log.ts': 'export function hello() {\n  console.log("hi")\n}\n' })
  const before = remoteMain(bare)
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitsquid.setSettings(p as never), AGENT)

  // Add a check of your own for this repository.
  await palette(page, 'Edit pre-push checks')
  await page.getByTestId('push-rule-add').click()
  await page.getByLabel('Check name').fill('Small commits')
  await page.getByLabel('What to check').fill('Keep commits small.')
  await page.getByTestId('push-rules-save').click()

  await page.getByTestId('toolbar').getByRole('button', { name: 'Push' }).first().click()
  const results = page.getByTestId('push-check')
  await expect(page.getByRole('heading', { name: 'A pre-push check failed' })).toBeVisible()
  await expect(results).toHaveCount(3)
  await expect(results.filter({ hasText: 'No debug logging' })).toHaveAttribute('data-verdict', 'fail')
  await expect(results.filter({ hasText: 'No debug logging' })).toContainText('src/log.ts:2')
  await expect(results.filter({ hasText: 'Small commits' })).toHaveAttribute('data-verdict', 'pass')
  await expect(results.filter({ hasText: 'No secrets in the pushed commits' })).toHaveAttribute('data-verdict', 'pass')
  await page.getByRole('button', { name: 'Cancel' }).click()
  expect(remoteMain(bare)).toBe(before)

  await page.getByTestId('toolbar').getByRole('button', { name: 'Push' }).first().click()
  await page.getByTestId('push-anyway').click()
  await expect.poll(() => remoteMain(bare)).toBe(r.git('rev-parse', 'main').trim())
  await app.close()
})

test('the secret scan stops a push without any AI; its setting turns it off', async () => {
  const r = makeFixture('with-remote')
  const bare = r.git('remote', 'get-url', 'origin').trim()
  // A .coderabbit.yaml with AI off asks nothing: its checks need the AI and are skipped.
  r.commit('chore: review rules', { '.coderabbit.yaml': YAML })
  r.commit('feat: config', { 'config.ts': `export const token = "${'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}"\n` })
  const before = remoteMain(bare)
  const { app, page } = await launch(r.dir)

  await page.getByTestId('toolbar').getByRole('button', { name: 'Push' }).first().click()
  const results = page.getByTestId('push-check')
  await expect(results).toHaveCount(1)
  await expect(results).toContainText('No secrets in the pushed commits')
  await expect(results).toContainText('GitHub token')
  await expect(results).toContainText('config.ts:1')
  await page.getByRole('button', { name: 'Cancel' }).click()
  expect(remoteMain(bare)).toBe(before)

  await page.evaluate(() => window.gitsquid.setSettings({ pushSecretCheck: false }))
  await page.getByTestId('toolbar').getByRole('button', { name: 'Push' }).first().click()
  await expect.poll(() => remoteMain(bare)).toBe(r.git('rev-parse', 'main').trim())
  await expect(results).toHaveCount(0)
  await app.close()
})
