import { fakeAnthropic, makeFixture, tempDir } from '@gitsquid/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

/** The fake agent (speaks real ACP over stdio), configured the way a user sets a custom agent. */
const FAKE = join(import.meta.dirname, 'fake-agent.mjs')
const AGENT = { aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: `"${process.execPath}" "${FAKE}"` }

const set = (page: Page, patch: Record<string, unknown>) => page.evaluate((p) => window.gitsquid.setSettings(p as never), patch)

test('writes a commit message with the agent, asking once before anything is sent', async () => {
  const r = makeFixture('linear')
  r.write('widgets.ts', 'export const widgets = new Map()\n')
  r.git('add', 'widgets.ts')
  const log = join(tempDir(), 'prompts.log')
  const { app, page } = await launch(r.dir, { FAKE_AGENT_LOG: log })
  // Off by default: no button.
  await expect(page.getByTestId('commit-box')).toBeVisible()
  await expect(page.getByTestId('ai-commit-message')).toHaveCount(0)
  await set(page, AGENT)

  await page.getByTestId('ai-commit-message').click()
  await expect(page.getByTestId('ai-consent')).toContainText('the staged diff')
  // Not agreed yet: the agent has not been started, so it has received nothing.
  expect(existsSync(log)).toBe(false)
  await page.getByTestId('ai-consent-ok').click()
  await expect(page.getByTestId('commit-summary')).toHaveValue('feat: add the widget registry')
  await expect(page.getByTestId('commit-box').locator('textarea')).toHaveValue('Registers widgets by name so plugins can add their own.')
  expect(readFileSync(log, 'utf8')).toContain('+export const widgets = new Map()')

  // Asked once: the second time goes straight through.
  await page.getByTestId('commit-summary').fill('')
  await page.getByTestId('ai-commit-message').click()
  await expect(page.getByTestId('commit-summary')).toHaveValue('feat: add the widget registry')
  await expect(page.getByTestId('ai-consent')).toHaveCount(0)
  await app.close()
})

test('explains a commit: reads inside the repository pass silently, anything else asks', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await set(page, { ...AGENT, aiConsent: [`agent:${AGENT.aiAgentCommand}`] })
  await page.getByTestId('commit-row').first().click()
  await page.getByTestId('ai-explain-commit').click()
  // The fake agent asks to read /etc/hostname, outside the repository: that needs the user.
  await expect(page.getByTestId('ai-permission')).toContainText('/etc/hostname')
  await page.getByTestId('ai-permission-deny').click()
  await expect(page.getByTestId('ai-explanation-text')).toHaveText('This change explains itself. (inside: allowed, outside: denied)')
  await app.close()
})

test('explains a failure from the attention bar', async () => {
  const r = makeFixture('with-remote')
  const bare = r.git('remote', 'get-url', 'origin').trim()
  writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "policy: pushes to main need review" >&2\nexit 1\n')
  chmodSync(join(bare, 'hooks', 'pre-receive'), 0o755)
  r.commit('local change', { 'x.txt': 'x\n' })
  const log = join(tempDir(), 'prompts.log')
  const { app, page } = await launch(r.dir, { FAKE_AGENT_LOG: log })
  await set(page, { ...AGENT, aiConsent: [`agent:${AGENT.aiAgentCommand}`] })
  await page.getByTestId('toolbar').getByRole('button', { name: 'Push' }).first().click()
  await expect(page.getByTestId('attention-row')).toHaveCount(1)
  await page.getByTestId('attention-explain').click()
  await page.getByTestId('ai-permission-deny').click()
  await expect(page.getByTestId('ai-output-text')).toContainText('This change explains itself.')
  expect(readFileSync(log, 'utf8')).toContain('policy: pushes to main need review')
  await app.close()
})

test('resolving a conflict with the agent: denied leaves the file alone; allowed is a proposal you accept', async () => {
  const r = makeFixture('conflict')
  r.tryGit('merge', 'other')
  const before = readFileSync(join(r.dir, 'story.txt'), 'utf8')
  const { app, page } = await launch(r.dir)
  await set(page, { ...AGENT, aiConsent: [`agent:${AGENT.aiAgentCommand}`] })
  await expect(page.getByTestId('conflicts')).toBeVisible()

  await page.getByTestId('ai-resolve').click()
  await expect(page.getByTestId('ai-permission')).toContainText('story.txt')
  await page.getByTestId('ai-permission-deny').click()
  await expect(page.getByTestId('ai-output-text')).toHaveText('Left the file as it was.')
  await page.getByTestId('ai-output').getByRole('button', { name: 'Close' }).click()
  expect(readFileSync(join(r.dir, 'story.txt'), 'utf8')).toBe(before)

  await page.getByTestId('ai-resolve').click()
  await page.getByTestId('ai-permission-allow_once').click()
  await expect(page.getByTestId('ai-proposal-content')).toHaveText('one\nTwo (ours)\nTWO (theirs)\nthree\n')
  // Still a proposal: the file on disk has not changed.
  expect(readFileSync(join(r.dir, 'story.txt'), 'utf8')).toBe(before)
  await page.getByTestId('ai-proposal-accept').click()
  await expect(page.getByTestId('conflict-file')).toHaveCount(0)
  expect(r.git('show', ':story.txt')).toBe('one\nTwo (ours)\nTWO (theirs)\nthree\n')
  await app.close()
})

test('an agent that needs a login asks for it, then carries on', async () => {
  const r = makeFixture('linear')
  r.write('a.txt', 'a\n')
  r.git('add', 'a.txt')
  const { app, page } = await launch(r.dir, { FAKE_AGENT_AUTH: '1' })
  await set(page, { ...AGENT, aiConsent: [`agent:${AGENT.aiAgentCommand}`] })
  await page.getByTestId('ai-commit-message').click()
  await expect(page.getByTestId('ai-login')).toContainText('Log in to Fake')
  // Terminal logins show the command to run (the agent's own command plus its arguments).
  await expect(page.getByTestId('ai-login')).toContainText('--login')
  await page.getByTestId('ai-login-fake-login').click()
  await expect(page.getByTestId('commit-summary')).toHaveValue('feat: add the widget registry')
  await app.close()
})

test('Settings → AI tests the agent; the API key mode streams from Anthropic', async () => {
  const api = await fakeAnthropic(['A small ', 'linear history.'])
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir, { GITSQUID_ANTHROPIC_BASE_URL: api.url })
  await set(page, AGENT)
  await page.getByTestId('toolbar').getByRole('button', { name: 'Settings' }).click()
  await page.getByTestId('ai-test').click()
  await expect(page.getByTestId('ai-test-result')).toContainText('Fake Agent 1.2.3 answered')

  await set(page, { aiProvider: 'anthropic' })
  await page.getByTestId('ai-api-key').fill('sk-ant-e2e')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('ai-panel')).toContainText('An Anthropic API key is saved.')
  await page.getByTestId('settings-close').click()
  await page.getByTestId('commit-row').first().click()
  await page.getByTestId('ai-explain-commit').click()
  await expect(page.getByTestId('ai-consent')).toContainText('Anthropic')
  await page.getByTestId('ai-consent-ok').click()
  await expect(page.getByTestId('ai-explanation-text')).toHaveText('A small linear history.')
  expect(api.requests[0]!.headers['x-api-key']).toBe('sk-ant-e2e')
  // Conflict help needs an agent, so the button is not offered in API key mode.
  await expect(page.getByTestId('ai-resolve')).toHaveCount(0)
  await app.close()
  await api.close()
})
