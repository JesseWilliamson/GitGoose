import { initRepo } from '@gitgoose/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { launch } from './app'

const FAKE = join(import.meta.dirname, 'fake-agent.mjs')
const AGENT_CMD = `"${process.execPath}" "${FAKE}"`
const AGENT = { aiProvider: 'agent', aiAgent: 'custom', aiAgentCommand: AGENT_CMD, aiConsent: [`agent:${AGENT_CMD}`] }

const row = (page: Page, hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)
/**
 * A proposed commit by its place in the plan (0 = oldest, made first), wherever it is drawn: the
 * list shows the plan newest at the top, like the graph.
 */
const planned = (page: Page, i: number) => page.locator(`[data-testid="recompose-commit"][data-index="${i}"]`)
const plannedTitle = (page: Page, i: number) => planned(page, i).getByTestId('recompose-title')

/** base - C1 (a.txt + notes.md) - C2 (b.txt) - C3 (after the range) */
function setup() {
  const r = initRepo()
  r.commit('base', { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  const C1 = r.commit('wip stuff', { 'a.txt': 'a changed\n', 'notes.md': '# notes\n' })
  const C2 = r.commit('more wip', { 'b.txt': 'b changed\n' })
  const C3 = r.commit('docs: later', { 'later.txt': 'later\n' })
  return { r, C1, C2, C3 }
}

test('recompose: the AI proposes, you reorder and edit, Create commits rewrites, Undo restores', async () => {
  const { r, C1, C2, C3 } = setup()
  const tree = r.git('rev-parse', 'HEAD^{tree}').trim()
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitgoose.setSettings(p as never), AGENT)
  await row(page, C2).click()
  await row(page, C1).click({ modifiers: ['Shift'] })
  await row(page, C1).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Recompose with AI…' }).click()

  // The fake agent's plan: the last piece (notes.md… whichever came last) alone first, then the rest.
  const commits = page.getByTestId('recompose-commit')
  await expect(commits).toHaveCount(2)
  await expect(plannedTitle(page, 1)).toHaveText('feat: everything else')
  // Nothing has changed yet.
  expect(r.head()).toBe(C3)

  // Reorder, undo it (Ctrl+Z), redo (the button), reset, reorder again; then edit the (now
  // first) commit's message, and undo/redo that as one step.
  await planned(page, 0).getByTestId('recompose-up').click()
  await expect(plannedTitle(page, 0)).toHaveText('feat: everything else')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(plannedTitle(page, 0)).not.toHaveText('feat: everything else')
  await page.getByTestId('recompose-redo').click()
  await expect(plannedTitle(page, 0)).toHaveText('feat: everything else')
  await page.getByTestId('recompose-reset').click()
  await expect(plannedTitle(page, 0)).not.toHaveText('feat: everything else')
  await planned(page, 0).getByTestId('recompose-up').click()
  await planned(page, 0).click()
  await page.getByTestId('recompose-message').fill('feat: a and b')
  await expect(plannedTitle(page, 0)).toHaveText('feat: a and b')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(plannedTitle(page, 0)).toHaveText('feat: everything else')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(plannedTitle(page, 0)).toHaveText('feat: a and b')
  // Esc while typing only leaves the field; a second Esc, from rest, would close the dialog.
  await page.getByTestId('recompose-message').focus()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('recompose-dialog')).toHaveCount(1)
  await expect(page.getByTestId('recompose-message')).not.toBeFocused()

  await page.getByTestId('recompose-apply').click()
  await expect(page.getByTestId('recompose-dialog')).toHaveCount(0)
  const subjects = r.git('log', '--format=%s', '-4').trim().split('\n')
  expect(subjects[0]).toBe('docs: later')
  expect(subjects[1]).toMatch(/^chore: .* first$/)
  expect(subjects[2]).toBe('feat: a and b')
  expect(subjects[3]).toBe('base')
  // Same final code.
  expect(r.git('rev-parse', 'HEAD^{tree}').trim()).toBe(tree)

  await page.getByTestId('toolbar').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => r.head()).toBe(C3)
  await app.close()
})

