import { fakeAnthropic, initRepo, makeFixture, tempDir } from '@gitgoose/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { launch } from './app'

/**
 * Conversations with the agent (spec 006, threads): the fake agent keeps each session's history
 * and answers "Turn N", so continuity is visible; FAKE:… words in a message script the rest.
 */
const FAKE = join(import.meta.dirname, 'fake-agent.mjs')
const AGENT_CMD = `"${process.execPath}" "${FAKE}"`
const AGENT = { aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: AGENT_CMD, aiConsent: [`agent:${AGENT_CMD}`] }

const set = (page: Page, patch: Record<string, unknown>) => page.evaluate((p) => window.gitgoose.setSettings(p as never), patch)

/** Open the AI panel with its shortcut and send a message. */
async function chat(page: Page, text: string) {
  const panel = page.getByTestId('ai-chat-panel')
  if (!(await panel.isVisible())) {
    // The shortcut acts on the open repository: wait until it is on screen.
    await expect(page.getByTestId('commit-row').first()).toBeVisible()
    await page.keyboard.press('ControlOrMeta+Shift+A')
  }
  await panel.getByTestId('thread-input').fill(text)
  await panel.getByTestId('thread-input').press('Enter')
  return panel
}

const lastReply = (scope: ReturnType<Page['getByTestId']>) => scope.getByTestId('thread-agent').last()

test('the AI panel: follow-ups continue the conversation; Shift+Enter is a new line; it survives closing and reopening', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await set(page, { aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: AGENT_CMD })
  const panel = await chat(page, 'hello')
  // First use asks before anything is sent, naming what goes along.
  await expect(page.getByTestId('ai-consent')).toContainText("the repository's name and current commit")
  await page.getByTestId('ai-consent-ok').click()
  await expect(lastReply(panel)).toHaveText('Turn 1. You said: hello.')
  await panel.getByTestId('thread-input').fill('line one')
  await panel.getByTestId('thread-input').press('Shift+Enter')
  await panel.getByTestId('thread-input').pressSequentially('line two')
  await expect(panel.getByTestId('thread-input')).toHaveValue('line one\nline two')
  await panel.getByTestId('thread-input').press('Enter')
  await expect(lastReply(panel)).toHaveText('Turn 2. You said: line two.')
  await expect(panel.getByTestId('thread-user')).toHaveText(['hello', 'line one\nline two'])

  // Closed and opened again: the same conversation, and the same session goes on.
  await page.keyboard.press('ControlOrMeta+Shift+A')
  await expect(panel).toHaveCount(0)
  await chat(page, 'still there?')
  await expect(lastReply(panel)).toHaveText('Turn 3. You said: still there?.')
  // A new conversation starts from nothing.
  await panel.getByTestId('ai-chat-new').click()
  await chat(page, 'fresh')
  await expect(lastReply(panel)).toHaveText('Turn 1. You said: fresh.')
  await app.close()
})

test('tool calls, thoughts and plans show inline; a permission card shows the command and "Allow for this session" sticks', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await set(page, AGENT)
  const panel = await chat(page, 'FAKE:tools')
  await expect(lastReply(panel)).toContainText('Turn 1. Edited README.md.')
  const card = panel.getByTestId('tool-card')
  await expect(card).toHaveAttribute('data-status', 'completed')
  await expect(card.getByTestId('tool-title')).toHaveText('Edit README.md')
  await expect(card.getByTestId('tool-diff')).toContainText('-old line')
  await expect(card.getByTestId('tool-diff')).toContainText('+new line')
  await expect(card.getByTestId('tool-input')).toContainText('"line": 1')
  await expect(panel.getByTestId('thread-plan')).toContainText('Add a line')
  await expect(panel.getByTestId('thread-meta')).toHaveText('Commands: /compact')
  // Thoughts are folded until asked for.
  const thought = panel.getByTestId('thread-thought')
  await expect(thought).not.toContainText('The README needs a line.')
  await thought.getByRole('button').click()
  await expect(thought).toContainText('The README needs a line.')

  await chat(page, 'FAKE:permission')
  const ask = panel.getByTestId('thread-permission')
  await expect(ask).toHaveCount(1)
  await expect(ask).toHaveAttribute('data-has-raw-input', 'true')
  await expect(ask.getByTestId('permission-input')).toContainText('npm test')
  // Not the modal: in a thread the question is a card in the conversation.
  await expect(page.getByTestId('ai-permission')).toHaveCount(0)
  await ask.getByTestId('thread-permission-session').click()
  // The agent asks the same thing twice; the second is answered by GitGoose, no second card.
  await expect(lastReply(panel)).toHaveText(/First: allowed, second: allowed\./)
  await expect(ask).toHaveCount(1)
  await expect(ask.getByTestId('permission-answer')).toHaveText('Allowed for this session')

  await chat(page, 'FAKE:permission once more')
  await expect(panel.getByTestId('thread-permission')).toHaveCount(1)
  await expect(lastReply(panel)).toHaveText(/Turn 3\. First: allowed, second: allowed\./)
  await app.close()
})

