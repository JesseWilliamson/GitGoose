import { AskpassServer } from '@gitsquid/git'
import { DEFAULT_AVATAR_BASES } from '@gitsquid/shared'
import { app, BrowserWindow, nativeTheme, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { AvatarCache } from './avatars'
import { installCrashHandlers } from './diagnostics'
import { broadcast, createHandlers, registerIpc } from './ipc'
import { installMenu } from './menu'
import { RepoManager } from './repos'
import { applyZoom, getSettings, onSettingsChanged, setSettings } from './settings'
import { scheduleUpdateCheck } from './updater'
import { loadWindowState, trackWindowState } from './windowState'

// Tests and the benchmark point the app at a throwaway profile.
if (process.env.GITSQUID_USER_DATA) app.setPath('userData', process.env.GITSQUID_USER_DATA)

installCrashHandlers()

// Custom schemes must be declared before the app is ready. "secure" lets the page (whose CSP
// allows gitsquid-avatar:) load from it like any https image.
protocol.registerSchemesAsPrivileged([
  { scheme: 'gitsquid-avatar', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const avatars = new AvatarCache({
  dir: join(app.getPath('userData'), 'avatars'),
  source: () => getSettings().avatars,
  // Tests point these at a local server; nothing else should.
  bases: {
    github: process.env.GITSQUID_AVATAR_GITHUB_BASE ?? DEFAULT_AVATAR_BASES.github,
    gravatar: process.env.GITSQUID_AVATAR_GRAVATAR_BASE ?? DEFAULT_AVATAR_BASES.gravatar,
  },
})

const here = import.meta.dirname

// ------------------------------------------------------------ credential prompts

let nextPrompt = 1
const pending = new Map<number, (answer: string | null) => void>()
const prompts = {
  ask(message: string, secret: boolean): Promise<string | null> {
    const promptId = nextPrompt++
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), 5 * 60_000)
      const finish = (answer: string | null) => {
        clearTimeout(timer)
        pending.delete(promptId)
        resolve(answer)
      }
      pending.set(promptId, finish)
      broadcast({ type: 'prompt', promptId, repoId: null, message, secret })
    })
  },
  respond(id: number, answer: string | null) {
    pending.get(id)?.(answer)
  },
}
const askpass = new AskpassServer((message, secret) => prompts.ask(message, secret))
let askpassEnv: Record<string, string> = {}

const gitOpts = () => ({ gitPath: getSettings().gitPath || 'git', env: askpassEnv })

const repos = new RepoManager(
  gitOpts,
  (snapshot) => broadcast({ type: 'snapshot', snapshot }),
  (repoId, text) => broadcast({ type: 'progress', repoId, text }),
  (repoId) => broadcast({ type: 'worktree', repoId }),
)

// ------------------------------------------------------------ window

function createWindow(): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors && getSettings().theme !== 'light'
  const saved = loadWindowState()
  const win = new BrowserWindow({
    width: saved?.bounds.width ?? 1440,
    height: saved?.bounds.height ?? 900,
    ...(saved ? { x: saved.bounds.x, y: saved.bounds.y } : {}),
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'GitSquid',
    backgroundColor: dark || getSettings().theme === 'dark' ? '#16181d' : '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  })
  // Ctrl+wheel and pinch would change the zoom behind the UI scale setting's back.
  win.webContents.on('did-finish-load', () => {
    applyZoom(win)
    void win.webContents.setVisualZoomLevelLimits(1, 1)
  })
  win.once('ready-to-show', () => {
    if (saved?.maximized) win.maximize()
    win.show()
  })
  trackWindowState(win)
  // Refresh on focus: catches changes made by other tools when the watcher is unavailable.
  win.on('focus', () => repos.refreshAll())
  // Links open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void import('electron').then(({ shell }) => shell.openExternal(url))
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(here, '../renderer/index.html'))
  return win
}

onSettingsChanged((settings) => broadcast({ type: 'settings', settings }))

app.whenReady().then(async () => {
  try {
    askpassEnv = await askpass.start()
  } catch {
    // Without askpass, git falls back to the user's credential helpers.
  }
  // `gitsquid repo1 repo2` or GITSQUID_OPEN=repo1:repo2 (; on Windows) opens those repositories
  // as tabs instead of restoring the last session. Used from a shell, by tests and by the benchmark.
  const paths = process.env.GITSQUID_OPEN
    ? process.env.GITSQUID_OPEN.split(delimiter).filter(Boolean)
    : process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'))
  if (paths.length) setSettings({ openRepos: paths.map((p) => resolve(p)) })
  else if (!getSettings().reopenTabs) setSettings({ openRepos: [] })
  // `pnpm dev` with nothing open: open the generated development repository (pnpm dev:repo).
  const devRepo = resolve(app.getAppPath(), '../../.fixtures/dev-repo')
  if (process.env.ELECTRON_RENDERER_URL && !paths.length && !getSettings().openRepos.length && getSettings().openDevRepo && existsSync(join(devRepo, '.git'))) {
    setSettings({ openRepos: [devRepo] })
  }
  // gitsquid-avatar://author/<email> -> image bytes (or a transparent pixel; see avatars.ts).
  protocol.handle('gitsquid-avatar', async (req) => {
    const email = decodeURIComponent(new URL(req.url).pathname.slice(1))
    const img = await avatars.get(email)
    return new Response(new Uint8Array(img.body), { headers: { 'content-type': img.type, 'cache-control': 'max-age=3600' } })
  })
  registerIpc(createHandlers(repos, prompts, gitOpts), repos)
  installMenu()
  createWindow()
  scheduleUpdateCheck()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  askpass.stop()
  void repos.closeAll()
})