test('squashing in the review, and refusing a selection that is not a range', async () => {
  const { r, C1, C3 } = setup()
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitgoose.setSettings(p as never), AGENT)
  // C1 and C3 do not follow each other: main refuses before asking the AI anything.
  await row(page, C3).click()
  await row(page, C1).click({ modifiers: ['ControlOrMeta'] })
  await row(page, C1).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Recompose with AI…' }).click()
  await expect(page.getByTestId('recompose-error')).toContainText('follow each other')
  await page.getByRole('button', { name: 'Close' }).click()

  // One commit can be split too; squash the proposal back into one: Shift-click both proposed
  // commits, then the right-click menu. (A plain click first: while both stay selected, the
  // graph's right-click menu is the one for the whole selection.)
  await row(page, C1).click()
  await row(page, C1).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Split with AI…' }).click()
  const commits = page.getByTestId('recompose-commit')
  await expect(commits).toHaveCount(2)
  await planned(page, 0).click()
  await planned(page, 1).click({ modifiers: ['Shift'] })
  await expect(page.locator('[data-testid="recompose-commit"][data-selected]')).toHaveCount(2)
  await planned(page, 1).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Squash 2 commits into one' }).click()
  await expect(commits).toHaveCount(1)
  await expect(page.getByTestId('recompose-apply')).toHaveText('Create 1 commit')
  await page.getByTestId('recompose-apply').click()
  await expect(page.getByTestId('recompose-dialog')).toHaveCount(0)
  // C2 and C3 sit above the rebuilt C1, with their own messages and new parents. The squashed
  // commit's message starts with the first proposed commit's (oldest first, as git squashes).
  expect(r.git('log', '--format=%s', '-3').trim().split('\n')).toEqual(['docs: later', 'more wip', 'chore: notes.md first'])
  expect(r.git('log', '--format=%B', '-1', 'HEAD~2')).toContain('feat: everything else')
  await app.close()
})

test('move a change to another commit or a new one; empty commits block until removed', async () => {
  const { r, C1, C2 } = setup()
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitgoose.setSettings(p as never), AGENT)
  await row(page, C2).click()
  await row(page, C1).click({ modifiers: ['Shift'] })
  await row(page, C1).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Recompose with AI…' }).click()
  const commits = page.getByTestId('recompose-commit')
  await expect(commits).toHaveCount(2)
  // The first proposed commit has one change; move it into the second: the first is now empty.
  await expect(page.getByTestId('recompose-unit')).toHaveCount(1)
  await page.getByTestId('recompose-move').click()
  await page.getByRole('menuitem', { name: '2. feat: everything else' }).click()
  await expect(planned(page, 0)).toContainText('No changes')
  await expect(page.getByTestId('recompose-problems')).toContainText('Commit 1 has no changes')
  await expect(page.getByTestId('recompose-apply')).toBeDisabled()
  await page.getByTestId('recompose-remove-empty').click()
  await expect(commits).toHaveCount(1)

  // Back out of it into a new commit, which needs a message before it can be created.
  await planned(page, 0).click()
  await expect(page.getByTestId('recompose-unit')).toHaveCount(3)
  await page.getByTestId('recompose-move').first().click()
  await page.getByRole('menuitem', { name: 'A new commit' }).click()
  await expect(commits).toHaveCount(2)
  await expect(page.getByTestId('recompose-problems')).toContainText('Commit 2 needs a message')
  await planned(page, 1).click()
  await page.getByTestId('recompose-message').fill('chore: split out')
  await page.getByTestId('recompose-apply').click()
  await expect(page.getByTestId('recompose-dialog')).toHaveCount(0)
  expect(r.git('log', '--format=%s', '-3').trim().split('\n')).toEqual(['docs: later', 'chore: split out', 'feat: everything else'])
  await app.close()
})

/** Press on `from`, move the pointer to `to` (or a point) in steps, release: a pointer drag, not an HTML5 one. */
async function drag(page: Page, from: ReturnType<Page['locator']>, to: ReturnType<Page['locator']> | { x: number; y: number } | (() => Promise<{ x: number; y: number }>)) {
  // Near the top-left: a hunk card is dragged by its header, not its diff text.
  const a = (await from.boundingBox())!
  await page.mouse.move(a.x + 20, a.y + 12)
  await page.mouse.down()
  await page.mouse.move(a.x + 30, a.y + 20, { steps: 3 })
  // A function is asked once the lift has started: the dialog can re-centre as it changes height.
  const target = typeof to === 'function' ? await to() : 'x' in to ? to : await to.boundingBox().then((b) => ({ x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 }))
  await page.mouse.move(target.x, target.y, { steps: 10 })
  return { drop: () => page.mouse.up() }
}

