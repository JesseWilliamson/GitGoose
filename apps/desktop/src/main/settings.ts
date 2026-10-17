import type { Settings } from '@gitsquid/shared'
import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DEFAULTS: Settings = {
  gitPath: 'git',
  theme: 'system',
  fontSize: 13,
  recentRepos: [],
  openRepos: [],
}

let cache: Settings | null = null

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): Settings {
  if (cache) return cache
  try {
    cache = { ...DEFAULTS, ...(JSON.parse(readFileSync(file(), 'utf8')) as Partial<Settings>) }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export function setSettings(patch: Partial<Settings>): Settings {
  cache = { ...getSettings(), ...patch }
  mkdirSync(dirname(file()), { recursive: true })
  writeFileSync(file(), JSON.stringify(cache, null, 2))
  return cache
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
