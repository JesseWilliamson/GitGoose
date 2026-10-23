import { fakeAnthropic, makeFixture, tempDir } from '@gitgoose/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hideAiPane, launch } from './app'

/** The fake agent (speaks real ACP over stdio), configured the way a user sets a custom agent. */
const FAKE = join(import.meta.dirname, 'fake-agent.mjs')
const AGENT = { aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: `"${process.execPath}" "${FAKE}"` }

const set = (page: Page, patch: Record<string, unknown>) => page.evaluate((p) => window.gitgoose.setSettings(p as never), patch)

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
  // Not a modal: a conversation in the AI panel (see aijobs.spec.ts for leaving it meanwhile).
  await expect(page.getByTestId('ai-chat-panel').getByTestId('thread-agent')).toContainText('This change explains itself.')
  await expect(page.getByTestId('ai-output')).toHaveCount(0)
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
  // No proposal: the agent's note is a conversation in the AI panel, kept with the repository.
  const panel = page.getByTestId('ai-chat-panel')
  await expect(panel.getByTestId('thread-feature')).toHaveText('Resolve the conflict in story.txt')
  await expect(panel.getByTestId('thread-agent')).toHaveText('Left the file as it was.')
  await hideAiPane(page)
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
  const { app, page } = await launch(r.dir, { GITGOOSE_ANTHROPIC_BASE_URL: api.url })
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

test("the commit box shows its prompt; an edit there is what is sent, and Settings' words come back on Reset", async () => {
  const r = makeFixture('linear')
  r.write('widgets.ts', 'export const widgets = new Map()\n')
  r.git('add', 'widgets.ts')
  const log = join(tempDir(), 'prompts.log')
  const { app, page } = await launch(r.dir, { FAKE_AGENT_LOG: log })
  await set(page, { ...AGENT, aiConsent: [`agent:${AGENT.aiAgentCommand}`] })

  await page.getByTestId('prompt-button-commit').click()
  const panel = page.getByTestId('prompt-panel-commit')
  await expect(panel.getByTestId('prompt-source')).toHaveText('Built-in')
  // Only the editable words are shown: not the fixed answer format, not the context.
  await expect(panel.getByTestId('prompt-system')).toBeVisible()
  await expect(panel.getByTestId('prompt-instructions')).toBeVisible()
  await expect(panel).not.toContainText('Reply with the commit message only')
  await expect(panel.getByTestId('prompt-format')).toHaveCount(0)
  await expect(panel.getByTestId('prompt-context')).toHaveCount(0)
  expect(existsSync(log)).toBe(false)

  // The fake writes "commit message for" requests, so the edit keeps those words.
  await panel.getByTestId('prompt-instructions').fill('Write a commit message for this. PANEL-EDIT')
  await expect(panel.getByTestId('prompt-source')).toHaveText('Edited here: used by this area only')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('prompt-button-commit')).toHaveText('Prompt (edited)')

  await page.getByTestId('ai-commit-message').click()
  await expect(page.getByTestId('commit-summary')).toHaveValue('feat: add the widget registry')
  const sent = readFileSync(log, 'utf8')
  expect(sent).toContain('Write a commit message for this. PANEL-EDIT\nReply with the commit message only')
  expect(sent).not.toContain('imperative mood')

  // Settings → AI lists every prompt and says the area has its own edit.
  const s = await page.evaluate(() => window.gitgoose.getSettings())
  expect(s.aiPromptEdits['commit-message']?.instructions).toBe('Write a commit message for this. PANEL-EDIT')
  await page.getByTestId('prompt-button-commit').click()
  await page.getByTestId('prompt-panel-commit').getByTestId('prompt-reset').click()
  await expect(page.getByTestId('prompt-panel-commit').getByTestId('prompt-source')).toHaveText('Built-in')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('prompt-button-commit')).toHaveText('Prompt')
  await app.close()
})

