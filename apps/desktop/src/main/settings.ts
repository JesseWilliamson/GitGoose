import { migrateSettings, validatePatch, type Settings } from '@gitgoose/shared'
import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

let cache: Settings | null = null
const listeners = new Set<(s: Settings, changed: Set<string>) => void>()

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** Settings from disk, migrated and validated. A broken file never stops the app from starting. */
export function getSettings(): Settings {
  if (cache) return cache
  let stored: Record<string, unknown> = {}
  try {
    stored = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>
  } catch {
    // Missing or unreadable: defaults.
  }
  cache = migrateSettings(stored)
  return cache
}

export function setSettings(patch: Partial<Settings>): Settings {
  const clean = validatePatch(patch as Record<string, unknown>)
  const before = getSettings()
  cache = { ...before, ...clean }
  mkdirSync(dirname(file()), { recursive: true })
  // Write then rename, so a crash mid-write cannot leave a half-written settings file.
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(cache, null, 2))
  renameSync(tmp, file())
  const changed = new Set(Object.keys(clean).filter((k) => JSON.stringify(before[k as keyof Settings]) !== JSON.stringify(cache![k as keyof Settings])))
  if (changed.size) for (const l of listeners) l(cache, changed)
  return cache
}

export function onSettingsChanged(l: (s: Settings, changed: Set<string>) => void): void {
  listeners.add(l)
}

export function rememberRepo(path: string): void {
  const s = getSettings()
  setSettings({
    recentRepos: [path, ...s.recentRepos.filter((p) => p !== path)].slice(0, 20),
    openRepos: s.openRepos.includes(path) ? s.openRepos : [...s.openRepos, path],
  })
}

export function forgetOpenRepo(path: string): void {
  const s = getSettings()
  setSettings({ openRepos: s.openRepos.filter((p) => p !== path) })
}

/**
 * UI scale is Chromium's zoom factor. It scales every CSS pixel, so text, icons, SVG strokes and
 * the virtualized row heights all grow together without any component knowing about it.
 */
export function applyZoom(win: BrowserWindow): void {
  win.webContents.setZoomFactor(getSettings().uiScale)
}

onSettingsChanged((s, changed) => {
  if (!changed.has('uiScale')) return
  for (const w of BrowserWindow.getAllWindows()) w.webContents.setZoomFactor(s.uiScale)
})
