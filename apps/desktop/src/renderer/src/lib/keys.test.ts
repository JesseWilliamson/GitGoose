import { describe, expect, it } from 'vitest'
import { COMMANDS, comboOf, conflicts, keymap } from './keys'

type Ev = Parameters<typeof comboOf>[0]
const ev = (key: string, mods: Partial<Ev> = {}): Ev => ({ key, code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

describe('comboOf', () => {
  it('writes mod combinations as before (Ctrl elsewhere, Cmd on macOS)', () => {
    expect(comboOf(ev('k', { ctrlKey: true }), false)).toBe('mod+k')
    expect(comboOf(ev('k', { metaKey: true }), true)).toBe('mod+k')
    expect(comboOf(ev('K', { ctrlKey: true, shiftKey: true }), false)).toBe('mod+shift+k')
    expect(comboOf(ev('b', { ctrlKey: true, altKey: true }), false)).toBe('mod+alt+b')
    expect(comboOf(ev('¡', { metaKey: true, altKey: true, code: 'Digit1' }), true)).toBe('mod+alt+1')
    expect(comboOf(ev('+', { ctrlKey: true, shiftKey: true }), false)).toBe('mod+=')
    expect(comboOf(ev('ArrowDown', { ctrlKey: true, shiftKey: true }), false)).toBe('mod+shift+arrowdown')
    // The other platform's modifier does not count as mod.
    expect(comboOf(ev('k', { metaKey: true }), false)).toBeNull()
    expect(comboOf(ev('k', { ctrlKey: true }), true)).toBeNull()
  })

  it('writes Alt without mod as alt+key', () => {
    expect(comboOf(ev('ArrowLeft', { altKey: true }), false)).toBe('alt+arrowleft')
    expect(comboOf(ev('ArrowRight', { altKey: true }), true)).toBe('alt+arrowright')
    expect(comboOf(ev('ArrowLeft', { altKey: true, shiftKey: true }), false)).toBe('alt+shift+arrowleft')
  })

  it('gives null for plain keys, lone modifiers, and Alt with only the other modifier', () => {
    expect(comboOf(ev('a'), false)).toBeNull()
    expect(comboOf(ev('A', { shiftKey: true }), false)).toBeNull()
    expect(comboOf(ev('Alt', { altKey: true }), false)).toBeNull()
    expect(comboOf(ev('Control', { ctrlKey: true }), false)).toBeNull()
    expect(comboOf(ev('ArrowLeft', { altKey: true, ctrlKey: true }), true)).toBeNull()
    expect(comboOf(ev('ArrowLeft', { altKey: true, metaKey: true }), false)).toBeNull()
  })
})

describe('back and forward', () => {
  it('are commands bound to Alt+Left and Alt+Right, clashing with nothing', () => {
    expect(COMMANDS.find((c) => c.id === 'back')?.defaults).toContain('alt+arrowleft')
    expect(COMMANDS.find((c) => c.id === 'forward')?.defaults).toContain('alt+arrowright')
    expect(keymap({}).get('alt+arrowleft')).toBe('back')
    expect(conflicts({}).size).toBe(0)
    // Rebindable like any other.
    expect(keymap({ back: 'mod+alt+arrowleft' }).get('mod+alt+arrowleft')).toBe('back')
  })
})
