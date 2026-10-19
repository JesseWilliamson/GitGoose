/**
 * The Markdown GitGoose draws for AI answers: a small subset, parsed into plain data and drawn
 * by components/Markdown.tsx as React elements. There is no HTML passthrough at all: `<b>`
 * in an answer is the four characters it looks like, because React escapes every string, and
 * links are only ever http, https or mailto. That is why no sanitiser is needed (and no
 * Markdown dependency: the subset is what agents actually write).
 *
 * Blocks: paragraphs, ATX headings (#), bullet and numbered lists (nested by indentation),
 * fenced code (``` or ~~~, with a language), block quotes, rules. Inline: **strong**, *em* /
 * _em_, `code`, [links](https://…), <https://…> and bare https:// links, backslash escapes.
 * A fence that is still open (the answer is streaming) runs to the end.
 */

export type MdInline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'em'; children: MdInline[] }
  | { t: 'strong'; children: MdInline[] }
  | { t: 'link'; href: string; children: MdInline[] }

export type MdBlock =
  | { t: 'p'; inline: MdInline[] }
  | { t: 'h'; level: number; inline: MdInline[] }
  | { t: 'list'; ordered: boolean; start: number; items: MdBlock[][] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'quote'; blocks: MdBlock[] }
  | { t: 'hr' }

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/
const QUOTE = /^ {0,3}>\s?(.*)$/

export function parseMarkdown(src: string): MdBlock[] {
  return blocks(src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'))
}

function blocks(lines: string[]): MdBlock[] {
  const out: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]!
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i]!.trim().startsWith(marker[0]!.repeat(marker.length)) && lines[i]!.trim().replace(/[`~]/g, '') === '')) body.push(lines[i++]!)
      i++ // the closing fence (or past the end, while streaming)
      out.push({ t: 'code', lang: fence[2] ?? '', text: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ t: 'h', level: heading[1]!.length, inline: parseInline(heading[2]!) })
      i++
      continue
    }
    if (RULE.test(line)) {
      out.push({ t: 'hr' })
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && lines[i]!.trim() && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!)
      out.push({ t: 'quote', blocks: blocks(body) })
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      const [list, next] = parseList(lines, i)
      out.push(list)
      i = next
      continue
    }
    // A paragraph: lines up to a blank line or the start of another block.
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!)) para.push(lines[i++]!.trim())
    out.push({ t: 'p', inline: parseInline(para.join(' ')) })
  }
  return out
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line)
}

/**
 * A list: items with the same marker kind at the same indent. An item's content is its first
 * line plus the lines indented past its marker (a nested list, a second paragraph), parsed as
 * blocks of their own; an unindented line right after an item continues its paragraph.
 */
function parseList(lines: string[], from: number): [MdBlock, number] {
  const first = ITEM.exec(lines[from]!)!
  const indent = first[1]!.length
  const ordered = /\d/.test(first[2]!)
  const items: MdBlock[][] = []
  let i = from
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]!)
    if (!m || m[1]!.length !== indent || /\d/.test(m[2]!) !== ordered) break
    const contentIndent = indent + m[2]!.length + 1
    const body = [m[3]!]
    i++
    let blank = false
    while (i < lines.length) {
      const l = lines[i]!
      if (!l.trim()) {
        blank = true
        body.push('')
        i++
        continue
      }
      const lead = l.length - l.trimStart().length
      if (lead >= contentIndent || (lead > indent && ITEM.test(l))) {
        body.push(l.slice(Math.min(lead, contentIndent)))
        blank = false
        i++
        continue
      }
      // A lazy continuation of the item's text (not after a blank line, not a new block).
      if (!blank && !startsBlock(l)) {
        body[body.length - 1] += ` ${l.trim()}`
        i++
        continue
      }
      break
    }
    while (body.at(-1) === '') body.pop()
    items.push(blocks(body))
    // A blank line between items keeps the list going; anything else ends it.
    if (blank && i < lines.length && !ITEM.test(lines[i]!)) break
  }
  return [{ t: 'list', ordered, start: ordered ? Number.parseInt(first[2]!, 10) : 1, items }, i]
}

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s<>]+$/i

/** Only web links and mail: never javascript:, file: or an app's own scheme. */
export function safeHref(href: string): string | null {
  const h = href.trim()
  return SAFE_URL.test(h) ? h : null
}

export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = []
  let text = ''
  const flush = () => {
    if (text) out.push({ t: 'text', text })
    text = ''
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === '\\' && i + 1 < src.length && /[\\`*_[\]()<>#+\-.!~|{}]/.test(src[i + 1]!)) {
      text += src[i + 1]
      i += 2
      continue
    }
    if (c === '`') {
      const run = /^`+/.exec(src.slice(i))![0]
      const end = src.indexOf(run, i + run.length)
      if (end > 0) {
        flush()
        out.push({ t: 'code', text: src.slice(i + run.length, end).replace(/^ (.+) $/, '$1') })
        i = end + run.length
        continue
      }
      text += run
      i += run.length
      continue
    }
    if (c === '*' || c === '_') {
      const double = src[i + 1] === c
      const mark = double ? c + c : c
      // "_" only at a word boundary: snake_case_names stay as they are.
      const before = src[i - 1] ?? ' '
      const ok = c === '*' || !/\w/.test(before)
      const end = ok ? findClose(src, mark, i + mark.length) : -1
      if (end > i + mark.length) {
        flush()
        const children = parseInline(src.slice(i + mark.length, end))
        out.push(double ? { t: 'strong', children } : { t: 'em', children })
        i = end + mark.length
        continue
      }
      text += mark
      i += mark.length
      continue
    }
    if (c === '[') {
      const m = /^\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/.exec(src.slice(i))
      if (m) {
        flush()
        const href = safeHref(m[2]!)
        const children = parseInline(m[1]!)
        // A link GitGoose will not open is shown as its text, not as a dead link.
        if (href) out.push({ t: 'link', href, children })
        else out.push(...children)
        i += m[0].length
        continue
      }
    }
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(src.slice(i))
      if (m) {
        flush()
        out.push({ t: 'link', href: m[1]!, children: [{ t: 'text', text: m[1]! }] })
        i += m[0].length
        continue
      }
    }
    if ((c === 'h' || c === 'H') && /\W|^$/.test(src[i - 1] ?? '')) {
      const m = /^https?:\/\/[^\s<>]+/i.exec(src.slice(i))
      if (m) {
        // Trailing punctuation belongs to the sentence, not the link.
        const url = m[0].replace(/[.,;:!?)\]'"]+$/, '')
        flush()
        out.push({ t: 'link', href: url, children: [{ t: 'text', text: url }] })
        i += url.length
        continue
      }
    }
    text += c
    i++
  }
  flush()
  return out
}

/** The closing delimiter for emphasis that opened at `from`, skipping code spans. */
function findClose(src: string, mark: string, from: number): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] === '`') {
      const run = /^`+/.exec(src.slice(i))![0]
      const end = src.indexOf(run, i + run.length)
      if (end > 0) {
        i = end + run.length - 1
        continue
      }
    }
    if (src[i] === '\\') {
      i++
      continue
    }
    if (src.startsWith(mark, i) && src[i - 1] !== ' ') {
      // "**" must not close a single "*" (and vice versa).
      if (mark.length === 1 && src[i + 1] === mark) {
        i++
        continue
      }
      if (mark[0] === '_' && /\w/.test(src[i + mark.length] ?? '')) continue
      return i
    }
  }
  return -1
}

/** The plain text of inline content (for titles and tests). */
export function inlineText(nodes: MdInline[]): string {
  return nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.text : inlineText(n.children))).join('')
}
