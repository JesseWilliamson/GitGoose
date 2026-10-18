/**
 * Conflict markers in a working tree file, as git writes them:
 *
 *   <<<<<<< HEAD
 *   our lines
 *   ||||||| base        (only with merge.conflictStyle=diff3 or zdiff3)
 *   base lines
 *   =======
 *   their lines
 *   >>>>>>> feature
 *
 * parseConflicts splits a file into plain text and conflict blocks; resolveBlocks writes it back
 * with each block replaced by the chosen side. Both are pure so the renderer and main can share them.
 */

/** both: ours then theirs; both-theirs-first: theirs then ours; base: the common ancestor's lines. */
export type ConflictChoice = 'ours' | 'theirs' | 'both' | 'both-theirs-first' | 'base'

export interface ConflictBlock {
  kind: 'conflict'
  ours: string[]
  base: string[] | null
  theirs: string[]
  oursLabel: string
  theirsLabel: string
}

export interface TextBlock {
  kind: 'text'
  lines: string[]
}

export type Segment = ConflictBlock | TextBlock

export function parseConflicts(content: string): Segment[] {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(eol)
  const segments: Segment[] = []
  let text: string[] = []
  let block: ConflictBlock | null = null
  let part: 'ours' | 'base' | 'theirs' = 'ours'

  for (const line of lines) {
    if (!block && line.startsWith('<<<<<<<')) {
      if (text.length) segments.push({ kind: 'text', lines: text })
      text = []
      block = { kind: 'conflict', ours: [], base: null, theirs: [], oursLabel: line.slice(8), theirsLabel: '' }
      part = 'ours'
    } else if (block && part === 'ours' && line.startsWith('|||||||')) {
      block.base = []
      part = 'base'
    } else if (block && part !== 'theirs' && line === '=======') {
      part = 'theirs'
    } else if (block && part === 'theirs' && line.startsWith('>>>>>>>')) {
      block.theirsLabel = line.slice(8)
      segments.push(block)
      block = null
    } else if (block) {
      if (part === 'base') block.base!.push(line)
      else block[part].push(line)
    } else {
      text.push(line)
    }
  }
  // An unterminated block is not a real conflict; put its lines back as text.
  if (block) {
    text = [`<<<<<<< ${block.oursLabel}`, ...block.ours, ...(block.base ? ['|||||||', ...block.base] : []),
      ...(part === 'theirs' ? ['=======', ...block.theirs] : []), ...text]
  }
  if (text.length) segments.push({ kind: 'text', lines: text })
  return segments
}

export function countConflicts(content: string): number {
  return parseConflicts(content).filter((s) => s.kind === 'conflict').length
}

/** Rebuild the file. `choices[i]` picks the side for the i-th conflict block; missing choices keep the markers. */
export function resolveBlocks(content: string, choices: (ConflictChoice | undefined)[]): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const out: string[] = []
  let i = 0
  for (const seg of parseConflicts(content)) {
    if (seg.kind === 'text') {
      out.push(...seg.lines)
      continue
    }
    const choice = choices[i++]
    if (choice === 'ours') out.push(...seg.ours)
    else if (choice === 'theirs') out.push(...seg.theirs)
    else if (choice === 'both') out.push(...seg.ours, ...seg.theirs)
    else if (choice === 'both-theirs-first') out.push(...seg.theirs, ...seg.ours)
    else if (choice === 'base') out.push(...(seg.base ?? []))
    else {
      out.push(`<<<<<<< ${seg.oursLabel}`, ...seg.ours)
      if (seg.base) out.push('|||||||', ...seg.base)
      out.push('=======', ...seg.theirs, `>>>>>>> ${seg.theirsLabel}`)
    }
  }
  return out.join(eol)
}
