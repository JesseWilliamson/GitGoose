import { initRepo } from '@gitsquid/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { launch, pickFromSubmenu } from './app'

/** root - A - B - C - D (main), each commit adding its own file. */
function setup() {
  const r = initRepo()
  r.commit('root', { 'root.txt': 'root\n' })
  const [A, B, C, D] = ['A', 'B', 'C', 'D'].map((n) => r.commit(n, { [`${n}.txt`]: `${n}\n` }))
  return { r, A: A!, B: B!, C: C!, D: D! }
}
const subjects = (r: ReturnType<typeof setup>['r']) => r.git('log', '--format=%s').trim().split('\n')
const row = (page: Page, hash: string) => page.locator(`[data-testid="commit-row"][data-hash="${hash}"]`)

test('drop a commit from the menu, then undo it', async () => {
  const { r, B, D } = setup()
  const { app, page } = await launch(r.dir)
  await row(page, B).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Drop commit' }).click()
  await expect.poll(() => subjects(r)).toEqual(['D', 'C', 'A', 'root'])
  await page.getByTestId('toolbar').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => r.head()).toBe(D)
  await app.close()
})

test('move a commit up and down from the menu; the root commit is not offered', async () => {
  const { r, B } = setup()
  const { app, page } = await launch(r.dir)
  await row(page, B).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move commit up' }).click()
  await expect.poll(() => subjects(r)).toEqual(['D', 'B', 'C', 'A', 'root'])
  const movedB = r.git('rev-parse', 'HEAD~1').trim()
  await row(page, movedB).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move commit down' }).click()
  await expect.poll(() => subjects(r)).toEqual(['D', 'C', 'B', 'A', 'root'])
  const root = r.git('rev-list', '--max-parents=0', 'HEAD').trim()
  await row(page, root).click({ button: 'right' })
  await expect(page.getByRole('menu')).not.toContainText('Drop commit')
  await page.keyboard.press('Escape')
  await app.close()
})

test('drag one commit, or a selection, to a new place in the branch', async () => {
  const { r, A, D } = setup()
  const { app, page } = await launch(r.dir)
  // D onto the lower half of A: D goes just below (older than) A.
  const a = (await row(page, A).boundingBox())!
  await row(page, D).dragTo(row(page, A), { targetPosition: { x: a.width / 2, y: a.height * 0.8 } })
  await expect.poll(() => subjects(r)).toEqual(['C', 'B', 'A', 'D', 'root'])

  // Select B and C (Shift-click) and drag them onto the upper half of the D commit.
  const [c, b, , d] = r.git('log', '--format=%H', '-4').trim().split('\n')
  await row(page, c!).click()
  await row(page, b!).click({ modifiers: ['Shift'] })
  const box = (await row(page, d!).boundingBox())!
  await row(page, b!).dragTo(row(page, d!), { targetPosition: { x: box.width / 2, y: box.height * 0.2 } })
  await expect.poll(() => subjects(r)).toEqual(['A', 'C', 'B', 'D', 'root'])
  await app.close()
})

test('a move that conflicts stops with an alert you cannot miss; Abort puts it back', async () => {
  const r = initRepo()
  r.commit('root', { 'f.txt': '1\n' })
  const X = r.commit('X', { 'f.txt': '2\n' })
  const Y = r.commit('Y', { 'f.txt': '3\n' })
  const { app, page } = await launch(r.dir)
  const x = (await row(page, X).boundingBox())!
  await row(page, Y).dragTo(row(page, X), { targetPosition: { x: x.width / 2, y: x.height * 0.8 } })
  const alert = page.getByTestId('attention-row').filter({ hasText: 'conflicts' })
  await expect(alert).toContainText('The rebase stopped: 1 file has conflicts')
  await expect(page.getByTestId('conflicts')).toBeVisible()
  await expect(page.getByTestId('attention-row')).toHaveCount(1)
  await alert.getByRole('button', { name: 'Abort rebase' }).click()
  await expect.poll(() => r.head()).toBe(Y)
  await expect(page.getByTestId('attention-row')).toHaveCount(0)
  await expect(page.getByTestId('conflicts')).toHaveCount(0)
  await app.close()
})

test('reword a commit; squash it into the one below; undo and redo', async () => {
  const { r, B } = setup()
  const { app, page } = await launch(r.dir)
  await row(page, B).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reword…' }).click()
  await expect(page.getByTestId('dialog-text')).toHaveValue('B')
  await page.getByTestId('dialog-text').fill('B, better\n\nWith a reason.')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect.poll(() => subjects(r)).toEqual(['D', 'C', 'B, better', 'A', 'root'])

  const c = r.git('rev-parse', 'HEAD~1').trim()
  await row(page, c).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Squash into the commit below' }).click()
  await expect.poll(() => subjects(r)).toEqual(['D', 'B, better', 'A', 'root'])
  const squashed = r.head()

  // Undo, then Redo from the toolbar and the keyboard.
  await page.getByTestId('toolbar').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => subjects(r)).toEqual(['D', 'C', 'B, better', 'A', 'root'])
  await page.getByTestId('toolbar').getByRole('button', { name: 'Redo' }).click()
  await expect.poll(() => r.head()).toBe(squashed)
  await page.getByTestId('toolbar').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => subjects(r)).toEqual(['D', 'C', 'B, better', 'A', 'root'])
  await page.getByTestId('graph-scroll').focus()
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(() => r.head()).toBe(squashed)

  // And from Edit → Redo in the menu bar.
  await page.getByTestId('toolbar').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => subjects(r)).toEqual(['D', 'C', 'B, better', 'A', 'root'])
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const edit = Menu.getApplicationMenu()!.items.find((i) => i.label === 'Edit')!.submenu!
    edit.items.find((i) => i.label === 'Redo')!.click(undefined, BrowserWindow.getAllWindows()[0])
  })
  await expect.poll(() => r.head()).toBe(squashed)
  await app.close()
})

test('drag a commit onto another to squash it in; fixup staged changes into an older commit', async () => {
  const { r, A, D } = setup()
  const { app, page } = await launch(r.dir)
  await row(page, D).dragTo(row(page, A))
  await expect.poll(() => subjects(r)).toEqual(['C', 'B', 'A', 'root'])
  expect(r.git('show', '--stat', '--format=%B', 'HEAD~2')).toContain('D.txt')

  r.write('A.txt', 'A fixed\n')
  r.git('add', 'A.txt')
  const a = r.git('rev-parse', 'HEAD~2').trim()
  await row(page, a).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Fixup staged changes into this commit' }).click()
  await expect.poll(() => r.git('show', 'HEAD~2:A.txt')).toBe('A fixed\n')
  expect(subjects(r)).toEqual(['C', 'B', 'A', 'root'])
  await app.close()
})

test('squash merge stages the changes and prepares the message', async () => {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'a\n' })
  r.git('checkout', '-q', '-b', 'topic')
  r.commit('topic: add t', { 't.txt': 't\n' })
  r.checkout('main')
  const { app, page } = await launch(r.dir)
  await page.locator('[data-testid="sidebar-ref"][data-ref="refs/heads/topic"]').click({ button: 'right' })
  await pickFromSubmenu(page, 'Merge options', 'Squash topic into main')
  await expect(page.getByTestId('commit-summary')).toHaveValue(/Squashed commit/)
  await expect(page.getByTestId('staged-file')).toHaveCount(1)
  await app.close()
})