test('stop mid-turn; then try again; a crash mid-thread restarts the agent and replays the conversation', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await set(page, AGENT)
  const panel = await chat(page, 'one')
  await expect(lastReply(panel)).toHaveText('Turn 1. You said: one.')

  await chat(page, 'FAKE:slow')
  await expect(lastReply(panel)).toContainText('chunk 2')
  await panel.getByTestId('thread-stop').click()
  await expect(panel.getByTestId('thread-stopped')).toBeVisible()
  await expect(panel.getByTestId('thread-retry')).toBeVisible()

  await chat(page, 'FAKE:crash')
  await expect(panel.getByTestId('thread-error')).toContainText('The agent stopped')
  await chat(page, 'two')
  // A new agent, a new session told the conversation so far: the stopped and crashed turns
  // are not in it (one answered exchange), and the reply counts on from there.
  await expect(lastReply(panel)).toHaveText('Turn 2. You said: two. (replayed 1 earlier turns)')
  await app.close()
})

test('an agent that can load sessions picks the conversation up after a crash, without a replay', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir, { FAKE_AGENT_LOAD: '1', FAKE_AGENT_STATE: join(tempDir(), 'agent-state.json') })
  await set(page, AGENT)
  const panel = await chat(page, 'one')
  await expect(lastReply(panel)).toHaveText('Turn 1. You said: one.')
  await chat(page, 'FAKE:crash')
  await expect(panel.getByTestId('thread-error')).toContainText('The agent stopped')
  await chat(page, 'two')
  await expect(lastReply(panel)).toHaveText('Turn 2. You said: two.')
  await app.close()
})

test('explain grows a follow-up: the same session, so the agent knows the commit', async () => {
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir)
  await set(page, AGENT)
  await page.getByTestId('commit-row').first().click()
  await page.getByTestId('ai-explain-commit').click()
  // The first answer is the feature's: its tool question is the modal, as before.
  await page.getByTestId('ai-permission-deny').click()
  await expect(page.getByTestId('ai-explanation-text')).toHaveText('This change explains itself. (inside: allowed, outside: denied)')
  const thread = page.getByTestId('explain-thread')
  await thread.getByTestId('thread-input').fill('Why that way?')
  await thread.getByTestId('thread-send').click()
  await expect(lastReply(thread)).toHaveText('Turn 2. You said: Why that way?.')
  await app.close()
})

test('review chat: revised findings are checked against the change; Apply adds them marked "from chat"', async () => {
  const r = initRepo()
  r.commit('root', { 'src/calc.ts': 'export function total(a: number, b: number) {\n  return a + b\n}\n' })
  r.write('src/calc.ts', 'export function total(a: number, b: number) {\n  return a - b\n}\n')
  const { app, page } = await launch(r.dir)
  await set(page, { ...AGENT, reviewProfile: 'assertive' })
  await page.getByTestId('review-menu').click()
  await page.getByRole('menuitem', { name: 'Review all uncommitted changes' }).click()
  const review = page.getByTestId('review')
  await expect(review.getByTestId('finding')).toHaveCount(1)

  await review.getByTestId('review-chat-toggle').click()
  const rail = page.getByTestId('review-chat')
  // The review itself is the first exchange, shown as one line.
  await expect(rail.getByTestId('thread-feature')).toContainText('Review: Uncommitted changes')
  await rail.getByTestId('thread-input').fill('Anything about docs? FAKE:findings')
  await rail.getByTestId('thread-input').press('Enter')
  const card = rail.getByTestId('thread-artifact')
  await expect(card).toHaveAttribute('data-state', 'ready')
  // The same verification as the review: the invented file is thrown out.
  await expect(card.getByTestId('artifact-summary')).toContainText('1 finding checked against the change, 1 thrown out (Invented in chat)')
  await card.getByTestId('artifact-apply').click()
  await expect(review.getByTestId('finding')).toHaveCount(2)
  await expect(review.getByTestId('finding').filter({ hasText: 'Found in chat' }).getByTestId('finding-from-chat')).toBeVisible()
  await expect(card).toHaveAttribute('data-state', 'applied')
  // Undo in the toast takes it back out.
  await page.getByRole('button', { name: 'Undo' }).last().click()
  await expect(review.getByTestId('finding')).toHaveCount(1)
  await app.close()
})

