import { initRepo, makeFixture, tempDir } from '@gitgoose/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { launch, pickFromSubmenu } from './app'

const ref = (page: Page, name: string) => page.locator(`[data-testid="sidebar-ref"][data-ref="${name}"]`)
const remoteHeader = (page: Page, name: string) => page.locator(`[data-testid="remote-section"][data-name="${name}"] button`).first()
const sectionHeader = (page: Page, title: string) => page.getByTestId('sidebar').getByRole('button', { name: new RegExp(`^${title}\\b`) })
const item = (page: Page, name: string | RegExp) => page.getByRole('menuitem', { name })
const lsRemote = (bare: string, ...args: string[]) => execFileSync('git', ['ls-remote', ...args, bare], { encoding: 'utf8' })

test('add, rename, re-point and remove a remote from the sidebar; removing is undoable', async () => {
  const r = makeFixture('with-remote')
  const other = tempDir('gitgoose-other-')
  execFileSync('git', ['clone', '-q', '--bare', r.git('remote', 'get-url', 'origin').trim(), other])
  const { app, page } = await launch(r.dir)

  // Add: the new remote is fetched straight away, so its branches show.
  await page.getByRole('button', { name: 'Add remote' }).click()
  await expect(page.getByTestId('dialog-input')).toHaveValue('upstream')
  await page.getByLabel('URL').fill(other)
  await page.getByTestId('dialog-submit').click()
  await expect(remoteHeader(page, 'upstream')).toBeVisible()
  await expect.poll(() => r.git('branch', '-r')).toContain('upstream/main')

  // Rename, then give it a separate push URL.
  await remoteHeader(page, 'upstream').click({ button: 'right' })
  await item(page, 'Rename upstream…').click()
  await page.getByTestId('dialog-input').fill('mirror')
  await page.getByTestId('dialog-submit').click()
  await expect(remoteHeader(page, 'mirror')).toBeVisible()
  await remoteHeader(page, 'mirror').click({ button: 'right' })
  await item(page, 'Use a different URL for pushing…').click()
  await page.getByTestId('dialog-input').fill('/tmp/push-here.git')
  await page.getByTestId('dialog-submit').click()
  await expect.poll(() => r.gitOrNull('config', 'remote.mirror.pushurl')?.trim()).toBe('/tmp/push-here.git')

  // Remove, and undo it: the remote is back (its branches come back with the next fetch).
  await remoteHeader(page, 'mirror').click({ button: 'right' })
  await item(page, 'Remove mirror').click()
  await expect(remoteHeader(page, 'mirror')).toHaveCount(0)
  // The newest toast: older ones' Undo is refused once something newer happened.
  await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).last().click()
  await expect(remoteHeader(page, 'mirror')).toBeVisible()
  expect(r.git('config', 'remote.mirror.url').trim()).toBe(other)
  expect(r.git('config', 'remote.mirror.pushurl').trim()).toBe('/tmp/push-here.git')
  await remoteHeader(page, 'mirror').click()
  await expect(page.locator('[data-testid="remote-section"][data-name="mirror"]')).toContainText('Not fetched yet')
  await app.close()
})

test('push a tag, see which tags are local only, delete a tag on the remote', async () => {
  const r = makeFixture('with-remote')
  const bare = r.git('remote', 'get-url', 'origin').trim()
  r.git('tag', 'v1')
  r.git('tag', 'v2', 'HEAD~1')
  const { app, page } = await launch(r.dir)
  await sectionHeader(page, 'Tags').click()

  await ref(page, 'refs/tags/v1').click({ button: 'right' })
  await item(page, 'Push v1 to origin').click()
  await expect.poll(() => lsRemote(bare, '--tags')).toContain('refs/tags/v1')

  // Asking the remote is explicit (it is a network call); then tags it lacks are marked.
  await sectionHeader(page, 'Tags').click({ button: 'right' })
  await item(page, 'Check which tags are on origin').click()
  await expect(ref(page, 'refs/tags/v2')).toContainText('local only')
  await expect(ref(page, 'refs/tags/v1')).not.toContainText('local only')

  // Deleting on the remote asks first: undo cannot reach a remote.
  await ref(page, 'refs/tags/v1').click({ button: 'right' })
  await item(page, 'Delete v1 on origin…').click()
  await page.getByRole('button', { name: 'Delete remote tag' }).click()
  await expect.poll(() => lsRemote(bare, '--tags')).not.toContain('refs/tags/v1')
  await expect(ref(page, 'refs/tags/v1')).toContainText('local only')
  expect(r.git('tag')).toContain('v1')
  await app.close()
})

