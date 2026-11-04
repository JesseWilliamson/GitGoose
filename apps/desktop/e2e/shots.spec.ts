import { test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './app'

// Not a test: `SHOTS_OUT=dir xvfb-run -a npx playwright test e2e/shots.spec.ts` captures every
// main screen of the app on the dev repository, for design reviews.
const OUT = process.env.SHOTS_OUT ?? ''
const SRC = join(import.meta.dirname, '..', '..', '..', '.fixtures')
const SIZE = { width: 1440, height: 900 }

async function open(repo: string | undefined, theme: string) {
  // At 2x, as a high-density screen shows it (and as product screenshots are taken).
  const l = await launch(repo, {}, { keepSize: true, args: [`--force-device-scale-factor=${process.env.SHOTS_SCALE ?? 2}`] })
  await l.app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setContentSize(s.width, s.height), SIZE)
  await l.page.evaluate((t) => window.gitgoose.setSettings({ theme: t as 'dark' }), theme)
  await l.page.waitForTimeout(2500)
  return l
}

test.skip(!OUT, 'screenshots only on request')
for (const theme of (process.env.SHOTS_THEMES ?? 'dark,light').split(',')) {
  test(`capture ${theme}`, async () => {
    test.setTimeout(240_000)
    const dir = join(OUT, theme)
    mkdirSync(dir, { recursive: true })
    const work = join(OUT, `repo-${theme}`)
    rmSync(work, { recursive: true, force: true })
    cpSync(SRC, work, { recursive: true })
    const { app, page } = await open(join(work, 'dev-repo'), theme)
    const shot = (n: string) => page.screenshot({ path: join(dir, `${n}.png`) })
    await shot('01-browse')
    const rows = page.getByTestId('commit-row')
    await rows.nth(3).click(); await page.waitForTimeout(800)
    await shot('02-browse-selected')
    await page.keyboard.press('Space'); await page.waitForTimeout(1500)
    await shot('03-read')
    await page.keyboard.press('Escape'); await page.waitForTimeout(400)
    await page.keyboard.press('3'); await page.waitForTimeout(1500)
    await shot('04-changes')
    await page.keyboard.press('1'); await page.waitForTimeout(500)
    await page.keyboard.press('ControlOrMeta+k'); await page.waitForTimeout(600)
    await shot('05-omni')
    await page.keyboard.press('Escape'); await page.waitForTimeout(300)
    await rows.nth(5).click({ button: 'right' }); await page.waitForTimeout(500)
    await shot('06-context-menu')
    await page.keyboard.press('Escape')
    await app.close()

    try { execFileSync('git', ['-C', join(work, 'dev-repo'), 'merge', 'conflict/both-added'], { stdio: 'ignore' }) } catch { /* stops on conflicts */ }
    const r = await open(join(work, 'dev-repo'), theme)
    await r.page.waitForTimeout(1000)
    await r.page.screenshot({ path: join(dir, '08-resolve.png') })
    await r.app.close()

    const w = await open(undefined, theme)
    await w.page.screenshot({ path: join(dir, '07-welcome.png') })
    await w.app.close()
  })
}
