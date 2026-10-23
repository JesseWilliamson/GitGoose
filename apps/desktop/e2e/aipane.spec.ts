import { initRepo, tempDir } from '@gitgoose/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dragTo, launch } from './app'

/**
 * The AI panel's context (docs/specs/006-ai-over-acp.md, "Context chips"): the selection is a
 * chip, drops add chips, main renders them into the message, the action row starts the same
 * features the menus do and their threads are in the history list at once.
 */
const FAKE = join(import.meta.dirname, 'fake-agent.mjs')
const AGENT_CMD = `"${process.execPath}" "${FAKE}"`
const AGENT = { aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: AGENT_CMD, aiConsent: [`agent:${AGENT_CMD}`] }

const set = (page: Page, patch: Record<string, unknown>) => page.evaluate((p) => window.gitgoose.setSettings(p as never), patch)
const pill = (page: Page, name: string) => page.locator(`[data-testid="ref-pill"][data-ref="${name}"]`)

function repoWithTopic() {
  const r = initRepo()
  r.commit('root', { 'src/calc.ts': 'export const one = 1\n' })
  r.commit('Add the second constant', { 'src/calc.ts': 'export const one = 1\nexport const two = 2\n' })
  r.commit('Add the third constant', { 'src/calc.ts': 'export const one = 1\nexport const two = 2\nexport const three = 3\n' })
  r.git('branch', 'topic', 'HEAD~2')
  return r
}

async function openPane(page: Page) {
  await expect(page.getByTestId('commit-row').first()).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+A')
  const panel = page.getByTestId('ai-chat-panel')
  await expect(panel).toBeVisible()
  return panel
}

test('the selection is a chip that goes with the message; × removes it until the selection changes', async () => {
  const log = join(tempDir(), 'prompts.log')
  const r = repoWithTopic()
  const { app, page } = await launch(r.dir, { FAKE_AGENT_LOG: log })
  await set(page, AGENT)
  const hash = r.git('rev-parse', 'HEAD~1').trim()
  // The second row is "Add the second constant".
  await page.getByTestId('commit-row').nth(1).click()
  const panel = await openPane(page)
  const chip = panel.getByTestId('ai-context-chip')
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText(`commit ${hash.slice(0, 7)} Add the second constant`)
  await expect(chip).toHaveAttribute('data-kind', 'commit')
  await expect(panel.getByTestId('ai-context-hint')).toHaveText('Sent with your next message')

  await panel.getByTestId('thread-input').fill('what is this')
  await panel.getByTestId('thread-input').press('Enter')
  await expect(panel.getByTestId('thread-agent').last()).toHaveText('Turn 1. You said: what is this.')
  // The turn shows only the words; Sent has what went out, rendered by main.
  await expect(panel.getByTestId('thread-user').last()).toContainText('what is this')
  await panel.getByTestId('thread-sent-toggle').click()
  await expect(panel.getByTestId('thread-sent')).toContainText(`Context: commit ${hash.slice(0, 7)} Add the second constant`)
  await expect(panel.getByTestId('thread-sent')).toContainText('+export const two = 2')
  // The agent really received it, in front of the question.
  const received = readFileSync(log, 'utf8')
  expect(received).toContain(`Context: commit ${hash.slice(0, 7)}`)
  expect(received.indexOf('Context: commit')).toBeLessThan(received.lastIndexOf('what is this'))
  // The selection chip stays while the selection is unchanged.
  await expect(chip).toHaveCount(1)

  // × removes it; it stays removed, and the next message carries nothing.
  await chip.getByTestId('ai-context-chip-remove').click()
  await expect(chip).toHaveCount(0)
  await expect(panel.getByTestId('ai-context-hint')).toContainText('Drop commits')
  await panel.getByTestId('thread-input').fill('and without it?')
  await panel.getByTestId('thread-input').press('Enter')
  await expect(panel.getByTestId('thread-agent').last()).toHaveText('Turn 2. You said: and without it?.')
  await expect(panel.getByTestId('thread-sent-toggle')).toHaveCount(1)

  // A new selection is a new chip.
  await page.getByTestId('commit-row').nth(2).click()
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText('commit ')
  await expect(chip).not.toContainText(hash.slice(0, 7))
  await app.close()
})

