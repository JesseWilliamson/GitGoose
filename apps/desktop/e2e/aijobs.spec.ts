import { initRepo, makeFixture, tempDir } from '@gitgoose/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

/**
 * Waiting on the AI never holds the user up, and an answer is never lost by looking elsewhere.
 * The fake agent holds its answers while the gate file is missing (FAKE_AGENT_GATE), so each
 * test can leave the place it asked from while the AI is still working.
 */

const FAKE = join(import.meta.dirname, 'fake-agent.mjs')
const AGENT_CMD = `"${process.execPath}" "${FAKE}"`
const AGENT = { aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: AGENT_CMD, aiConsent: [`agent:${AGENT_CMD}`], reviewProfile: 'assertive' }
const EXPLAINED = 'This change explains itself. (inside: allowed, outside: denied)'

const set = (page: Page, patch: Record<string, unknown>) => page.evaluate((p) => window.gitgoose.setSettings(p as never), patch)

test('why did this fail: the answer goes to the AI panel, and looking elsewhere meanwhile loses nothing', async () => {
  const r = makeFixture('with-remote')
  const bare = r.git('remote', 'get-url', 'origin').trim()
  writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "policy: pushes to main need review" >&2\nexit 1\n')
  chmodSync(join(bare, 'hooks', 'pre-receive'), 0o755)
  r.commit('local change', { 'x.txt': 'x\n' })
  const gate = join(tempDir(), 'gate')
  const { app, page } = await launch(r.dir, { FAKE_AGENT_GATE: gate })
  await set(page, AGENT)
  await page.getByTestId('toolbar').getByRole('button', { name: 'Push' }).first().click()
  await page.getByTestId('attention-explain').click()

  // No modal: the conversation opens in the AI panel while the agent works, and the status bar says so.
  const panel = page.getByTestId('ai-chat-panel')
  await expect(panel.getByTestId('thread-feature')).toContainText('Why did this fail')
  await expect(page.getByTestId('ai-jobs')).toContainText('AI: Why:')
  // Carry on meanwhile: close the panel, look at another commit.
  await panel.getByRole('button', { name: 'Close the AI panel' }).click()
  await page.getByTestId('commit-row').nth(1).click()
  await expect(page.getByTestId('commit-files')).toBeVisible()

  writeFileSync(gate, '')
  await page.getByTestId('ai-permission-deny').click()
  // It finished out of sight: kept until the user looks.
  await expect(page.getByTestId('ai-jobs')).toHaveText(/1 answer ready/)
  await page.getByTestId('ai-jobs').click()
  await page.getByTestId('ai-job-open').click()
  await expect(panel.getByTestId('thread-agent')).toHaveText(EXPLAINED)
  await expect(page.getByTestId('ai-jobs')).toHaveCount(0)

  // Later: the panel's history has it with the repository's other conversations.
  await page.getByTestId('ai-chat-new').click()
  await expect(panel.getByTestId('thread-agent')).toHaveCount(0)
  await page.getByTestId('ai-chat-history').click()
  await page.getByTestId('ai-chat-history-item').filter({ hasText: 'Why did this fail' }).click()
  await expect(panel.getByTestId('thread-agent')).toHaveText(EXPLAINED)
  await app.close()
})

test('fix with AI: closing the dialog while it works hides it; the app stays usable and the fix waits to be opened', async () => {
  const r = initRepo()
  r.commit('root', { 'src/calc.ts': 'export function total(a: number, b: number) {\n  return a + b\n}\n' })
  r.commit('docs: a readme', { 'README.md': 'Totals.\n' })
  const broken = 'export function total(a: number, b: number) {\n  return a - b\n}\n'
  r.write('src/calc.ts', broken)
  const file = () => readFileSync(join(r.dir, 'src/calc.ts'), 'utf8')
  const gate = join(tempDir(), 'gate')
  writeFileSync(gate, '')
  const { app, page } = await launch(r.dir, { FAKE_AGENT_GATE: gate })
  await set(page, AGENT)
  await page.getByTestId('review-menu').click()
  await page.getByRole('menuitem', { name: 'Review all uncommitted changes' }).click()
  await expect(page.getByTestId('finding')).toHaveCount(1)

  rmSync(gate) // the agent holds the next answer
  await page.getByTestId('finding').getByTestId('fix-with-ai').click()
  await expect(page.getByTestId('ai-fix')).toContainText('Asking for a fix')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('ai-fix')).toHaveCount(0)
  await expect(page.getByTestId('ai-jobs')).toContainText('AI: Fix: Possible bug here')
  // The app is free: back to the graph, select a commit.
  await page.getByRole('button', { name: 'Back to graph' }).click()
  await page.getByTestId('commit-row').filter({ hasText: 'docs: a readme' }).click()
  await expect(page.getByTestId('detail-panel')).toContainText('docs: a readme')

  writeFileSync(gate, '')
  await page.getByTestId('ai-permission-allow_once').click()
  // Ready while hidden: a toast offers it; nothing is written until Use.
  await page.getByTestId('toast-action').filter({ hasText: 'Open' }).click()
  await expect(page.getByTestId('ai-fix-diff')).toContainText('+   return a + b')
  expect(file()).toBe(broken)
  await page.getByTestId('ai-fix-accept').click()
  await expect.poll(file).toContain('return a + b')
  await app.close()
})

