import { tempDir } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

test('a long repository path is cut from the left: what is visible ends with the folder name', async () => {
  const deep = join(tempDir('gitgoose-status-'), 'a-quite-long-parent-folder-name', 'another-long-folder-name', 'yet-another-folder-on-the-way', 'my-repo')
  mkdirSync(deep, { recursive: true })
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada Lovelace', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada Lovelace', GIT_COMMITTER_EMAIL: 'ada@example.com' }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: deep, env })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'root'], { cwd: deep, env })
  const { app, page } = await launch(deep)
  const path = page.getByTestId('status-path')
  await expect(path).toBeVisible()
  // The tooltip has all of it.
  await expect(path).toHaveAttribute('title', deep)
  // It does not fit, so it is clipped, and the clipped end is the start.
  const seen = await path.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const text = el.querySelector('bdi')!.firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 1)
    const first = range.getBoundingClientRect()
    range.setStart(text, text.textContent!.length - 1)
    range.setEnd(text, text.textContent!.length)
    const last = range.getBoundingClientRect()
    return { clipped: el.scrollWidth > el.clientWidth, firstLeft: first.left - box.left, lastRight: last.right - box.right, text: text.textContent }
  })
  expect(seen.clipped).toBe(true)
  expect(seen.firstLeft).toBeLessThan(0) // the start is cut off
  expect(seen.lastRight).toBeLessThanOrEqual(1) // the end, "my-repo", is in view
  expect(seen.text!.endsWith('my-repo')).toBe(true)
  // And the text still reads left to right, with its leading slash where it belongs.
  expect(seen.text!.startsWith('/')).toBe(true)
  await app.close()
})
