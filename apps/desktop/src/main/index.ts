import { AskpassServer } from '@gitgoose/git'
import { DEFAULT_AVATAR_BASE } from '@gitgoose/shared'
import { app, BrowserWindow, nativeTheme, net, protocol, safeStorage } from 'electron'
import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { AiService } from './ai/service'
import { SecretFile } from './ai/keyStore'
import { AvatarCache } from './avatars'
import { CodeGraphService } from './codegraph'
import { githubEndpoints } from './github/config'
import { GitHubService } from './github/service'
import { installCrashHandlers } from './diagnostics'
import { broadcast, createHandlers, registerIpc } from './ipc'
import { DESKTOP_NAME, installDevDesktopEntry } from './linuxDesktop'
import { installMenu } from './menu'
import { RepoManager } from './repos'
import { applyZoom, getSettings, onSettingsChanged, setSettings } from './settings'
import { scheduleUpdateCheck } from './updater'
import { loadWindowState, OVERLAY_DARK, OVERLAY_LIGHT, TITLE_BAR_HEIGHT, trackWindowState } from './windowState'

// Startup timeline (read by tools/bench): every import above has been evaluated by now.
performance.mark('gitgoose:main-loaded')

// Tests and the benchmark point the app at a throwaway profile.
if (process.env.GITGOOSE_USER_DATA) app.setPath('userData', process.env.GITGOOSE_USER_DATA)

installCrashHandlers()