test("a blank part in the area's prompt falls back to Settings' words, as the request sends them", async () => {
  const r = makeFixture('linear')
  r.write('widgets.ts', 'export const widgets = new Map()\n')
  r.git('add', 'widgets.ts')
  const log = join(tempDir(), 'prompts.log')
  const { app, page } = await launch(r.dir, { FAKE_AGENT_LOG: log })
  // The fake writes "commit message for" requests, so Settings' words keep those words.
  const words = 'Write a commit message for this. SETTINGS-WORDS'
  await set(page, {
    ...AGENT, aiConsent: [`agent:${AGENT.aiAgentCommand}`],
    aiPrompts: { 'commit-message': { system: 'You write git commit messages.', instructions: words } },
  })

  await page.getByTestId('prompt-button-commit').click()
  const panel = page.getByTestId('prompt-panel-commit')
  await expect(panel.getByTestId('prompt-source')).toHaveText('From Settings → AI')
  // Blank instructions fall back to Settings' words, not the built-in ones.
  await panel.getByTestId('prompt-instructions').fill('')
  await expect(panel.getByTestId('prompt-rendered')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.getByTestId('ai-commit-message').click()
  await expect(page.getByTestId('commit-summary')).toHaveValue('feat: add the widget registry')
  const sent = readFileSync(log, 'utf8')
  expect(sent).toContain(`${words}\nReply with the commit message only`)
  expect(sent).not.toContain('imperative mood')
  await app.close()
})

test('in a chat, each message can show exactly what was sent', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await set(page, { ...AGENT, aiConsent: [`agent:${AGENT.aiAgentCommand}`] })
  // The shortcut acts on the open repository: wait until it is on screen.
  await expect(page.getByTestId('commit-row').first()).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+A')
  const panel = page.getByTestId('ai-chat-panel')
  await panel.getByTestId('thread-input').fill('hello')
  await panel.getByTestId('thread-input').press('Enter')
  await expect(panel.getByTestId('thread-agent').first()).toHaveAttribute('data-status', 'done')
  await panel.getByTestId('thread-sent-toggle').click()
  await expect(panel.getByTestId('thread-sent')).toContainText('You are helping someone with their git repository')
  await expect(panel.getByTestId('thread-sent')).toContainText('HEAD: main at')
  await app.close()
})

test("the API's model list is asked for once, and reopening Settings does not ask again", async () => {
  const api = await fakeAnthropic()
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir, { GITGOOSE_ANTHROPIC_BASE_URL: api.url })
  await set(page, { aiProvider: 'anthropic' })
  await page.getByTestId('toolbar').getByRole('button', { name: 'Settings' }).click()
  await page.getByTestId('ai-api-key').fill('sk-ant-e2e')
  await page.getByRole('button', { name: 'Save' }).click()
  const model = page.getByTestId('ai-panel').getByTestId('model-picker-model')
  // Nothing is known, so nothing was asked: the setting's model id and the offer to load.
  await expect(model.locator('option')).toHaveText(['claude-opus-5-5', 'Load models…'])
  expect(api.modelRequests).toBe(0)
  await model.selectOption({ label: 'Load models…' })
  await expect(model.locator('option')).toHaveText(['Claude Opus 5.5', 'Claude Haiku 5.5', 'Refresh models…'])
  expect(api.modelRequests).toBe(1)
  // Main kept the list with the time it was fetched; the picker reads it from there.
  expect((await page.evaluate(() => window.gitgoose.getSettings())).aiApiModels?.models).toHaveLength(2)
  await page.getByTestId('settings-close').click()
  await page.getByTestId('toolbar').getByRole('button', { name: 'Settings' }).click()
  await expect(model.locator('option')).toHaveText(['Claude Opus 5.5', 'Claude Haiku 5.5', 'Refresh models…'])
  expect(api.modelRequests).toBe(1)
  await app.close()
  await api.close()
})

test("an agent's model list survives a restart: the picker offers Refresh, not Load models…", async () => {
  const r = makeFixture('linear')
  const profile = tempDir('gitgoose-profile-')
  const env = { GITGOOSE_USER_DATA: profile, FAKE_AGENT_MODELS: '1' }
  let { app, page } = await launch(r.dir, env)
  await set(page, AGENT)
  await page.getByTestId('toolbar').getByRole('button', { name: 'Settings' }).click()
  let model = page.getByTestId('ai-panel').getByTestId('model-picker-model')
  await expect(model.locator('option')).toHaveText(['Default model', 'Load models…'])
  await model.selectOption({ label: 'Load models…' })
  await expect(model.locator('option')).toHaveText(['Default (Fake Smart)', 'Fake Fast', 'Fake Smart', 'Refresh models…'])
  await app.close()

  ;({ app, page } = await launch(r.dir, env))
  await page.getByTestId('toolbar').getByRole('button', { name: 'Settings' }).click()
  model = page.getByTestId('ai-panel').getByTestId('model-picker-model')
  await expect(model.locator('option')).toHaveText(['Default (Fake Smart)', 'Fake Fast', 'Fake Smart', 'Refresh models…'])
  await app.close()
})