test('fix with AI: a file edited while the fix was being written is never overwritten by it', async () => {
  const r = initRepo()
  r.commit('root', { 'src/calc.ts': 'export function total(a: number, b: number) {\n  return a + b\n}\n' })
  const broken = 'export function total(a: number, b: number) {\n  return a - b\n}\n'
  r.write('src/calc.ts', broken)
  const file = () => readFileSync(join(r.dir, 'src/calc.ts'), 'utf8')
  const gate = join(tempDir(), 'gate')
  writeFileSync(gate, '')
  const { app, page } = await launch(r.dir, { FAKE_AGENT_GATE: gate })
  await set(page, AGENT)
  await page.getByTestId('review-menu').click()
  await page.getByRole('menuitem', { name: 'Review all uncommitted changes' }).click()
  await expect(page.getByTestId('finding')).toHaveCount(1)

  rmSync(gate)
  await page.getByTestId('finding').getByTestId('fix-with-ai').click()
  await page.keyboard.press('Escape')
  // The user edits the file while the AI works.
  const edited = `${broken}// checked by hand\n`
  writeFileSync(join(r.dir, 'src/calc.ts'), edited)
  writeFileSync(gate, '')
  await page.getByTestId('ai-permission-allow_once').click()
  await page.getByTestId('toast-action').filter({ hasText: 'Open' }).click()
  await expect(page.getByTestId('ai-fix-stale')).toContainText('has changed since this fix was asked for')
  await expect(page.getByTestId('ai-fix-accept')).toBeDisabled()
  expect(file()).toBe(edited)
  await page.getByTestId('ai-fix-discard').click()
  await expect(page.getByTestId('ai-jobs')).toHaveCount(0)
  await app.close()
})

test('two conflicted files: a proposal put aside is still there after asking about the other one', async () => {
  const r = initRepo()
  r.commit('base', { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'uno\ndos\ntres\n' })
  r.checkout('-b', 'other')
  r.commit('theirs', { 'a.txt': 'one\nTWO (theirs)\nthree\n', 'b.txt': 'uno\nDOS (theirs)\ntres\n' })
  r.checkout('main')
  r.commit('ours', { 'a.txt': 'one\nTwo (ours)\nthree\n', 'b.txt': 'uno\nDos (ours)\ntres\n' })
  r.tryGit('merge', 'other')
  const { app, page } = await launch(r.dir)
  await set(page, AGENT)
  await expect(page.getByTestId('conflict-file')).toHaveCount(2)
  const content = page.getByTestId('ai-proposal-content')

  await page.getByTestId('conflict-file').filter({ hasText: 'a.txt' }).click()
  await page.getByTestId('ai-resolve').click()
  await page.getByTestId('ai-permission-allow_once').click()
  await expect(content).toHaveText('one\nTwo (ours)\nTWO (theirs)\nthree\n')
  await page.keyboard.press('Escape') // put aside

  await page.getByTestId('conflict-file').filter({ hasText: 'b.txt' }).click()
  await page.getByTestId('ai-resolve').click()
  await page.getByTestId('ai-permission-allow_once').click()
  await expect(content).toHaveText('uno\nDos (ours)\nDOS (theirs)\ntres\n')
  await page.getByTestId('ai-proposal-discard').click()

  // a.txt's proposal is on the list, and opens as itself.
  await page.getByTestId('ai-jobs').click()
  await page.getByTestId('ai-job').filter({ hasText: 'Resolve a.txt' }).getByTestId('ai-job-open').click()
  await expect(content).toHaveText('one\nTwo (ours)\nTWO (theirs)\nthree\n')
  await page.getByTestId('ai-proposal-accept').click()
  await expect(page.getByTestId('conflict-file')).toHaveCount(1)
  expect(r.git('show', ':a.txt')).toBe('one\nTwo (ours)\nTWO (theirs)\nthree\n')
  await expect(page.getByTestId('ai-jobs')).toHaveCount(0)
  await app.close()
})

