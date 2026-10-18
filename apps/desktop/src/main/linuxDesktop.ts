import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * On Linux the window's icon is not a property of the window. The desktop (GNOME, KDE) shows
 * the icon of the .desktop entry whose name matches the window's app_id, which Electron takes
 * from `app.setDesktopName`. Packaged builds ship that entry (electron-builder's
 * syncDesktopName); from the source tree nothing does, so `pnpm dev` writes one into the user's
 * applications directory that points at build/icon.png and relaunches `pnpm dev`.
 */
export const DESKTOP_NAME = 'gitgoose.desktop'

export function devDesktopEntry(opts: { icon: string; repo: string }): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=GitGoose (dev)',
    'Comment=GitGoose from the source tree, with hot reload',
    'Exec=pnpm dev',
    `Path=${opts.repo}`,
    `Icon=${opts.icon}`,
    'Terminal=false',
    'Categories=Development;',
    `StartupWMClass=${DESKTOP_NAME.replace(/\.desktop$/, '')}`,
    '',
  ].join('\n')
}

/** The user's applications directory, per the XDG base directory spec. */
export function applicationsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications')
}

/** Write the entry if it is missing or stale; returns whether anything was written. */
export function installDevDesktopEntry(opts: { icon: string; repo: string; dir?: string }): boolean {
  const dir = opts.dir ?? applicationsDir()
  const file = join(dir, DESKTOP_NAME)
  const content = devDesktopEntry(opts)
  let current: string | null = null
  try { current = readFileSync(file, 'utf8') } catch { /* not there yet */ }
  if (current === content) return false
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, content)
  return true
}