test('recompose chat: a revised plan replaces the editor plan as one undo step', async () => {
  const r = initRepo()
  r.commit('base', { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  const C1 = r.commit('wip stuff', { 'a.txt': 'a changed\n', 'notes.md': '# notes\n' })
  const C2 = r.commit('more wip', { 'b.txt': 'b changed\n' })
  const row = (hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)
  const { app, page } = await launch(r.dir)
  await set(page, AGENT)
  await row(C2).click()
  await row(C1).click({ modifiers: ['Shift'] })
  await row(C1).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Recompose with AI…' }).click()
  // In plan order (oldest first); the list draws them newest at the top.
  const title = (i: number) => page.locator(`[data-testid="recompose-commit"][data-index="${i}"] [data-testid="recompose-title"]`)
  await expect(title(1)).toHaveText('feat: everything else')

  await page.getByTestId('recompose-chat-toggle').click()
  const chatCol = page.getByTestId('recompose-chat')
  await chatCol.getByTestId('thread-input').fill('Put the first piece last. FAKE:plan')
  await chatCol.getByTestId('thread-input').press('Enter')
  const card = chatCol.getByTestId('thread-artifact')
  await expect(card.getByTestId('artifact-summary')).toContainText('2 commits')
  await card.getByTestId('artifact-apply').click()
  await expect(title(0)).toHaveText('feat: everything else first')
  await expect(title(1)).toHaveText('test: the first piece on its own')
  // One step: Undo goes back to the plan as it was before Apply.
  await page.getByTestId('recompose-undo').click()
  await expect(title(1)).toHaveText('feat: everything else')
  await app.close()
})

test('a commit message from the chat replaces the draft, and Undo puts the old one back', async () => {
  const r = makeFixture('linear')
  r.write('README.md', 'widgets\n')
  r.git('add', 'README.md')
  const { app, page } = await launch(r.dir)
  await set(page, AGENT)
  await page.getByTestId('commit-summary').fill('wip')
  const panel = await chat(page, 'Write me a message. FAKE:message')
  const card = panel.getByTestId('thread-artifact')
  await expect(card.getByTestId('artifact-summary')).toHaveText('docs: say what the widgets are for\n\nThe README did not say.')
  await card.getByTestId('artifact-apply').click()
  await expect(page.getByTestId('commit-summary')).toHaveValue('docs: say what the widgets are for')
  await expect(page.getByTestId('commit-box').locator('textarea')).toHaveValue('The README did not say.')
  await page.getByRole('button', { name: 'Undo' }).last().click()
  await expect(page.getByTestId('commit-summary')).toHaveValue('wip')
  await app.close()
})

test('the API key mode chats too: each turn sends the whole conversation', async () => {
  const api = await fakeAnthropic(['Sure: ', 'it is a small repository.'])
  const r = makeFixture('linear')
  const { app, page } = await launch(r.dir, { GITGOOSE_ANTHROPIC_BASE_URL: api.url })
  await set(page, { aiProvider: 'anthropic', aiConsent: ['anthropic'] })
  await page.evaluate(() => window.gitgoose.aiSetApiKey('sk-ant-e2e'))
  const panel = await chat(page, 'What is this?')
  await expect(lastReply(panel)).toHaveText('Sure: it is a small repository.')
  await chat(page, 'And?')
  await expect(panel.getByTestId('thread-agent')).toHaveCount(2)
  await expect.poll(() => api.requests.length).toBe(2)
  expect(api.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  expect(api.requests[1]!.messages[2]!.content).toBe('And?')
  // No tools in this mode, so no tool cards.
  await expect(panel.getByTestId('tool-card')).toHaveCount(0)
  await app.close()
  await api.close()
})
