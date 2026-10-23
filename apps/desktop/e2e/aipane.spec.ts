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
  // The selection chip stays while the selection is unchanged, now marked as already in the conversation.
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveAttribute('data-sent', 'true')
  await expect(panel.getByTestId('ai-context-hint')).toHaveText('In this conversation already')

  // A second message in the same thread does not resend it.
  await panel.getByTestId('thread-input').fill('and again?')
  await panel.getByTestId('thread-input').press('Enter')
  await expect(panel.getByTestId('thread-agent').last()).toHaveText('Turn 2. You said: and again?.')
  await expect(panel.getByTestId('thread-sent-toggle')).toHaveCount(1)
  expect(readFileSync(log, 'utf8').split('Context: commit').length - 1).toBe(1)

  // × removes it; it stays removed.
  await chip.getByTestId('ai-context-chip-remove').click()
  await expect(chip).toHaveCount(0)
  await expect(panel.getByTestId('ai-context-hint')).toContainText('Drop commits')

  // Another selection is a new chip, and it is sent.
  await page.getByTestId('commit-row').nth(2).click()
  await expect(chip).toHaveCount(1)
  await expect(chip).not.toHaveAttribute('data-sent', 'true')
  await expect(chip).toContainText('commit ')
  await expect(chip).not.toContainText(hash.slice(0, 7))
  await panel.getByTestId('thread-input').fill('and this one?')
  await panel.getByTestId('thread-input').press('Enter')
  await expect(panel.getByTestId('thread-agent').last()).toHaveText('Turn 3. You said: and this one?.')
  await expect(panel.getByTestId('thread-sent-toggle')).toHaveCount(2)
  await panel.getByTestId('thread-sent-toggle').last().click()
  await expect(panel.getByTestId('thread-sent').last()).toContainText('Context: commit')
  await expect(panel.getByTestId('thread-sent').last()).not.toContainText(hash.slice(0, 7))
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

test('the actions menu: enabled by the chips, disabled with a reason; Review starts a review thread that is in the history list at once', async () => {
  const r = repoWithTopic()
  const { app, page } = await launch(r.dir)
  await set(page, AGENT)
  await page.getByTestId('commit-row').nth(1).click()
  const panel = await openPane(page)
  // The actions are one menu in the composer's footer; it is opened for each look and closed after.
  const action = async (name: string) => {
    if (!(await page.getByTestId(`ai-action-${name}`).isVisible())) await panel.getByTestId('ai-actions').click()
    return page.getByTestId(`ai-action-${name}`)
  }
  const close = async () => {
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('ai-action-explain')).toHaveCount(0)
  }
  // One commit: everything about commits; nothing about branches.
  for (const name of ['explain', 'review', 'walkthrough', 'impact', 'recompose', 'cherrypick']) await expect(await action(name)).toBeEnabled()
  await expect(await action('rebase')).toBeDisabled()
  await expect(await action('rebase')).toHaveAttribute('aria-description', 'Drop a branch here')
  await close()
  // A branch dropped makes rebase possible. It is also what Review would take (dropped chips come
  // before the selection), so it goes again before the review.
  await dragTo(page, pill(page, 'refs/heads/topic'), panel)
  await expect(await action('rebase')).toBeEnabled()
  await close()
  await panel.locator('[data-kind="branch"]').getByTestId('ai-context-chip-remove').click()
  await expect(await action('rebase')).toBeDisabled()
  await close()

  // The root commit cannot be recomposed, and the menu says why; several commits make one chip.
  await page.getByTestId('commit-row').last().click()
  await expect(await action('recompose')).toBeDisabled()
  await expect(await action('recompose')).toHaveAttribute('aria-description', 'Recompose needs non-merge commits on the current branch')
  await close()
  await page.getByTestId('commit-row').first().click()
  await page.getByTestId('commit-row').nth(1).click({ modifiers: ['Shift'] })
  await expect(panel.getByTestId('ai-context-chip')).toHaveText(/2 commits/)
  await expect(await action('recompose')).toHaveAttribute('title', 'Recompose 2 commits')
  await expect(await action('explain')).toBeDisabled()
  await expect(await action('explain')).toHaveAttribute('aria-description', 'Select one commit, or drop one here')
  await close()
  await page.getByTestId('commit-row').nth(1).click()

  // Review of the selected commit: the review view opens, and the thread is in the history list.
  await (await action('review')).click()
  await expect(page.getByTestId('review')).toBeVisible()
  // New and History are at the right end of the slot's tab strip, not in a header of the pane.
  await page.getByTestId('slot-right').getByTestId('ai-chat-history').click()
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
  await panel.getByTestId('ai-actions').click()
  await page.getByTestId('ai-action-rebase').click()
  await expect.poll(() => r.git('log', '--format=%s', 'feature').trim().split('\n').join('|')).toBe('feature work|main moves on|root')
  await app.close()
})

test('one header and one composer box: New and History live in the tab strip, the ⋯ shows on hover, and who answers is one button', async () => {
  const r = repoWithTopic()
  const { app, page } = await launch(r.dir)
  await set(page, AGENT)
  await page.getByTestId('commit-row').nth(1).click()
  const panel = await openPane(page)
  const strip = page.getByTestId('tabs-right')

  // No header of its own: the pane's two buttons are the right end of the slot's strip while AI is in front.
  await expect(strip.getByTestId('ai-chat-new')).toBeVisible()
  await expect(strip.getByTestId('ai-chat-history')).toBeVisible()
  await expect(panel.getByTestId('ai-chat-new')).toHaveCount(0)
  await page.getByTestId('pane-tab-details').click()
  await expect(page.getByTestId('ai-chat-new')).toHaveCount(0)
  await page.getByTestId('pane-tab-ai').click()
  // The empty state is one short line, not a paragraph.
  await expect(panel.getByTestId('thread-empty')).toHaveText('Ask about this repository, or drop commits, branches and files here')

  // The composer is one box: chips, text, actions, who answers and Send are all inside it, and it is a small part of the pane.
  const box = panel.getByTestId('thread-input').locator('xpath=..')
  for (const id of ['ai-context', 'ai-actions', 'thread-send']) await expect(box.getByTestId(id)).toBeVisible()
  const target = box.locator('[data-testid^="ai-target-"]').first()
  await expect(target).toHaveText('fake-agent · default')
  expect((await box.boundingBox())!.height).toBeLessThan((await panel.boundingBox())!.height * 0.3)
  // Who answers: one quiet button; the two selects and Prompt are in its popover.
  await expect(page.getByTestId('model-picker-who')).toHaveCount(0)
  await target.click()
  await expect(page.getByTestId('model-picker-who')).toBeVisible()
  await expect(page.getByTestId('model-picker-model')).toBeVisible()
  await expect(page.locator('[data-testid^="prompt-button-"]')).toBeVisible()
  await page.keyboard.press('Escape')

  // The tab's ⋯ is there for tests and keyboards but only visible on hover, or while its menu is open.
  const menu = page.getByTestId('pane-menu-ai')
  await page.mouse.move(300, 300)
  await expect(menu).toHaveCSS('opacity', '0')
  await page.getByTestId('pane-tab-ai').hover()
  await expect(menu).toHaveCSS('opacity', '1')
  // A right-click on the tab opens the same menu.
  await page.mouse.move(300, 300)
  await page.getByTestId('pane-tab-ai').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Hide' })).toBeVisible()
  await expect(menu).toHaveCSS('opacity', '1')
  await page.keyboard.press('Escape')
  await app.close()
})
