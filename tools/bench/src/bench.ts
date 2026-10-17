/**
 * Performance benchmark: the numbers the plan promises.
 *
 *   pnpm bench            run and print results
 *   pnpm bench --check    also fail (exit 1) if a budget is missed (used in CI)
 *   pnpm bench --commits 20000   smaller repo for a quick run
 *
 * Three layers are timed separately so a regression points at its cause:
 *   1. git:    open the repo and read the first page of the log (LogStream)
 *   2. layout: lane layout for every commit
 *   3. app:    launch Electron, time to the first painted graph rows, then scroll fps
 */
import { makeLargeRepo } from '@gitsquid/fixtures'
import { Repo } from '@gitsquid/git'
import { layout } from '@gitsquid/graph'
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string, fallback: number) => {
  const i = args.indexOf(name)
  return i >= 0 ? Number(args[i + 1]) : fallback
}

const COMMITS = option('--commits', 100_000)
const root = resolve(import.meta.dirname, '../../..')

/** Budgets from the plan. CI machines are slower, so --check uses these generous limits. */
const BUDGET = {
  firstPageMs: 300,
  layoutAllMs: 1000,
  appFirstPaintMs: 2500,
  scrollFps: 45,
}

async function time<T>(fn: () => Promise<T> | T): Promise<[T, number]> {
  const t = performance.now()
  const v = await fn()
  return [v, performance.now() - t]
}

async function main() {
  const cache = join(root, '.fixtures', `large-${COMMITS}`)
  if (!existsSync(join(cache, '.git'))) {
    console.log(`Generating a ${COMMITS.toLocaleString()}-commit repository (cached in .fixtures/)…`)
    mkdirSync(cache, { recursive: true })
    makeLargeRepo(COMMITS, cache)
  }

  // 1. git layer. "Cold" is a repository without a commit-graph file; the app writes one in
  // the background (ADR-004), after which every log walk is "warm".
  for (const f of ['commit-graph', 'commit-graphs']) rmSync(join(cache, '.git/objects/info', f), { recursive: true, force: true })
  const cold = await Repo.open(cache)
  await cold.snapshot()
  const [, coldFirstPageMs] = await time(() => cold.logPage(0, 300))
  cold.dispose()
  const repo = await Repo.open(cache)
  await repo.maintainCommitGraph()
  await repo.snapshot()
  const [, firstPageMs] = await time(() => repo.logPage(0, 300))
  const [all, fullLogMs] = await time(() => repo.logPage(0, 10_000_000))
  repo.dispose()

  // 2. layout
  const head = all.commits[0]?.hash
  const [rows, layoutAllMs] = await time(() => layout(all.commits, { head }))
  const maxLanes = rows.reduce((m, r) => Math.max(m, r.width), 0)

  // 3. the app
  const main = join(root, 'apps/desktop/out/main/index.js')
  let appFirstPaintMs = NaN
  let scrollFps = NaN
  let idleFps = NaN
  if (!existsSync(main)) {
    console.log('Skipping the app benchmark: build it first (pnpm build).')
  } else {
    const launchArgs = [main]
    if (process.platform === 'linux') launchArgs.unshift('--no-sandbox')
    const t0 = performance.now()
    const app = await electron.launch({
      args: launchArgs,
      env: {
        ...process.env,
        GITSQUID_OPEN: cache,
        GITSQUID_USER_DATA: mkdtempSync(join(tmpdir(), 'gitsquid-bench-')),
        GITSQUID_NO_UPDATE: '1',
      } as Record<string, string>,
    })
    const page = await app.firstWindow()
    await page.getByTestId('commit-row').first().waitFor()
    appFirstPaintMs = performance.now() - t0

    // Scroll the graph continuously for two seconds and count animation frames.
    // Passed as a string: tsx rewrites named functions with a helper that does not exist in the page.
    idleFps = (await page.evaluate(FPS_PROBE.replace('SCROLL', '0'))) as number
    scrollFps = (await page.evaluate(FPS_PROBE.replace('SCROLL', '120'))) as number
    await app.close()
  }

  const results = {
    commits: all.commits.length,
    maxLanes,
    coldFirstPageMs: round(coldFirstPageMs),
    firstPageMs: round(firstPageMs),
    fullLogMs: round(fullLogMs),
    layoutAllMs: round(layoutAllMs),
    appFirstPaintMs: round(appFirstPaintMs),
    idleFps: round(idleFps),
    scrollFps: round(scrollFps),
    platform: `${process.platform}-${process.arch}`,
    date: new Date().toISOString(),
  }
  console.table(results)
  mkdirSync(join(root, 'bench-results'), { recursive: true })
  writeFileSync(join(root, 'bench-results', 'latest.json'), JSON.stringify(results, null, 2))

  if (flag('--check')) {
    const failures: string[] = []
    if (results.firstPageMs > BUDGET.firstPageMs) failures.push(`first log page ${results.firstPageMs} ms > ${BUDGET.firstPageMs} ms`)
    if (results.layoutAllMs > BUDGET.layoutAllMs) failures.push(`layout ${results.layoutAllMs} ms > ${BUDGET.layoutAllMs} ms`)
    if (results.appFirstPaintMs > BUDGET.appFirstPaintMs) failures.push(`app first paint ${results.appFirstPaintMs} ms > ${BUDGET.appFirstPaintMs} ms`)
    // Scrolling must keep up with what the machine can draw at all, minus a little slack.
    const fpsBudget = Math.min(BUDGET.scrollFps, results.idleFps * 0.9)
    if (results.scrollFps < fpsBudget) failures.push(`scroll ${results.scrollFps} fps < ${round(fpsBudget)} fps (idle: ${results.idleFps})`)
    if (failures.length) {
      console.error('Performance budget missed:\n  ' + failures.join('\n  '))
      process.exit(1)
    }
    console.log('All performance budgets met.')
  }
}

/**
 * Count animation frames for two seconds while scrolling the graph SCROLL px per frame.
 * With SCROLL = 0 it measures the idle frame rate: the ceiling this machine can reach at all
 * (a VM without a GPU may never hit 60), which is what scrolling should be compared against.
 */
const FPS_PROBE = `(async () => {
  const el = document.querySelector('[data-testid="graph-scroll"]')
  let frames = 0
  const start = performance.now()
  await new Promise((done) => {
    const tick = (now) => {
      frames++
      el.scrollTop += SCROLL
      if (now - start < 2000) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })
  return frames / ((performance.now() - start) / 1000)
})()`

function round(n: number): number {
  return Math.round(n * 10) / 10
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
