import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The hint grey (`text-hint`: hints, counts, dates, placeholders) must stay readable. WCAG AA for
 * small text is 4.5 : 1. The colours are read from styles.css, so changing a palette value that
 * breaks the contrast fails here instead of going unnoticed.
 */
// Normalised: a Windows checkout with autocrlf turns the file's newlines into CRLF.
const css = readFileSync(join(import.meta.dirname, '..', 'styles.css'), 'utf8').replace(/\r\n/g, '\n')

/** The declarations of the block that starts with `selector` (the first one in the file). */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no ${selector} block in styles.css`)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1]!, m[2]!]))
}

const channel = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

const themes = {
  dark: block(":root,\n:root[data-theme='dark']"),
  light: block(":root[data-theme='light']"),
}

describe('contrast helper', () => {
  it('matches the WCAG reference values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
  })
})

describe('the hint token', () => {
  it('is wired up: --hint is the faint palette colour, text-hint is a utility', () => {
    expect(css).toMatch(/--hint:\s*var\(--gs-faint\)/)
    expect(css).toMatch(/--color-hint:\s*var\(--hint\)/)
  })

  for (const [name, t] of Object.entries(themes)) {
    it(`is at least 4.5 : 1 on the page, the card and popovers in ${name}`, () => {
      const hint = t['--gs-faint']!
      expect(hint).toBeDefined()
      for (const surface of ['--gs-bg', '--gs-panel', '--gs-raised']) {
        expect(contrast(hint, t[surface]!), `${hint} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    })

    it(`stays quieter than the muted text in ${name}`, () => {
      expect(contrast(t['--gs-faint']!, t['--gs-panel']!)).toBeLessThan(contrast(t['--gs-muted']!, t['--gs-panel']!))
    })
  }
})
