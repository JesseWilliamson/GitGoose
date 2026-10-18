import { AskpassServer } from '@gitgoose/git'
import { DEFAULT_AVATAR_BASES } from '@gitgoose/shared'
import { app, BrowserWindow, nativeTheme, net, protocol, safeStorage } from 'electron'
import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { AiService } from './ai/service'
import { SecretFile } from './ai/keyStore'
import { AvatarCache } from './avatars'
import { CodeGraphService } from './codegraph'
import { githubEndpoints } from './github/config'
import { GitHubService } from './github/service'
import { TokenStore } from './github/tokenStore'
import { installCrashHandlers } from './diagnostics'
import { broadcast, createHandlers, registerIpc } from './ipc'
import { DESKTOP_NAME, installDevDesktopEntry } from './linuxDesktop'
import { installMenu } from './menu'
import { RepoManager } from './repos'
import { applyZoom, getSettings, onSettingsChanged, setSettings } from './settings'
import { scheduleUpdateCheck } from './updater'
import { loadWindowState, trackWindowState } from './windowState'

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

// ------------------------------------------------------------ credential prompts

// ------------------------------------------------------------ GitHub sign-in

/** One environment object shared by every repository's GitRunner, updated in place. */
const gitEnv: Record<string, string> = {}
let credentialKeys: string[] = []
/** Switch the github.com credential-helper override on or off for every open repository. */
function refreshCredentialEnv(): void {
  for (const k of credentialKeys) delete gitEnv[k]
  const extra = github.credentialEnv()
  credentialKeys = Object.keys(extra)
  Object.assign(gitEnv, extra)
}

// Linux without a secret service falls back to a hard-coded key ("basic_text"): no better than
// plain text, so secrets then stay in memory only.
const keychain = {
  secure: () => safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'),
  encrypt: (s: string) => safeStorage.encryptString(s),
  decrypt: (b: Buffer) => safeStorage.decryptString(b),
}

const github = new GitHubService({
  endpoints: githubEndpoints(),
  store: new TokenStore(join(app.getPath('userData'), 'github.json'), keychain),
  // Electron's net uses Chromium's network stack: the system proxy settings apply.
  fetch: (input, init) => net.fetch(input instanceof Request ? input : String(input), init),
  repos: () => repos.all(),
  httpsEnabled: () => getSettings().githubHttps,
  onChange: (status) => {
    refreshCredentialEnv()
    broadcast({ type: 'github', status })
  },
})

const avatars = new AvatarCache({
  dir: join(app.getPath('userData'), 'avatars'),
  source: () => getSettings().avatars,
  // Tests point these at a local server; nothing else should.
  bases: {
    github: process.env.GITGOOSE_AVATAR_GITHUB_BASE ?? DEFAULT_AVATAR_BASES.github,
    gravatar: process.env.GITGOOSE_AVATAR_GRAVATAR_BASE ?? DEFAULT_AVATAR_BASES.gravatar,
  },
  resolve: (email) => github.resolveAvatar(email),
  variant: () => github.avatarVariant(),
})


let nextPrompt = 1
const pending = new Map<number, (answer: string | null) => void>()
const prompts = {
  ask(message: string, secret: boolean): Promise<string | null> {
    // github.com over HTTPS, signed in with repository access and the setting on: no dialog.
    const known = github.answerPrompt(message)
    if (known !== null) return Promise.resolve(known)
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

const gitOpts = () => ({ gitPath: getSettings().gitPath || 'git', env: gitEnv, showStashes: getSettings().showStashes, graphFilters: getSettings().graphFilters })

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

// The code graph (ADR-008): parsed in a utility process, one database per repository.
const codegraph = new CodeGraphService({
  dir: join(app.getPath('userData'), 'codegraph'),
  modulePath: join(here, 'indexer.js'),
  grammarDir: app.isPackaged ? join(process.resourcesPath, 'grammars') : null,
  gitOpts,
  enabled: () => getSettings().codeGraph,
  emit: (repoId, status) => broadcast({ type: 'codegraph', repoId, status }),
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

let lastShowStashes = getSettings().showStashes
let lastCodeGraph = getSettings().codeGraph
onSettingsChanged((settings) => {
  refreshCredentialEnv()
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
  broadcast({ type: 'settings', settings })
})

app.whenReady().then(async () => {
  try {
    Object.assign(gitEnv, await askpass.start())
  } catch {
    // Without askpass, git falls back to the user's credential helpers.
  }
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
  // gitgoose-avatar://author/<email> -> image bytes (or a transparent pixel; see avatars.ts).
  protocol.handle('gitgoose-avatar', async (req) => {
    const email = decodeURIComponent(new URL(req.url).pathname.slice(1))
    const img = await avatars.get(email)
    return new Response(new Uint8Array(img.body), { headers: { 'content-type': img.type, 'cache-control': 'max-age=3600' } })
  })
  refreshCredentialEnv()
  registerIpc(createHandlers(repos, prompts, gitOpts, github, ai, codegraph), repos)
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
  codegraph.dispose()
  askpass.stop()
  ai.stop()
  void repos.closeAll()
})