// Custom schemes must be declared before the app is ready. "secure" lets the page (whose CSP
// allows gitgoose-avatar:) load from it like any https image.
protocol.registerSchemesAsPrivileged([
  { scheme: 'gitgoose-avatar', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const here = import.meta.dirname
/** The app icon; the window carries it on Linux and Windows (macOS takes it from the bundle). */
const iconPath = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(here, '../../build/icon.png')

// On Linux the desktop shows the icon of the .desktop entry matching the window's app_id, which
// comes from this name (see linuxDesktop.ts). From the source tree, `pnpm dev` also writes that
// entry so the dev window gets the goose too.
app.setDesktopName(DESKTOP_NAME)
if (process.platform === 'linux' && process.env.ELECTRON_RENDERER_URL) {
  try {
    installDevDesktopEntry({ icon: iconPath, repo: resolve(here, '../../../..') })
  } catch (e) {
    console.warn('Could not write the dev desktop entry:', e)
  }
}

/** One environment object shared by every repository's GitRunner (askpass adds to it at start). */
const gitEnv: Record<string, string> = {}

// Linux without a secret service falls back to a hard-coded key ("basic_text"): no better than
// plain text, so secrets then stay in memory only.
const keychain = {
  secure: () => safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'),
  encrypt: (s: string) => safeStorage.encryptString(s),
  decrypt: (b: Buffer) => safeStorage.decryptString(b),
}

// ------------------------------------------------------------ GitHub (no sign-in) and avatars

const github = new GitHubService({
  endpoints: githubEndpoints(),
  // Electron's net uses Chromium's network stack: the system proxy settings apply.
  fetch: (input, init) => net.fetch(input instanceof Request ? input : String(input), init),
  repos: () => repos.all(),
})

const avatars = new AvatarCache({
  dir: join(app.getPath('userData'), 'avatars'),
  source: () => getSettings().avatars,
  lookup: (email) => github.authorAvatar(email),
  // Tests point this at a local server; nothing else should.
  avatarBase: process.env.GITGOOSE_AVATAR_GITHUB_BASE ?? DEFAULT_AVATAR_BASE,
})

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

const gitOpts = () => ({ gitPath: getSettings().gitPath || 'git', env: gitEnv, showStashes: getSettings().showStashes, commitOrder: getSettings().commitOrder, graphFilters: getSettings().graphFilters })

// ------------------------------------------------------------ AI

const ai = new AiService({
  settings: getSettings,
  setSettings: (patch) => void setSettings(patch),
  repo: (id) => repos.get(id),
  apiKey: new SecretFile(join(app.getPath('userData'), 'anthropic-key.bin'), keychain),
  emit: (event) => broadcast(event),
  // Tests point this at a local fake; nothing else should.
  anthropicBaseURL: process.env.GITGOOSE_ANTHROPIC_BASE_URL,
})

// The code graph: parsed in a utility process, one database per repository.
const codegraph = new CodeGraphService({
  dir: join(app.getPath('userData'), 'codegraph'),
  modulePath: join(here, 'indexer.js'),
  grammarDir: app.isPackaged ? join(process.resourcesPath, 'grammars') : null,
  gitOpts,
  enabled: () => getSettings().codeGraph,
  emit: (repoId, status) => broadcast({ type: 'codegraph', repoId, status }),
  // Like the commit-graph upkeep (repos.ts): after the first screen is up.
  startDelay: 1500,
})

const repos = new RepoManager(
  gitOpts,
  (snapshot) => {
    broadcast({ type: 'snapshot', snapshot })
    codegraph.onSnapshot(snapshot.id, snapshot)
  },
  (repoId, text) => broadcast({ type: 'progress', repoId, text }),
  (repoId) => {
    broadcast({ type: 'worktree', repoId })
    codegraph.onWorktree(repoId)
  },
  { opened: (repo) => codegraph.open(repo), closed: (id) => codegraph.close(id) },
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
    title: 'GitGoose',
    ...(process.platform === 'darwin' ? {} : { icon: iconPath }),
    backgroundColor: dark || getSettings().theme === 'dark' ? '#171719' : '#ffffff',
    // The tab bar row is the title bar everywhere. Windows keeps the OS-drawn caption buttons
    // (titleBarOverlay: Snap Layouts); Linux draws its own in the renderer (TabBar.tsx).
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : { autoHideMenuBar: true }),
    ...(process.platform === 'win32'
      ? { titleBarOverlay: { ...(dark || getSettings().theme === 'dark' ? OVERLAY_DARK : OVERLAY_LIGHT), height: TITLE_BAR_HEIGHT } }
      : {}),
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
    performance.mark('gitgoose:ready-to-show')
    if (saved?.maximized) win.maximize()
    win.show()
  })
  trackWindowState(win)
  const sendState = () => !win.isDestroyed() && broadcast({ type: 'window-state', maximized: win.isMaximized() })
  win.on('maximize', sendState)
  win.on('unmaximize', sendState)
  win.on('enter-full-screen', sendState)
  win.on('leave-full-screen', sendState)
  // Refresh on focus: catches changes made by other tools when the watcher is unavailable.
  win.on('focus', () => repos.refreshAll())
  // Links open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void import('electron').then(({ shell }) => shell.openExternal(url))
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  // Back and forward (the renderer's history, lib/navigation.ts): the mouse's side buttons as
  // Windows and Linux report them to the window, and a three-finger swipe on macOS. The page sees
  // the side buttons too and drops whichever report of a click comes second.
  win.on('app-command', (_e, command) => {
    if (command === 'browser-backward') broadcast({ type: 'command', name: 'back' })
    else if (command === 'browser-forward') broadcast({ type: 'command', name: 'forward' })
  })
  win.on('swipe', (_e, direction) => {
    if (direction === 'left') broadcast({ type: 'command', name: 'back' })
    else if (direction === 'right') broadcast({ type: 'command', name: 'forward' })
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(here, '../renderer/index.html'))
  return win
}

let lastShowStashes = getSettings().showStashes
let lastCommitOrder = getSettings().commitOrder
let lastCodeGraph = getSettings().codeGraph
onSettingsChanged((settings, changed) => {
  // Saved AI conversations are read through aiThreads, not settings: a saved turn is no reason
  // to send every window the whole settings file (threads and all) again.
  if (changed.size === 1 && changed.has('aiThreads')) return
  ai.onSettings()
  if (settings.codeGraph !== lastCodeGraph) {
    lastCodeGraph = settings.codeGraph
    for (const repo of repos.all()) {
      codegraph.close(repo.id)
      codegraph.open(repo)
    }
  }
  if (settings.showStashes !== lastShowStashes) {
    lastShowStashes = settings.showStashes
    for (const repo of repos.all()) repo.setShowStashes(settings.showStashes)
    repos.refreshAll()
  }
  // A new order is a new walk: each repository restarts its log and the renderer reloads it once.
  if (settings.commitOrder !== lastCommitOrder) {
    lastCommitOrder = settings.commitOrder
    for (const repo of repos.all()) repo.setCommitOrder(settings.commitOrder)
    repos.refreshAll()
  }
  broadcast({ type: 'settings', settings })
})

app.whenReady().then(() => {
  performance.mark('gitgoose:ready')
  // The credential prompt server starts alongside the window rather than before it. Only
  // commands that talk to a remote can prompt, and IPC waits for it (registerIpc below), so no
  // request from the window can run git without it.
  const askpassReady = askpass.start().then(
    (env) => void Object.assign(gitEnv, env),
    // Without askpass, git falls back to the user's credential helpers.
    () => {},
  )
  // `gitgoose repo1 repo2` or GITGOOSE_OPEN=repo1:repo2 (; on Windows) opens those repositories
  // as tabs instead of restoring the last session. Used from a shell, by tests and by the benchmark.
  const paths = process.env.GITGOOSE_OPEN
    ? process.env.GITGOOSE_OPEN.split(delimiter).filter(Boolean)
    : process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'))
  if (paths.length) setSettings({ openRepos: paths.map((p) => resolve(p)) })
  else if (!getSettings().reopenTabs) setSettings({ openRepos: [] })
  // `pnpm dev` with nothing open: open the generated development repository (pnpm dev:repo).
  const devRepo = resolve(app.getAppPath(), '../../.fixtures/dev-repo')
  if (process.env.ELECTRON_RENDERER_URL && !paths.length && !getSettings().openRepos.length && getSettings().openDevRepo && existsSync(join(devRepo, '.git'))) {
    setSettings({ openRepos: [devRepo] })
  }
  // gitgoose-avatar://author/<email> -> image bytes, or 404 for a miss (see avatars.ts): the
  // page's <img> then fails and the initials stay.
  protocol.handle('gitgoose-avatar', async (req) => {
    const email = decodeURIComponent(new URL(req.url).pathname.slice(1))
    const img = await avatars.get(email).catch(() => null)
    if (!img) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(img.body), { headers: { 'content-type': img.type, 'cache-control': 'max-age=3600' } })
  })
  registerIpc(createHandlers(repos, prompts, gitOpts, github, ai, codegraph), repos, askpassReady)
  installMenu()
  performance.mark('gitgoose:create-window')
  createWindow()
  // The window will ask for these tabs as soon as it has loaded: open them while it loads.
  for (const path of getSettings().openRepos) repos.preopen(path)
  scheduleUpdateCheck()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  codegraph.dispose()
  askpass.stop()
  ai.stop()
  void repos.closeAll()
})
