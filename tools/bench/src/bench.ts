/**
 * Performance benchmark: the numbers the plan promises.
 *
 *   pnpm bench            run and print results
 *   pnpm bench --check    also fail (exit 1) if a budget is missed (used in CI)
 *   pnpm bench --commits 20000   smaller repo for a quick run
 *
 * Three layers are timed separately so a regression points at its cause:
 *   1. git:    open the repo and read the first page of the log (LogStream), in date order and in
 *              topological order, each without and with a commit-graph file (ADR-003)
 *   2. layout: lane layout for every commit
 *   3. app:    launch Electron, time to the first painted graph rows, then scroll fps; where
 *              the startup time went (the app's performance marks, from process start); and
 *              what the main bundle loads before the window can open
 *   4. sidebar: the 3,000-commit dev repository with 2,000 generated branches and tags (in
 *              folders), every section open: time to the first sidebar rows, rows in the DOM,
 *              and scroll fps through the whole list (PLAN-4 phase 4)
 */
import { makeDevRepo, makeLargeRepo } from '@gitgoose/fixtures'
import { Repo } from '@gitgoose/git'
import { layout } from '@gitgoose/graph'
import { _electron as electron, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string, fallback: number) => {
  const i = args.indexOf(name)
  return i >= 0 ? Number(args[i + 1]) : fallback
}

const COMMITS = option('--commits', 100_000)
/** Branches and tags generated for the sidebar benchmark (half each). */
const SIDEBAR_REFS = option('--refs', 2000)
const root = resolve(import.meta.dirname, '../../..')

/** Budgets from the plan. CI machines are slower, so --check uses these generous limits. */
const BUDGET = {
  firstPageMs: 300,
  layoutAllMs: 1000,
  appFirstPaintMs: 2500,
  scrollFps: 45,
  sidebarFirstPaintMs: 2500,
  /** Rows the sidebar may keep in the DOM: what fits on screen plus overscan, never the whole list. */
  sidebarDomRows: 120,
}

/**
 * Modules the main process must not load before its window opens: each costs tens to hundreds
 * of milliseconds and is needed only later, or only in the indexer process. See
 * apps/desktop/src/main/startup.test.ts, which checks the sources; this checks the build.
 */
const LAZY_MODULES = ['@anthropic-ai/sdk', '@agentclientprotocol/sdk', '@parcel/watcher', 'web-tree-sitter', 'electron-updater']

