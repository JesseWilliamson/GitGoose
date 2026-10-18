import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { conflictCount, diffLines, merge3, mergedText, splitLines } from './merge3'

/** Apply hunks to A and check the result is B: the diff must be a valid edit script. */
function applyHunks(a: string[], b: string[], hunks: ReturnType<typeof diffLines>): string[] {
  const out: string[] = []
  let pos = 0
  for (const h of hunks) {
    out.push(...a.slice(pos, h.aStart), ...b.slice(h.bStart, h.bEnd))
    pos = h.aEnd
  }
  return [...out, ...a.slice(pos)]
}

function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

function mutate(lines: string[], r: () => number, tag: string): string[] {
  const out = [...lines]
  for (let n = 1 + Math.floor(r() * 3); n > 0; n--) {
    const at = Math.floor(r() * (out.length + 1))
    const op = Math.floor(r() * 3)
    if (op === 0 && out.length) out[Math.min(at, out.length - 1)] = `${tag} ${Math.floor(r() * 1000)}\n`
    else if (op === 1) out.splice(at, 0, `${tag} inserted ${Math.floor(r() * 1000)}\n`)
    else if (out.length > 1) out.splice(Math.min(at, out.length - 1), 1)
  }
  return out
}

/** git merge-file -p: the merged text and how many conflicts git found. */
function gitMerge(base: string, ours: string, theirs: string): { text: string; conflicts: number } {
  const dir = mkdtempSync(join(tmpdir(), 'gitgoose-merge3-'))
  mkdirSync(dir, { recursive: true })
  for (const [n, t] of [['base', base], ['ours', ours], ['theirs', theirs]]) writeFileSync(join(dir, n!), t!)
  const res = spawnSync('git', ['merge-file', '-p', join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')], { encoding: 'utf8' })
  return { text: res.stdout, conflicts: res.status ?? -1 }
}

describe('diffLines (Myers)', () => {
  it('produces a minimal-looking, valid edit script', () => {
    const a = splitLines('a\nb\nc\nd\ne\n')
    const b = splitLines('a\nX\nc\nd\nY\ne\nf\n')
    const h = diffLines(a, b)
    expect(applyHunks(a, b, h)).toEqual(b)
    expect(h).toEqual([
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 },
      { aStart: 4, aEnd: 4, bStart: 4, bEnd: 5 },
      { aStart: 5, aEnd: 5, bStart: 6, bEnd: 7 },
    ])
  })

  it('is a valid edit script on random inputs', () => {
    const r = rng(1)
    for (let i = 0; i < 300; i++) {
      const a = Array.from({ length: Math.floor(r() * 20) }, () => `${Math.floor(r() * 5)}\n`)
      const b = Array.from({ length: Math.floor(r() * 20) }, () => `${Math.floor(r() * 5)}\n`)
      expect(applyHunks(a, b, diffLines(a, b))).toEqual(b)
    }
  })

  it('stays valid when the edit cap cuts the search short', () => {
    const r = rng(2)
    for (let i = 0; i < 100; i++) {
      const a = Array.from({ length: 5 + Math.floor(r() * 30) }, () => `${Math.floor(r() * 4)}\n`)
      const b = Array.from({ length: 5 + Math.floor(r() * 30) }, () => `${Math.floor(r() * 4)}\n`)
      expect(applyHunks(a, b, diffLines(a, b, 3))).toEqual(b)
    }
  })

  it('is fast on a large file with scattered edits and bounded on a rewritten one', () => {
    const a = Array.from({ length: 20_000 }, (_, i) => `line ${i}\n`)
    const b = a.map((l, i) => (i % 97 === 0 ? `changed ${i}\n` : l))
    let t = performance.now()
    const h = diffLines(a, b)
    expect(h).toHaveLength(Math.ceil(20_000 / 97))
    expect(performance.now() - t).toBeLessThan(1000)
    // Nothing in common: the cap turns it into one hunk instead of a 40,000-step search.
    const c = a.map((_, i) => `other ${i}\n`)
    t = performance.now()
    expect(diffLines(a, c)).toEqual([{ aStart: 0, aEnd: 20_000, bStart: 0, bEnd: 20_000 }])
    expect(performance.now() - t).toBeLessThan(2000)
  })
})

describe('merge3', () => {
  it('handles the trivial cases', () => {
    const base = 'one\ntwo\nthree\n'
    const changed = 'one\nTWO\nthree\n'
    expect(mergedText(merge3(base, base, changed))).toBe(changed)
    expect(mergedText(merge3(base, changed, base))).toBe(changed)
    const same = merge3(base, changed, changed)
    expect(conflictCount(same)).toBe(0)
    expect(same.blocks.map((b) => b.kind)).toEqual(['same', 'both-same', 'same'])
  })

  it('finds the conflict in the fixture repository the same way git does', () => {
    const m = merge3('one\ntwo\nthree\n', 'one\nTwo (ours)\nthree\n', 'one\nTWO (theirs)\nthree\n')
    expect(m.blocks.map((b) => b.kind)).toEqual(['same', 'conflict', 'same'])
    expect(mergedText(m, [undefined, 'theirs'])).toBe('one\nTWO (theirs)\nthree\n')
    expect(mergedText(m, [undefined, 'both'])).toBe('one\nTwo (ours)\nTWO (theirs)\nthree\n')
  })

  it('agrees with git merge-file on random histories', () => {
    const r = rng(42)
    let compared = 0
    let withConflicts = 0
    for (let i = 0; i < 400; i++) {
      const base = Array.from({ length: 4 + Math.floor(r() * 16) }, (_, k) => `line ${k}\n`)
      const ours = mutate(base, r, 'ours')
      const theirs = mutate(base, r, 'theirs')
      const m = merge3(base.join(''), ours.join(''), theirs.join(''))
      const git = gitMerge(base.join(''), ours.join(''), theirs.join(''))
      if (git.conflicts === 0) {
        // Git merged cleanly: so must we, to exactly the same text.
        expect(conflictCount(m), `case ${i}`).toBe(0)
        expect(mergedText(m), `case ${i}`).toBe(git.text)
        compared++
      } else {
        // Git found conflicts: we must find at least one (git refines conflicts more finely, so
        // the counts can differ: it splits a region we report as one when lines inside agree).
        expect(conflictCount(m), `case ${i}`).toBeGreaterThan(0)
        withConflicts++
      }
    }
    expect(compared).toBeGreaterThan(50)
    expect(withConflicts).toBeGreaterThan(50)
  })

  it('handles files without a trailing newline and empty sides', () => {
    expect(mergedText(merge3('a\nb', 'a\nb\nc', 'a\nb'))).toBe('a\nb\nc')
    expect(mergedText(merge3('', 'new\n', ''))).toBe('new\n')
    expect(conflictCount(merge3('', 'x\n', 'y\n'))).toBe(1)
  })

})
