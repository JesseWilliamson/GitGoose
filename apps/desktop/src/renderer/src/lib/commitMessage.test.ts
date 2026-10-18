import { describe, expect, it } from 'vitest'
import { addTrailer, isUntouched, splitTemplate } from './commitMessage'

describe('commit message helpers', () => {
  it('prefills a template without its comment lines, which become the hint', () => {
    expect(splitTemplate('feat: \n\nBecause\n# Why this change?\n# Link the issue\n')).toEqual({ summary: 'feat:', body: 'Because', hint: 'Why this change?\nLink the issue' })
    expect(splitTemplate('# only guidance\n')).toEqual({ summary: '', body: '', hint: 'only guidance' })
  })

  it('knows when the message is still just the template', () => {
    const t = { summary: 'feat:', body: '' }
    expect(isUntouched('', '', null)).toBe(true)
    expect(isUntouched('feat:', '', t)).toBe(true)
    expect(isUntouched('feat: add', '', t)).toBe(false)
  })

  it('adds trailers as the last paragraph, once', () => {
    const grace = 'Co-authored-by: Grace Hopper <grace@example.com>'
    expect(addTrailer('', grace)).toBe(grace)
    expect(addTrailer('Some prose.', grace)).toBe(`Some prose.\n\n${grace}`)
    expect(addTrailer('Prose.\n\nSigned-off-by: Ada <ada@example.com>', grace)).toBe(`Prose.\n\nSigned-off-by: Ada <ada@example.com>\n${grace}`)
    expect(addTrailer(`Prose.\n\n${grace}\n`, grace)).toBe(`Prose.\n\n${grace}`)
  })
})