/** Bare modules the built main entry (and the chunks it imports) import statically. */
function staticImports(entry: string, seen = new Set<string>()): string[] {
  if (seen.has(entry)) return []
  seen.add(entry)
  const text = readFileSync(entry, 'utf8')
  const out: string[] = []
  for (const m of text.matchAll(/^import\s+(?:[^'"]*?\s+from\s+)?["']([^'"]+)["']/gm)) {
    const spec = m[1]!
    if (spec.startsWith('.')) out.push(...staticImports(resolve(entry, '..', spec), seen))
    else out.push(spec)
  }
  return out
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
  // Topological order is timed both ways too: without generation numbers git must walk all of
  // history before it can print the first commit; with them it walks in increments.
  for (const f of ['commit-graph', 'commit-graphs']) rmSync(join(cache, '.git/objects/info', f), { recursive: true, force: true })
  const firstPage = async (order: Parameters<Repo['setCommitOrder']>[0]) => {
    const r = await Repo.open(cache)
    r.setCommitOrder(order)
    await r.snapshot()
    const [, ms] = await time(() => r.logPage(0, 300))
    r.dispose()
    return ms
  }
  const coldFirstPageMs = await firstPage('date')
  const coldTopoFirstPageMs = await firstPage('topo')
  const repo = await Repo.open(cache)
  await repo.maintainCommitGraph()
  await repo.snapshot()
  const [, firstPageMs] = await time(() => repo.logPage(0, 300))
  const [all, fullLogMs] = await time(() => repo.logPage(0, 10_000_000))
  repo.dispose()
  const topoFirstPageMs = await firstPage('topo')

  // 2. layout
  const head = all.commits[0]?.hash
  const [rows, layoutAllMs] = await time(() => layout(all.commits, { head }))
  const maxLanes = rows.reduce((m, r) => Math.max(m, r.width), 0)

  // 3. the app
  const main = join(root, 'apps/desktop/out/main/index.js')
  let appFirstPaintMs = NaN
  let scrollFps = NaN
  let idleFps = NaN
  let startup: Record<string, number> = {}
  let eagerModules: string[] = []
  if (!existsSync(main)) {
    console.log('Skipping the app benchmark: build it first (pnpm build).')
  } else {
    const launchArgs = [main]
    if (process.platform === 'linux') launchArgs.unshift('--no-sandbox')
    const start = () => electron.launch({
      args: launchArgs,
      env: {
        ...process.env,
        GITGOOSE_OPEN: cache,
        GITGOOSE_USER_DATA: mkdtempSync(join(tmpdir(), 'gitgoose-bench-')),
        GITGOOSE_NO_UPDATE: '1',
      } as Record<string, string>,
    })
    // One throwaway launch first: on a fresh CI machine the first start also reads Electron's
    // 230 MB binary from a cold disk, which is not what a user's second start of the day costs
    // (CI measured 1.5 s one run and 3.5 s the next, with nothing changed).
    const warm = await start()
    await (await warm.firstWindow()).getByTestId('commit-row').first().waitFor()
    await warm.close()
    const t0 = performance.now()
    const app = await start()
    const page = await app.firstWindow()
    await page.getByTestId('commit-row').first().waitFor()
    appFirstPaintMs = performance.now() - t0
    startup = await startupTimeline(app, page)
    eagerModules = staticImports(main).filter((m) => LAZY_MODULES.includes(m))

    // Scroll the graph continuously for two seconds and count animation frames.
    // Passed as a string: tsx rewrites named functions with a helper that does not exist in the page.
    idleFps = (await page.evaluate(fpsProbe('graph-scroll', 0))) as number
    scrollFps = (await page.evaluate(fpsProbe('graph-scroll', 120))) as number
    await app.close()
  }

  // 4. the sidebar with thousands of refs
  const sidebar = existsSync(main) ? await sidebarBench(main) : { firstPaintMs: NaN, refs: NaN, rows: NaN, domRows: NaN, scrollFps: NaN }

  const results = {
    commits: all.commits.length,
    maxLanes,
    coldFirstPageMs: round(coldFirstPageMs),
    firstPageMs: round(firstPageMs),
    coldTopoFirstPageMs: round(coldTopoFirstPageMs),
    topoFirstPageMs: round(topoFirstPageMs),
    fullLogMs: round(fullLogMs),
    layoutAllMs: round(layoutAllMs),
    appFirstPaintMs: round(appFirstPaintMs),
    ...startup,
    mainEagerModules: eagerModules.join(', ') || 'none',
    idleFps: round(idleFps),
    scrollFps: round(scrollFps),
    sidebarRefs: sidebar.refs,
    sidebarRows: sidebar.rows,
    sidebarDomRows: sidebar.domRows,
    sidebarFirstPaintMs: round(sidebar.firstPaintMs),
    sidebarScrollFps: round(sidebar.scrollFps),
    platform: `${process.platform}-${process.arch}`,
    date: new Date().toISOString(),
  }
  console.table(results)
  mkdirSync(join(root, 'bench-results'), { recursive: true })
  writeFileSync(join(root, 'bench-results', 'latest.json'), JSON.stringify(results, null, 2))

  if (flag('--check')) {
    const failures: string[] = []
    if (results.firstPageMs > BUDGET.firstPageMs) failures.push(`first log page ${results.firstPageMs} ms > ${BUDGET.firstPageMs} ms`)
    // With the commit-graph the app writes, topological order must start as fast as date order.
    if (results.topoFirstPageMs > BUDGET.firstPageMs) failures.push(`first log page, topological ${results.topoFirstPageMs} ms > ${BUDGET.firstPageMs} ms`)
    if (results.layoutAllMs > BUDGET.layoutAllMs) failures.push(`layout ${results.layoutAllMs} ms > ${BUDGET.layoutAllMs} ms`)
    if (results.appFirstPaintMs > BUDGET.appFirstPaintMs) failures.push(`app first paint ${results.appFirstPaintMs} ms > ${BUDGET.appFirstPaintMs} ms`)
    if (eagerModules.length) failures.push(`the main process loads ${eagerModules.join(', ')} before its window opens (import them where they are used)`)
    // Scrolling must keep up with what the machine can draw at all, minus a little slack.
    const fpsBudget = Math.min(BUDGET.scrollFps, results.idleFps * 0.9)
    if (results.scrollFps < fpsBudget) failures.push(`scroll ${results.scrollFps} fps < ${round(fpsBudget)} fps (idle: ${results.idleFps})`)
    if (results.sidebarScrollFps < fpsBudget) failures.push(`sidebar scroll ${results.sidebarScrollFps} fps < ${round(fpsBudget)} fps (idle: ${results.idleFps})`)
    if (results.sidebarFirstPaintMs > BUDGET.sidebarFirstPaintMs) failures.push(`sidebar first paint ${results.sidebarFirstPaintMs} ms > ${BUDGET.sidebarFirstPaintMs} ms`)
    if (results.sidebarDomRows > BUDGET.sidebarDomRows) failures.push(`sidebar keeps ${results.sidebarDomRows} rows in the DOM > ${BUDGET.sidebarDomRows} (is it still virtualized?)`)
    if (failures.length) {
      console.error('Performance budget missed:\n  ' + failures.join('\n  '))
      process.exit(1)
    }
    console.log('All performance budgets met.')
  }
}

/**
 * Where the startup time went, in ms from the main process's start: the performance marks the
 * main process and the window set (gitgoose:*), the window's first contentful paint, the first
 * page of the log and the frame that draws its rows. Main and renderer clocks are put on one
 * line through their timeOrigin.
 */
async function startupTimeline(app: Awaited<ReturnType<typeof electron.launch>>, page: Page): Promise<Record<string, number>> {
  await page.waitForFunction(() => performance.getEntriesByName('gitgoose:rows').length > 0)
  const main = await app.evaluate(() => ({ origin: performance.timeOrigin, marks: performance.getEntriesByType('mark').map((m) => [m.name, m.startTime] as const) }))
  const win = (await page.evaluate(`({
    origin: performance.timeOrigin,
    marks: performance.getEntriesByType('mark').map((m) => [m.name, m.startTime]),
    fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? NaN,
  })`)) as { origin: number; marks: [string, number][]; fcp: number }
  const fromMain = (t: number) => round(win.origin + t - main.origin)
  const first = (name: string) => win.marks.find(([n]) => n === `gitgoose:${name}`)?.[1] ?? NaN
  const at = (name: string) => round(main.marks.find(([n]) => n === `gitgoose:${name}`)?.[1] ?? NaN)
  return {
    startMainLoadedMs: at('main-loaded'),
    startReadyMs: at('ready'),
    startWindowMs: at('create-window'),
    startReadyToShowMs: at('ready-to-show'),
    startFirstPaintMs: fromMain(win.fcp),
    startSettingsMs: fromMain(first('settings')),
    startSnapshotMs: fromMain(first('snapshot')),
    startFirstPageMs: fromMain(first('first-page')),
    startRowsMs: fromMain(first('rows')),
  }
}

/**
 * Count animation frames for two seconds while scrolling an element SCROLL px per frame, going
 * back to the top when it reaches the end. With SCROLL = 0 it measures the idle frame rate: the
 * ceiling this machine can reach at all (a VM without a GPU may never hit 60), which is what
 * scrolling should be compared against.
 */
function fpsProbe(testId: string, scroll: number): string {
  return `(async () => {
  const el = document.querySelector('[data-testid="${testId}"]')
  let frames = 0
  const start = performance.now()
  await new Promise((done) => {
    const tick = (now) => {
      frames++
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) el.scrollTop = 0
      else el.scrollTop += ${scroll}
      if (now - start < 2000) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })
  return frames / ((performance.now() - start) / 1000)
})()`
}

/**
 * The dev repository (3,000 realistic commits) plus SIDEBAR_REFS generated refs: half branches
 * in 25 team folders, half tags, spread over the history. Cached in .fixtures/ like the big repo.
 */
function sidebarRepo(): string {
  const dir = join(root, '.fixtures', `sidebar-${SIDEBAR_REFS}`)
  if (existsSync(join(dir, '.git'))) return dir
  console.log(`Generating the dev repository with ${SIDEBAR_REFS.toLocaleString()} branches and tags (cached in .fixtures/)…`)
  makeDevRepo({ commits: 3000, dir, remotesDir: join(root, '.fixtures', `sidebar-${SIDEBAR_REFS}-remotes`) })
  const hashes = execFileSync('git', ['rev-list', '--all', '-n', '3000'], { cwd: dir, encoding: 'utf8' }).trim().split('\n')
  const lines: string[] = []
  for (let i = 0; i < SIDEBAR_REFS / 2; i++) {
    const at = hashes[(i * 7) % hashes.length]
    lines.push(`create refs/heads/team-${i % 25}/topic-${i} ${at}`, `create refs/tags/build-${i} ${at}`)
  }
  execFileSync('git', ['update-ref', '--stdin'], { cwd: dir, input: lines.join('\n') + '\n' })
  return dir
}

async function sidebarBench(main: string) {
  const dir = sidebarRepo()
  const launchArgs = [main]
  if (process.platform === 'linux') launchArgs.unshift('--no-sandbox')
  const t0 = performance.now()
  const app = await electron.launch({
    args: launchArgs,
    env: { ...process.env, GITGOOSE_OPEN: dir, GITGOOSE_USER_DATA: mkdtempSync(join(tmpdir(), 'gitgoose-bench-')), GITGOOSE_NO_UPDATE: '1' } as Record<string, string>,
  })
  const page: Page = await app.firstWindow()
  await page.getByTestId('sidebar-ref').first().waitFor()
  const firstPaintMs = performance.now() - t0
  // Everything open: every tag listed and the Tags section unfolded. (Tags sit below a thousand
  // branches, so their header is not in the DOM to click: the virtualizer only renders the screen.)
  // Sidebar state is kept by the repository's path, as git reports it (symlinks resolved).
  const path = realpathSync(dir)
  await page.evaluate(`window.gitgoose.setSettings({ sidebarTags: 'all', sidebar: { ${JSON.stringify(path)}: { open: { 'section:tags': true } } } })`)
  const refs = execFileSync('git', ['for-each-ref', '--format=x'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').length
  const height = () => page.evaluate('document.querySelector(\'[data-testid="sidebar"] > div\').getBoundingClientRect().height') as Promise<number>
  // Wait until the list holds every ref (24 px a row).
  for (let i = 0; i < 100 && (await height()) < refs * 24; i++) await page.waitForTimeout(100)
  const total = await height()
  const domRows = await page.locator('[data-testid="sidebar"] > div > *').count()
  const scrollFps = (await page.evaluate(fpsProbe('sidebar', 120))) as number
  await app.close()
  // Rows are 24 px (headers 28): the list's height says how many rows it has.
  return { firstPaintMs, refs, rows: Math.round(total / 24), domRows, scrollFps }
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
