import { initRepo, tempDir } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

const FAKE = join(import.meta.dirname, 'fake-agent.mjs')
const AGENT_CMD = `"${process.execPath}" "${FAKE}"`
const AGENT = { aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: AGENT_CMD, aiConsent: [`agent:${AGENT_CMD}`], reviewProfile: 'assertive' }

test('AI review: verified findings in the review view and the diff gutter; invented ones are thrown out', async () => {
  const r = initRepo()
  r.commit('root', { 'src/calc.ts': 'export function total(a: number, b: number) {\n  return a + b\n}\n' })
  r.write('src/calc.ts', 'export function total(a: number, b: number) {\n  return a - b\n}\n')
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitgoose.setSettings(p as never), AGENT)

  await page.getByTestId('review-menu').click()
  await page.getByRole('menuitem', { name: 'Review all uncommitted changes' }).click()
  const review = page.getByTestId('review')
  await expect(review.getByTestId('finding')).toHaveCount(1)
  const finding = review.getByTestId('finding')
  await expect(finding).toContainText('Possible bug here')
  await expect(finding).toContainText('lines 2')
  await expect(finding.getByTestId('suggestion')).toContainText('-   return a - b')
  await expect(finding.getByTestId('suggestion')).toContainText('+   return a + b')
  await expect(review.getByTestId('review-summary')).toHaveText('Adds a small change; one thing to fix.')
  await review.getByTestId('dropped-toggle').click()
  await expect(review.getByTestId('dropped')).toContainText('Hallucinated: invented/file.ts is not in this change')

  // Show in diff: the marker sits on line 2; clicking it comes back to the finding.
  await finding.getByRole('button', { name: 'Show in diff' }).click()
  await expect(page.getByTestId('finding-marker')).toHaveCount(1)
  await page.getByTestId('finding-marker').click()
  await expect(review).toBeVisible()

  await finding.getByRole('button', { name: 'Dismiss' }).click()
  await expect(review.getByTestId('finding')).toHaveCount(0)
  await app.close()
})

async function reviewed(page: import('@playwright/test').Page) {
  await page.getByTestId('review-menu').click()
  await page.getByRole('menuitem', { name: 'Review all uncommitted changes' }).click()
  await expect(page.getByTestId('finding')).toHaveCount(1)
  return page.getByTestId('finding')
}

test('apply a suggestion (undoable); fix with AI shows the change before writing anything', async () => {
  const r = initRepo()
  r.commit('root', { 'src/calc.ts': 'export function total(a: number, b: number) {\n  return a + b\n}\n' })
  const broken = 'export function total(a: number, b: number) {\n  return a - b\n}\n'
  r.write('src/calc.ts', broken)
  const file = () => readFileSync(join(r.dir, 'src/calc.ts'), 'utf8')
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitgoose.setSettings(p as never), AGENT)

  let finding = await reviewed(page)
  await finding.getByTestId('apply-suggestion').click()
  await expect.poll(file).toContain('return a + b')
  await expect(page.getByTestId('finding')).toHaveCount(0)
  await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).last().click()
  await expect.poll(file).toBe(broken)

  // Fix with AI: the agent asks to edit; its version is shown as a diff; Use writes it.
  finding = await reviewed(page)
  await finding.getByTestId('fix-with-ai').click()
  await page.getByTestId('ai-permission-allow_once').click()
  const diff = page.getByTestId('ai-fix-diff')
  await expect(diff).toContainText('-   return a - b')
  await expect(diff).toContainText('+   return a + b')
  expect(file()).toBe(broken) // nothing written yet
  await page.getByTestId('ai-fix-accept').click()
  await expect.poll(file).toContain('return a + b')
  await app.close()
})

test('the review follows the project: guideline files shown; a remembered dismissal stops the finding next time', async () => {
  const r = initRepo()
  r.commit('root', { 'src/calc.ts': 'export function total(a: number, b: number) {\n  return a + b\n}\n', 'CLAUDE.md': 'Prefer small functions.\n' })
  r.write('src/calc.ts', 'export function total(a: number, b: number) {\n  return a - b\n}\n')
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitgoose.setSettings(p as never), AGENT)
  const finding = await reviewed(page)
  await expect(page.getByTestId('review-context')).toContainText('Followed CLAUDE.md')
  await expect(page.getByTestId('review-context')).toContainText('0 learnings')

  await finding.getByTestId('remember-dismissal').click()
  await expect(page.getByTestId('dialog-input')).toHaveValue('Do not flag "Possible bug here"')
  await page.getByTestId('dialog-submit').click()
  await expect(page.getByTestId('finding')).toHaveCount(0)

  await page.getByTestId('review').getByRole('button', { name: 'Review again' }).click()
  await expect(page.getByTestId('review-summary')).toHaveText("Fine by the team's rules.")
  await expect(page.getByTestId('review-context')).toContainText('1 learning')
  await page.getByRole('button', { name: 'Manage learnings' }).click()
  await expect(page.getByTestId('learnings')).toContainText('Do not flag "Possible bug here"')
  await page.getByTestId('learnings').getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByTestId('learnings')).not.toContainText('possible bug')
  await app.close()
})

