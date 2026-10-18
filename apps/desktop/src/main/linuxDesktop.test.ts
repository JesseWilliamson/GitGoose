import { tempDir } from '@gitgoose/fixtures'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applicationsDir, installDevDesktopEntry } from './linuxDesktop'

describe('dev desktop entry', () => {
  it('writes an entry whose name matches the app_id and points at the icon, once', () => {
    const dir = join(tempDir('gitgoose-apps-'), 'applications')
    const opts = { icon: '/src/build/icon.png', repo: '/src', dir }
    expect(installDevDesktopEntry(opts)).toBe(true)
    const text = readFileSync(join(dir, 'gitgoose.desktop'), 'utf8')
    expect(text).toContain('Icon=/src/build/icon.png')
    expect(text).toContain('Path=/src')
    expect(text).toContain('StartupWMClass=gitgoose')
    expect(text.startsWith('[Desktop Entry]\n')).toBe(true)
    // Same content: left alone. Changed icon path: rewritten.
    expect(installDevDesktopEntry(opts)).toBe(false)
    expect(installDevDesktopEntry({ ...opts, icon: '/elsewhere/icon.png' })).toBe(true)
    expect(readFileSync(join(dir, 'gitgoose.desktop'), 'utf8')).toContain('Icon=/elsewhere/icon.png')
  })

  it('honours XDG_DATA_HOME', () => {
    expect(applicationsDir({ XDG_DATA_HOME: '/data' })).toBe('/data/applications')
    expect(applicationsDir({})).toMatch(/\.local\/share\/applications$/)
  })
})