test('drag: a hunk onto a commit, a hunk into the open space for a new commit, a commit to reorder', async () => {
  const { r } = setup()
  const { app, page } = await launch(r.dir)
  await page.evaluate((p) => window.gitgoose.setSettings(p as never), AGENT)
  const [C1, C2] = [r.git('rev-parse', 'HEAD~2').trim(), r.git('rev-parse', 'HEAD~1').trim()]
  await row(page, C2).click()
  await row(page, C1).click({ modifiers: ['Shift'] })
  await row(page, C1).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Recompose with AI…' }).click()
  const commits = page.getByTestId('recompose-commit')
  await expect(commits).toHaveCount(2)
  await expect(page.getByTestId('recompose-unit')).toHaveCount(1)
  const first = await plannedTitle(page, 0).textContent()

  // Lift the one hunk of commit 1: it leaves an empty slot behind, the hunks column dims, and
  // the commits column says where it can go. Over commit 2, that commit lights up.
  let d = await drag(page, page.getByTestId('recompose-unit'), planned(page, 1))
  await expect(page.locator('.drag-float')).toHaveCount(1)
  await expect(page.locator('[data-testid="recompose-unit"].drag-placeholder')).toHaveCount(1)
  await expect(page.getByTestId('recompose-hunks-column')).toHaveClass(/opacity-40/)
  await expect(page.getByTestId('recompose-commits-column')).toContainText('drop on a commit')
  await expect(planned(page, 1)).toHaveAttribute('data-target', 'true')
  await d.drop()
  await expect(page.locator('.drag-float')).toHaveCount(0)
  await expect(planned(page, 0)).toContainText('No changes')
  await expect(page.getByTestId('recompose-problems')).toContainText('Commit 1 has no changes')

  // From commit 2, drag a hunk into the space above the newest commit: a third commit appears with it.
  await planned(page, 1).click()
  await expect(page.getByTestId('recompose-unit')).toHaveCount(3)
  d = await drag(page, page.getByTestId('recompose-unit').last(), page.getByTestId('recompose-new-commit'))
  await expect(page.getByTestId('recompose-new-commit')).toHaveAttribute('data-target', 'true')
  await d.drop()
  await expect(commits).toHaveCount(3)
  await expect(page.getByTestId('recompose-unit')).toHaveCount(2)
  await expect(planned(page, 2)).toContainText('1 file')
  // Released over nothing in particular, a hunk goes back where it was.
  const box = (await page.getByTestId('recompose-dialog').boundingBox())!
  d = await drag(page, page.getByTestId('recompose-unit').first(), { x: box.x + box.width - 40, y: box.y + box.height - 20 })
  await d.drop()
  await expect(page.getByTestId('recompose-unit')).toHaveCount(2)

  // Drag commit 1 (at the bottom) up to the upper edge of commit 2: the list reorders as the
  // pointer moves. Esc mid-drag puts it back (and does not close the dialog); dropping it keeps
  // it there, selected.
  const upperEdge = async (i: number) => { const b = (await planned(page, i).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + 3 } }
  d = await drag(page, planned(page, 0), () => upperEdge(1))
  await expect(page.locator('[data-testid="recompose-commit"].drag-placeholder')).toHaveCount(1)
  await expect(plannedTitle(page, 1)).toHaveText(first!)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(page.locator('.drag-float')).toHaveCount(0)
  await expect(page.getByTestId('recompose-dialog')).toHaveCount(1)
  await expect(plannedTitle(page, 0)).toHaveText(first!)
  d = await drag(page, planned(page, 0), () => upperEdge(1))
  await d.drop()
  await expect(plannedTitle(page, 1)).toHaveText(first!)
  await expect(planned(page, 1)).toHaveAttribute('data-selected', 'true')

  // Dropping a commit on the middle of another just reorders (squash is the right-click menu).
  await expect(commits).toHaveCount(3)
  d = await drag(page, planned(page, 2), planned(page, 1))
  await d.drop()
  await expect(commits).toHaveCount(3)
  await app.close()
})