test('review again: unchanged findings stay open, changed code counts as addressed and is re-reviewed', async () => {
  const r = initRepo()
  r.commit('root', { 'src/calc.ts': 'export function total(a: number, b: number) {\n  return a + b\n}\n' })
  r.write('src/calc.ts', 'export function total(a: number, b: number) {\n  return a - b\n}\n')
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitgoose.setSettings(p as never), AGENT)
  await reviewed(page)
  const review = page.getByTestId('review')

  // Nothing changed: the finding is carried over without asking again.
  await review.getByRole('button', { name: 'Review again' }).click()
  await expect(review.getByTestId('review-incremental')).toContainText('Re-review: 0 changed pieces sent, 1 unchanged.')
  await expect(review.getByTestId('finding-status')).toHaveText('still open')

  // Change the flagged line: the old finding is addressed, the new code is reviewed.
  r.write('src/calc.ts', 'export function total(a: number, b: number) {\n  return a * b\n}\n')
  await review.getByRole('button', { name: 'Review again' }).click()
  await expect(review.getByTestId('review-incremental')).toContainText('1 changed piece sent, 0 unchanged.')
  await expect(review.getByTestId('review-addressed')).toContainText('Possible bug here (src/calc.ts)')
  await expect(review.getByTestId('finding-status')).toHaveText('new')
  await expect(review.getByTestId('finding')).toContainText('return a * b')
  await app.close()
})

test('secrets are never sent as they are; linters run once allowed; tool findings join the review', async () => {
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
  const r = initRepo()
  r.commit('root', { 'src/config.ts': 'export const a = 1\n' })
  r.write('src/config.ts', `export const a = 1 // TODO\nexport const token = "${token}"\n`)
  const script = join(tempDir(), 'todo-lint.mjs')
  writeFileSync(script, 'import { readFileSync } from "node:fs"\nfor (const f of process.argv.slice(2)) readFileSync(f, "utf8").split("\\n").forEach((l, i) => { if (l.includes("TODO")) console.log(`${f}:${i + 1}:1: unfinished work [Warning/no-todo]`) })\n')
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitgoose.setSettings(p as never), { ...AGENT, reviewLinter: `"${process.execPath}" "${script}" {files}` })

  await page.getByTestId('review-menu').click()
  await page.getByRole('menuitem', { name: 'Review all uncommitted changes' }).click()
  // First the linter: asked once for this repository.
  const dialog = page.getByTestId('choice-dialog')
  await expect(dialog).toContainText('Allow it here?')
  await dialog.getByRole('button', { name: 'Allow' }).click()
  // Then the scan stops the request and says what it found, masked.
  await expect(dialog).toContainText('looks like a secret, so nothing was sent')
  await expect(dialog).toContainText('GitHub token ghp_…R8 (40 chars) in src/config.ts:2')
  await expect(dialog).not.toContainText(token)
  await dialog.getByRole('button', { name: 'Redact and send' }).click()

  const review = page.getByTestId('review')
  await expect(review.getByTestId('finding')).toHaveCount(3)
  await expect(review.getByTestId('finding-source')).toHaveText(['secret scan', 'todo-lint no-todo'])
  await expect(review.getByTestId('finding').first()).toContainText('Possible GitHub token in the code')
  await expect(review.getByTestId('review-linter')).toContainText('todo-lint on 1 file: 1 finding')

  // Review again with nothing changed sends nothing, so there is nothing to ask about.
  await review.getByRole('button', { name: 'Review again' }).click()
  await expect(review.getByTestId('finding-status')).toHaveText(['still open', 'still open', 'still open'])
  await expect(dialog).toHaveCount(0)

  // A full review: the linter is not asked about a second time; the secret is, and Cancel sends nothing.
  await page.getByTestId('review-menu').click()
  await page.getByRole('menuitem', { name: 'Review all uncommitted changes' }).click()
  await expect(dialog).toContainText('looks like a secret')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('review')).toHaveCount(0)
  await app.close()
})
