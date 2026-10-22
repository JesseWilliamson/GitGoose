import { describe, expect, it } from 'vitest'
import { DEFAULT_PROMPTS, effectivePrompt, joinPrompt, PROMPT_KINDS, promptKindsOf, renderTemplate } from './prompts'

describe('prompt words', () => {
  it('fills {names} it knows and leaves the rest as typed', () => {
    expect(renderTemplate('Review this change ({label}). {profile} {nope} {}', { label: 'Staged changes', profile: 'Be brief.' }))
      .toBe('Review this change (Staged changes). Be brief. {nope} {}')
  })

  it("an area's edit wins over Settings', which wins over the built-in words, part by part", () => {
    const def = DEFAULT_PROMPTS.recompose
    const none = { aiPrompts: {}, aiPromptEdits: {} }
    expect(effectivePrompt('recompose', none)).toEqual({ system: def.system, instructions: def.instructions, source: 'built-in' })
    const settings = { aiPrompts: { recompose: { system: 'S', instructions: '' } }, aiPromptEdits: {} }
    // A blank part is no edit: the built-in instructions stay.
    expect(effectivePrompt('recompose', settings)).toEqual({ system: 'S', instructions: def.instructions, source: 'settings' })
    const area = { ...settings, aiPromptEdits: { recompose: { system: '', instructions: 'Mine' } } }
    expect(effectivePrompt('recompose', area)).toEqual({ system: 'S', instructions: 'Mine', source: 'area' })
    // Settings → AI looks past the area's edit.
    expect(effectivePrompt('recompose', area, { area: false }).source).toBe('settings')
  })

  it('puts the parts together: instructions, the fixed format, then the context', () => {
    expect(joinPrompt({ instructions: 'Do it.\n', format: 'JSON only.', context: 'the diff' })).toBe('Do it.\nJSON only.\n\nthe diff')
    expect(joinPrompt({ instructions: 'Do it.', format: '', context: 'the diff' })).toBe('Do it.\n\nthe diff')
    expect(joinPrompt({ instructions: '', format: '', context: 'the diff' })).toBe('the diff')
  })

  it('every kind has words, and every area edits at least one kind', () => {
    for (const k of PROMPT_KINDS) {
      expect(DEFAULT_PROMPTS[k].system.length).toBeGreaterThan(0)
      expect(DEFAULT_PROMPTS[k].instructions.length).toBeGreaterThan(0)
      // Every {name} the built-in words use is one the request fills in.
      for (const [, name] of DEFAULT_PROMPTS[k].instructions.matchAll(/\{(\w+)\}/g)) expect(DEFAULT_PROMPTS[k].vars).toHaveProperty(name!)
    }
    const areas = ['commit', 'explain', 'review', 'walkthrough', 'impact', 'recompose', 'ask', 'chat', 'conflict', 'push-checks', 'error'] as const
    expect(new Set(areas.flatMap(promptKindsOf))).toEqual(new Set(PROMPT_KINDS))
  })
})