test('fast-forward a branch that is not checked out; stop and start tracking; push under another name', async () => {
  const r = makeFixture('with-remote')
  const bare = r.git('remote', 'get-url', 'origin').trim()
  r.git('branch', 'topic', 'HEAD~2')
  r.git('branch', '--set-upstream-to=origin/main', 'topic')
  const originMain = r.git('rev-parse', 'origin/main').trim()
  const { app, page } = await launch(r.dir)
  const topic = ref(page, 'refs/heads/topic')
  await expect(topic).toContainText('↓1')

  await topic.click({ button: 'right' })
  await item(page, 'Fast-forward topic to origin/main').click()
  await expect.poll(() => r.git('rev-parse', 'topic').trim()).toBe(originMain)
  await expect(topic).not.toContainText('↓1')

  await topic.click({ button: 'right' })
  await item(page, 'Stop tracking origin/main').click()
  await expect.poll(() => r.tryGit('config', 'branch.topic.merge')).toBe(1)
  // The menu is built from what the sidebar shows: wait until it shows the change, not just git.
  await expect(topic).toHaveAttribute('data-upstream', '')

  await topic.click({ button: 'right' })
  await pickFromSubmenu(page, 'Track a remote branch', 'Other…')
  await page.getByTestId('dialog-input').fill('origin/main')
  await page.getByTestId('dialog-submit').click()
  await expect.poll(() => r.gitOrNull('rev-parse', '--abbrev-ref', 'topic@{upstream}')?.trim()).toBe('origin/main')

  await topic.click({ button: 'right' })
  await item(page, 'Push to origin…').click()
  await expect(page.getByTestId('dialog-input')).toHaveValue('topic')
  await page.getByTestId('dialog-input').fill('shared-topic')
  await page.getByTestId('dialog-submit').click()
  await expect.poll(() => lsRemote(bare, '--heads')).toContain('refs/heads/shared-topic')
  await expect.poll(() => r.git('rev-parse', '--abbrev-ref', 'topic@{upstream}').trim()).toBe('origin/shared-topic')
  await app.close()
})

test('clean up merged and stale branches in one undoable step', async () => {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'a\n' })
  r.git('branch', 'done')
  r.git('checkout', '-q', '-b', 'old-work')
  r.commit('abandoned idea', { 'idea.txt': 'maybe\n' })
  r.checkout('main')
  r.commit('main moves on', { 'b.txt': 'b\n' })
  // Merged too, but checked out in another worktree: git would refuse to delete it.
  r.git('worktree', 'add', '-q', '-b', 'hotfix', `${r.dir}-hotfix`)
  const { app, page } = await launch(r.dir)
  await expect(ref(page, 'refs/heads/done')).toContainText('merged')
  // Fixture commits are from 2023: older than 90 days, so stale.
  await expect(ref(page, 'refs/heads/old-work')).toContainText('stale')
  await expect(ref(page, 'refs/heads/main')).not.toContainText('merged')

  await sectionHeader(page, 'Local').click({ button: 'right' })
  await item(page, 'Clean up branches…').click()
  const list = page.getByTestId('cleanup-list')
  await expect(list.getByRole('checkbox', { name: 'done' })).toBeChecked()
  await expect(list.getByRole('checkbox', { name: 'old-work' })).not.toBeChecked()
  await expect(list.getByRole('checkbox', { name: 'main' })).toHaveCount(0)
  await expect(list.getByRole('checkbox', { name: 'hotfix' })).toHaveCount(0)
  await list.getByRole('checkbox', { name: 'old-work' }).check()
  await expect(page.getByRole('dialog')).toContainText('1 of these is not merged')
  await page.getByTestId('dialog-submit').click()
  await expect(ref(page, 'refs/heads/done')).toHaveCount(0)
  await expect(ref(page, 'refs/heads/old-work')).toHaveCount(0)

  await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).first().click()
  await expect(ref(page, 'refs/heads/done')).toHaveCount(1)
  await expect(ref(page, 'refs/heads/old-work')).toHaveCount(1)
  await app.close()
})
