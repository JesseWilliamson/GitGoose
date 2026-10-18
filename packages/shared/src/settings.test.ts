import { describe, expect, it } from 'vitest'
import { defaultSettings, migrateSettings, validatePatch, validateSetting } from './settings'

describe('settings schema', () => {
  it('validates by kind: clamps numbers, checks choices, rejects wrong types', () => {
    expect(validateSetting('uiScale', 5)).toBe(1.75)
    expect(validateSetting('uiScale', 1.23)).toBe(1.25)
    expect(validateSetting('uiScale', 'big')).toBe(1)
    expect(validateSetting('theme', 'purple')).toBe('system')
    expect(validateSetting('pullMode', 'rebase')).toBe('rebase')
    expect(validateSetting('signOff', 'yes')).toBe(false)
    expect(validateSetting('recentRepos', 'not a list')).toEqual([])
    expect(validateSetting('keybindings', { undo: 'mod+u', bad: 3 })).toEqual({ undo: 'mod+u' })
  })

  it('drops unknown keys from a patch', () => {
    expect(validatePatch({ theme: 'dark', nonsense: 1 })).toEqual({ theme: 'dark' })
  })

  it('migrates a v1 file: fontSize becomes uiScale, other values survive, junk falls back', () => {
    const v1 = { gitPath: '/usr/bin/git', theme: 'light', fontSize: 16, recentRepos: ['/a'], openRepos: 'broken' }
    const s = migrateSettings(v1)
    expect(s.uiScale).toBe(1.25)
    expect(s.theme).toBe('light')
    expect(s.gitPath).toBe('/usr/bin/git')
    expect(s.recentRepos).toEqual(['/a'])
    expect(s.openRepos).toEqual([])
    expect(s.settingsVersion).toBe(2)
    expect('fontSize' in s).toBe(false)
  })

  it('has a complete default set', () => {
    const d = defaultSettings()
    expect(d.contextLines).toBe(3)
    expect(d.avatars).toBe('initials')
    expect(d.compactRows).toBe(false)
  })
})
