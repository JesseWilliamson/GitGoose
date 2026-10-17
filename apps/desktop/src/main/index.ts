import { AskpassServer } from '@gitsquid/git'
import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'
import { installCrashHandlers } from './diagnostics'
import { broadcast, createHandlers, registerIpc } from './ipc'
import { installMenu } from './menu'
import { RepoManager } from './repos'
import { getSettings, setSettings } from './settings'
import { scheduleUpdateCheck } from './updater'

// Tests and the benchmark point the app at a throwaway profile.
if (process.env.GITSQUID_USER_DATA) app.setPath('userData', process.env.GITSQUID_USER_DATA)

installCrashHandlers()

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
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
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
  win.once('ready-to-show', () => win.show())
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

app.whenReady().then(async () => {
  try {
    askpassEnv = await askpass.start()
  } catch {
    // Without askpass, git falls back to the user's credential helpers.
  }
  // `GITSQUID_OPEN=/path` or a path argument opens that repository (tests, the benchmark, shell use).
  const argPath = process.env.GITSQUID_OPEN ?? process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-'))
  if (argPath) setSettings({ openRepos: [argPath] })
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