test('two conflict proposals arriving together: the one on screen is replaced, and kept on the list', async () => {
  const r = initRepo()
  r.commit('base', { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'uno\ndos\ntres\n' })
  r.checkout('-b', 'other')
  r.commit('theirs', { 'a.txt': 'one\nTWO (theirs)\nthree\n', 'b.txt': 'uno\nDOS (theirs)\ntres\n' })
  r.checkout('main')
  r.commit('ours', { 'a.txt': 'one\nTwo (ours)\nthree\n', 'b.txt': 'uno\nDos (ours)\ntres\n' })
  r.tryGit('merge', 'other')
  const gate = join(tempDir(), 'gate')
  const { app, page } = await launch(r.dir, { FAKE_AGENT_GATE: gate })
  await set(page, AGENT)
  await expect(page.getByTestId('conflict-file')).toHaveCount(2)
  // Ask about both files; the agent holds both answers.
  await page.getByTestId('conflict-file').filter({ hasText: 'a.txt' }).click()
  await page.getByTestId('ai-resolve').click()
  await page.getByTestId('conflict-file').filter({ hasText: 'b.txt' }).click()
  await page.getByTestId('ai-resolve').click()
  await expect(page.getByTestId('ai-jobs')).toContainText('(+1)')
  writeFileSync(gate, '')
  await page.getByTestId('ai-permission-allow_once').click()
  await page.getByTestId('ai-permission-allow_once').click()

  // Whichever came second is in the dialog; the first is waiting on the list, not gone.
  const A = 'one\nTwo (ours)\nTWO (theirs)\nthree\n'
  const B = 'uno\nDos (ours)\nDOS (theirs)\ntres\n'
  const content = page.getByTestId('ai-proposal-content')
  await expect(content).toHaveText(/TWO \(theirs\)|DOS \(theirs\)/)
  await expect(page.getByTestId('ai-jobs')).toHaveText(/1 answer ready/)
  const first = (await content.textContent()) === A ? B : A
  await page.getByTestId('ai-proposal-discard').click()
  await page.getByTestId('ai-jobs').click()
  await page.getByTestId('ai-job-open').click()
  await expect(content).toHaveText(first)
  await app.close()
})

test('stopping one commit explanation keeps every other commit\'s', async () => {
  const r = initRepo()
  const A = r.commit('feat: the widgets', { 'w.txt': 'w\n' })
  const B = r.commit('chore: a long story FAKE:slow', { 's.txt': 's\n' })
  const { app, page } = await launch(r.dir)
  await set(page, AGENT)
  const row = (hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)
  const text = page.getByTestId('ai-explanation-text')
  await row(A).click()
  await page.getByTestId('ai-explain-commit').click()
  await page.getByTestId('ai-permission-deny').click()
  await expect(text).toHaveText(EXPLAINED)
  // B's explanation streams on (the fake agent writes slowly until stopped).
  await row(B).click()
  await page.getByTestId('ai-explain-commit').click()
  await expect(text).toContainText('chunk 1')

  // Stop it from the status bar while looking at A: A's explanation stays, and so does what B had.
  await row(A).click()
  await page.getByTestId('ai-jobs').click()
  await page.getByTestId('ai-job-stop').click()
  await expect(page.getByTestId('ai-jobs')).toHaveCount(0)
  await expect(text).toHaveText(EXPLAINED)
  await row(B).click()
  await expect(text).toContainText('chunk 0')
  await app.close()
})

test('a commit keeps its explanation: after selecting another commit while it is written, and after a restart', async () => {
  const r = makeFixture('linear')
  const gate = join(tempDir(), 'gate')
  const profile = tempDir('gitgoose-profile-')
  let { app, page } = await launch(r.dir, { FAKE_AGENT_GATE: gate, GITGOOSE_USER_DATA: profile })
  await set(page, AGENT)
  const rows = page.getByTestId('commit-row')
  await rows.nth(0).click()
  await page.getByTestId('ai-explain-commit').click()
  await expect(page.getByTestId('ai-explanation-text')).toContainText('Thinking')
  await rows.nth(1).click()
  await expect(page.getByTestId('ai-explanation')).toHaveCount(0)
  await expect(page.getByTestId('ai-jobs')).toContainText('AI: Explain')

  writeFileSync(gate, '')
  await page.getByTestId('ai-permission-deny').click()
  await expect(page.getByTestId('ai-jobs')).toHaveText(/1 answer ready/)
  await rows.nth(0).click()
  await expect(page.getByTestId('ai-explanation-text')).toHaveText(EXPLAINED)
  // Seen by going there: nothing left to announce.
  await expect(page.getByTestId('ai-jobs')).toHaveCount(0)
  const followUp = page.getByTestId('explain-thread')
  await followUp.getByTestId('thread-input').fill('and the tests?')
  await followUp.getByTestId('thread-input').press('Enter')
  await expect(followUp.getByTestId('thread-agent')).toHaveText('Turn 2. You said: and the tests?.')
  await app.close()

  // The conversation is kept with the repository: a restart brings the explanation and its follow-up back.
  ;({ app, page } = await launch(r.dir, { GITGOOSE_USER_DATA: profile }))
  await page.getByTestId('commit-row').nth(0).click()
  await expect(page.getByTestId('ai-explanation-text')).toHaveText(EXPLAINED)
  await expect(page.getByTestId('explain-thread').getByTestId('thread-agent')).toHaveText('Turn 2. You said: and the tests?.')
  await app.close()
})
