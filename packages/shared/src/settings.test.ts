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
    expect(s.settingsVersion).toBe(5)
    expect('fontSize' in s).toBe(false)
  })

  it('migrates a v3 file: Ask threads become AI threads with an ask anchor', () => {
    const ask = { id: 'q1', rev: 'abc1234', path: 'src/a.ts', startLine: 2, endLine: 3, code: 'x', updated: 7, messages: [{ role: 'user', text: 'Why?' }, { role: 'ai', text: 'Because.' }] }
    const s = migrateSettings({ settingsVersion: 3, askThreads: { '/repo': [ask, 'junk'] } })
    expect(s.settingsVersion).toBe(5)
    expect('askThreads' in s).toBe(false)
    const [t, ...rest] = s.aiThreads['/repo']!
    expect(rest).toEqual([])
    expect(t).toMatchObject({ id: 'q1', title: 'Why?', anchor: { kind: 'ask', rev: 'abc1234', path: 'src/a.ts', lines: [2, 3], code: 'x' } })
    expect(t!.turns.map((x) => [x.role, x.blocks])).toEqual([['user', [{ type: 'text', text: 'Why?' }]], ['agent', [{ type: 'text', text: 'Because.' }]]])
    // A v4 file is left alone.
    expect(migrateSettings({ settingsVersion: 4, aiThreads: { '/r': [] } }).aiThreads).toEqual({ '/r': [] })
  })

  it('migrates a v4 file: the sign-in switch is dropped and avatars start over at GitHub', () => {
    const s = migrateSettings({ settingsVersion: 4, githubHttps: true, avatars: 'gravatar', theme: 'dark' })
    expect(s.settingsVersion).toBe(5)
    expect('githubHttps' in s).toBe(false)
    expect(s.avatars).toBe('github')
    expect(s.theme).toBe('dark')
    // v4's default was 'initials', so a stored 'initials' says nothing; a v5 choice of it is kept.
    expect(migrateSettings({ settingsVersion: 4, avatars: 'initials' }).avatars).toBe('github')
    expect(migrateSettings({ settingsVersion: 5, avatars: 'initials' }).avatars).toBe('initials')
    // A window still running the old renderer cannot set either one back.
    expect(validatePatch({ githubHttps: true, avatars: 'gravatar' })).toEqual({ avatars: 'github' })
  })

  it('migrates a v2 file: compact rows become the compact graph layout', () => {
    const on = migrateSettings({ settingsVersion: 2, compactRows: true })
    expect(on.graphStyle).toBe('compact')
    expect('compactRows' in on).toBe(false)
    const off = migrateSettings({ settingsVersion: 2, compactRows: false })
    expect(off.graphStyle).toBe('comfy')
    expect(off.settingsVersion).toBe(5)
  })

  it('has a complete default set', () => {
    const d = defaultSettings()
    expect(d.contextLines).toBe(3)
    expect(d.avatars).toBe('github')
    expect(d.graphStyle).toBe('comfy')
  })

  it('reads the layout saved before the rename (comfortable) as comfy', () => {
    expect(validateSetting('graphStyle', 'comfortable')).toBe('comfy')
    expect(validateSetting('graphStyle', 'compact')).toBe('compact')
  })
})