test('drop a branch on the pane: a chip; the same twice is one; it is used up by the next message, the selection stays', async () => {
  const log = join(tempDir(), 'prompts.log')
  const r = repoWithTopic()
  const { app, page } = await launch(r.dir, { FAKE_AGENT_LOG: log })
  await set(page, AGENT)
  const panel = await openPane(page)
  await expect(panel.getByTestId('ai-context-chip')).toHaveCount(1)
  await dragTo(page, pill(page, 'refs/heads/topic'), panel)
  const branch = panel.locator('[data-testid="ai-context-chip"][data-kind="branch"]')
  await expect(branch).toHaveText(/branch topic/)
  await dragTo(page, pill(page, 'refs/heads/topic'), panel)
  await expect(branch).toHaveCount(1)
  // Nothing changed in the repository.
  expect(r.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')

  await panel.getByTestId('thread-input').fill('compare')
  await panel.getByTestId('thread-input').press('Enter')
  await expect(panel.getByTestId('thread-agent').last()).toHaveText('Turn 1. You said: compare.')
  expect(readFileSync(log, 'utf8')).toContain('Context: branch topic')
  await expect(branch).toHaveCount(0)
  await expect(panel.getByTestId('ai-context-chip')).toHaveCount(1)
  await app.close()
})

test('the action row: enabled by the chips, disabled with a reason; Review starts a review thread that is in the history list at once', async () => {
  const r = repoWithTopic()
  const { app, page } = await launch(r.dir)
  await set(page, AGENT)
  await page.getByTestId('commit-row').nth(1).click()
  const panel = await openPane(page)
  const action = (name: string) => panel.getByTestId(`ai-action-${name}`)
  // One commit: everything about commits; nothing about branches.
  for (const name of ['explain', 'review', 'walkthrough', 'impact', 'recompose', 'cherrypick']) await expect(action(name)).toBeEnabled()
  await expect(action('rebase')).toBeDisabled()
  await expect(action('rebase')).toHaveAttribute('title', 'Drop a branch here')
  // A branch dropped makes rebase possible. It is also what Review would take (dropped chips come
  // before the selection), so it goes again before the review.
  await dragTo(page, pill(page, 'refs/heads/topic'), panel)
  await expect(action('rebase')).toBeEnabled()
  await panel.locator('[data-kind="branch"]').getByTestId('ai-context-chip-remove').click()
  await expect(action('rebase')).toBeDisabled()

  // The root commit cannot be recomposed, and the button says why; several commits make one chip.
  await page.getByTestId('commit-row').last().click()
  await expect(action('recompose')).toBeDisabled()
  await expect(action('recompose')).toHaveAttribute('title', 'Recompose needs non-merge commits on the current branch')
  await page.getByTestId('commit-row').first().click()
  await page.getByTestId('commit-row').nth(1).click({ modifiers: ['Shift'] })
  await expect(panel.getByTestId('ai-context-chip')).toHaveText(/2 commits/)
  await expect(action('recompose')).toHaveAttribute('title', 'Recompose 2 commits')
  await expect(action('explain')).toBeDisabled()
  await expect(action('explain')).toHaveAttribute('title', 'Select one commit, or drop one here')
  await page.getByTestId('commit-row').nth(1).click()

  // Review of the selected commit: the review view opens, and the thread is in the history list.
  await action('review').click()
  await expect(page.getByTestId('review')).toBeVisible()
  await panel.getByTestId('ai-chat-history').click()
  const item = page.locator('[data-testid="ai-chat-history-item"][data-kind="review"]')
  await expect(item).toHaveCount(1)
  await expect(page.getByTestId('ai-chat-history-day').first()).toContainText('Today')
  await page.keyboard.press('Escape')
  await app.close()
})

test('Rebase onto… from the pane rebases the current branch onto the dropped branch', async () => {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'a\n' })
  r.git('checkout', '-q', '-b', 'feature')
  r.commit('feature work', { 'f.txt': 'f\n' })
  r.git('checkout', '-q', 'main')
  r.commit('main moves on', { 'm.txt': 'm\n' })
  r.git('checkout', '-q', 'feature')
  const { app, page } = await launch(r.dir)
  await set(page, AGENT)
  const panel = await openPane(page)
  await dragTo(page, pill(page, 'refs/heads/main'), panel)
  await panel.getByTestId('ai-action-rebase').click()
  await expect.poll(() => r.git('log', '--format=%s', 'feature').trim().split('\n').join('|')).toBe('feature work|main moves on|root')
  await app.close()
})
