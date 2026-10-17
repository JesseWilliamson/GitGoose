import { commandArgv } from '@gitsquid/shared'
import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { getSettings } from './settings'

/** Start a program detached from the app, so closing GitSquid does not close the editor. */
function launch(argv: string[], cwd?: string): Promise<void> {
  const [cmd, ...args] = argv
  if (!cmd) return Promise.reject(new Error('The command is empty'))
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd, detached: true, stdio: 'ignore',
      // Windows editors are often .cmd shims (code.cmd), which only start through a shell.
      shell: process.platform === 'win32',
    })
    child.once('error', (e) => reject(new Error(`Could not start ${cmd}: ${e.message}`)))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export async function openInEditor(path: string, line = 1): Promise<void> {
  const template = getSettings().editorCommand.trim()
  if (!template) {
    const err = await shell.openPath(path)
    if (err) throw new Error(err)
    return
  }
  await launch(commandArgv(template, { file: path, line: String(line) }, 'file'))
}

function onPath(cmd: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, cmd)))
}

function defaultTerminal(): string[] {
  if (process.platform === 'darwin') return ['open', '-a', 'Terminal', '{dir}']
  if (process.platform === 'win32') return ['cmd.exe', '/c', 'start', 'cmd.exe']
  for (const t of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'kitty', 'alacritty', 'xterm']) {
    if (onPath(t)) return [t]
  }
  throw new Error('No terminal found. Set one in Settings → Integrations.')
}

export async function openTerminal(dir: string): Promise<void> {
  const template = getSettings().terminalCommand.trim()
  const argv = template ? commandArgv(template, { dir }) : defaultTerminal().map((a) => a.replace('{dir}', dir))
  await launch(argv, dir)
}
