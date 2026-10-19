import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, safeHref } from './markdown'

describe('markdown blocks', () => {
  it('paragraphs, joined lines and headings', () => {
    expect(parseMarkdown('# Title\n\nOne line\nand the next.\n\nSecond.')).toEqual([
      { t: 'h', level: 1, inline: [{ t: 'text', text: 'Title' }] },
      { t: 'p', inline: [{ t: 'text', text: 'One line and the next.' }] },
      { t: 'p', inline: [{ t: 'text', text: 'Second.' }] },
    ])
    expect(parseMarkdown('### Three ###')[0]).toEqual({ t: 'h', level: 3, inline: [{ t: 'text', text: 'Three' }] })
    // Not a heading without the space.
    expect(parseMarkdown('#hashtag')[0]).toEqual({ t: 'p', inline: [{ t: 'text', text: '#hashtag' }] })
  })

  it('bullet and numbered lists, nested by indentation, with lazy continuation lines', () => {
    const md = '- one\n- two\n  - two a\n  - two b\ncontinued\n\n3. three\n4. four'
    expect(parseMarkdown(md)).toEqual([
      { t: 'list', ordered: false, start: 1, items: [
        [{ t: 'p', inline: [{ t: 'text', text: 'one' }] }],
        [{ t: 'p', inline: [{ t: 'text', text: 'two' }] }, { t: 'list', ordered: false, start: 1, items: [
          [{ t: 'p', inline: [{ t: 'text', text: 'two a' }] }],
          [{ t: 'p', inline: [{ t: 'text', text: 'two b continued' }] }],
        ] }],
      ] },
      { t: 'list', ordered: true, start: 3, items: [[{ t: 'p', inline: [{ t: 'text', text: 'three' }] }], [{ t: 'p', inline: [{ t: 'text', text: 'four' }] }]] },
    ])
  })

  it('fenced code keeps its text and language; an unclosed fence (still streaming) runs to the end', () => {
    expect(parseMarkdown('Before\n```ts\nconst a = 1\n\n**not bold**\n```\nAfter')).toEqual([
      { t: 'p', inline: [{ t: 'text', text: 'Before' }] },
      { t: 'code', lang: 'ts', text: 'const a = 1\n\n**not bold**' },
      { t: 'p', inline: [{ t: 'text', text: 'After' }] },
    ])
    expect(parseMarkdown('```json:plan\n{"commits": [')).toEqual([{ t: 'code', lang: 'json:plan', text: '{"commits": [' }])
    expect(parseMarkdown('~~~\nx\n~~~')).toEqual([{ t: 'code', lang: '', text: 'x' }])
  })

  it('quotes and rules', () => {
    expect(parseMarkdown('> quoted\n> more\n\n---')).toEqual([
      { t: 'quote', blocks: [{ t: 'p', inline: [{ t: 'text', text: 'quoted more' }] }] },
      { t: 'hr' },
    ])
  })

  it('HTML is text, never markup', () => {
    expect(parseMarkdown('<script>alert(1)</script> <b>hi</b>')).toEqual([{ t: 'p', inline: [{ t: 'text', text: '<script>alert(1)</script> <b>hi</b>' }] }])
  })
})

describe('markdown inline', () => {
  it('strong, emphasis and code; delimiters inside code are literal', () => {
    expect(parseInline('a **b** *c* _d_ `e*f*`')).toEqual([
      { t: 'text', text: 'a ' }, { t: 'strong', children: [{ t: 'text', text: 'b' }] }, { t: 'text', text: ' ' },
      { t: 'em', children: [{ t: 'text', text: 'c' }] }, { t: 'text', text: ' ' }, { t: 'em', children: [{ t: 'text', text: 'd' }] },
      { t: 'text', text: ' ' }, { t: 'code', text: 'e*f*' },
    ])
    expect(parseInline('**bold with `code`**')).toEqual([{ t: 'strong', children: [{ t: 'text', text: 'bold with ' }, { t: 'code', text: 'code' }] }])
    expect(parseInline('``a ` b``')).toEqual([{ t: 'code', text: 'a ` b' }])
  })

  it('leaves snake_case, lone stars and escapes alone', () => {
    expect(parseInline('snake_case_name and 2 * 3 * 4')).toEqual([{ t: 'text', text: 'snake_case_name and 2 * 3 * 4' }])
    expect(parseInline('\\*not em\\*')).toEqual([{ t: 'text', text: '*not em*' }])
    expect(parseInline('unclosed **bold')).toEqual([{ t: 'text', text: 'unclosed **bold' }])
  })

  it('links: web and mail only; anything else is shown as its text', () => {
    expect(parseInline('see [the docs](https://example.com/a)')).toEqual([{ t: 'text', text: 'see ' }, { t: 'link', href: 'https://example.com/a', children: [{ t: 'text', text: 'the docs' }] }])
    expect(parseInline('[click](javascript:alert(1))')).toEqual([{ t: 'text', text: 'click' }, { t: 'text', text: ')' }])
    expect(parseInline('[open](file:///etc/passwd)')).toEqual([{ t: 'text', text: 'open' }])
    expect(parseInline('at <https://a.b/c> or https://x.y/z.')).toEqual([
      { t: 'text', text: 'at ' }, { t: 'link', href: 'https://a.b/c', children: [{ t: 'text', text: 'https://a.b/c' }] },
      { t: 'text', text: ' or ' }, { t: 'link', href: 'https://x.y/z', children: [{ t: 'text', text: 'https://x.y/z' }] }, { t: 'text', text: '.' },
    ])
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(safeHref('vscode://open')).toBeNull()
  })
})
