import type { CodeContext, ReviewContextInfo } from '@gitgoose/shared'

/**
 * The code graph's contribution to a prompt, as text. Repo.codeContext gathers the facts; this
 * renders them under a budget, most useful first:
 *
 *   1. a removed definition that is still used (the one thing only the graph can see),
 *   2. changed definitions with their uses outside the change (a changed signature next to
 *      the calls that still pass the old arguments),
 *   3. definitions of names the added lines use (what the new code is really calling),
 *   4. the tests that cover the change, and whether they changed too.
 *
 * The budget is the Goldilocks rule from the CodeRabbit post: too little and the model guesses,
 * too much and the diff drowns. Callers pick it in proportion to the diff.
 */

/** Sample lines shown per changed definition and per used definition. */
const MAX_CALLERS = 6
const MAX_PREVIEW_LINES = 12

export function renderCodeContext(ctx: CodeContext, budget: number): { text: string; truncated: boolean } {
  const parts: string[] = []
  let used = 0
  let truncated = false
  const take = (block: string): boolean => {
    if (used + block.length > budget) {
      truncated = true
      return false
    }
    parts.push(block)
    used += block.length
    return true
  }

  const order = (s: CodeContext['symbols'][number]) => (s.change === 'removed' && s.uses ? 0 : s.change === 'changed' ? 1 : s.change === 'added' ? 2 : 3)
  const symbols = [...ctx.symbols].sort((a, b) => order(a) - order(b) || b.uses - a.uses)
  if (symbols.length) {
    take('Definitions the change touches, and their uses outside the change:')
    for (const s of symbols) {
      // The headline always; then as many sample uses as fit (all, a couple, none).
      const headline = [`- ${s.kind} ${s.name} (${s.path}:${s.line}) ${s.change}${s.change === 'removed' && s.uses ? ', STILL USED' : ''}`]
      if (s.oldSignature) headline.push(`  was: ${s.oldSignature}`, `  now: ${s.signature}`)
      const describe = (shown: number) => {
        if (!s.uses) return [...headline, s.change === 'added' ? '  no uses outside the change yet' : '  no uses outside the change'].join('\n')
        const n = Math.min(s.callers.length, shown)
        return [
          ...headline,
          `  used in ${s.uses} place${s.uses === 1 ? '' : 's'} outside the change${s.testUses ? ` (${s.testUses} in tests)` : ''}${n ? ':' : ''}`,
          ...s.callers.slice(0, n).map((c) => `    ${c.path}:${c.line}${c.within ? ` in ${c.within}` : ''}${c.test ? ' (test)' : ''}: ${c.text}`),
          ...(s.uses > n && n ? [`    … ${s.uses - n} more`] : []),
        ].join('\n')
      }
      if (!(take(describe(MAX_CALLERS)) || take(describe(2)) || take(describe(0)))) break
    }
    take('')
  }

  if (ctx.used.length && !truncated) {
    take('Definitions of names the added lines use (outside the change):')
    for (const u of ctx.used) {
      const preview = u.preview.slice(0, MAX_PREVIEW_LINES)
      const more = u.endLine - u.line + 1 > preview.length ? [`  … ${u.endLine - u.line + 1 - preview.length} more lines`] : []
      const block = [`- ${u.kind} ${u.name} (${u.path}:${u.line}), used ${u.uses} time${u.uses === 1 ? '' : 's'}:`, '  ```', ...preview.map((l) => `  ${l}`), '  ```', ...more].join('\n')
      if (!take(block)) break
    }
    take('')
  }

  if (ctx.tests.length) {
    const inChange = ctx.tests.filter((t) => t.inChange).map((t) => t.path)
    const outside = ctx.tests.filter((t) => !t.inChange).map((t) => t.path)
    take([
      'Tests that cover the change:',
      ...(inChange.length ? [`- changed in this change: ${inChange.join(', ')}`] : []),
      ...(outside.length ? [`- not changed: ${outside.join(', ')}`] : []),
      '',
    ].join('\n'))
  } else if (ctx.symbols.length) take('No tests were found for the changed files or the changed definitions.\n')

  if (truncated) parts.push('(… more context left out for size)\n')
  return { text: parts.join('\n').trimEnd(), truncated }
}

/** The numbers the Review view shows about the graph's part. */
export function codeContextInfo(ctx: CodeContext, truncated: boolean): NonNullable<ReviewContextInfo['code']> {
  return {
    source: ctx.source,
    symbols: ctx.symbols.length,
    uses: ctx.symbols.reduce((n, s) => n + s.uses, 0),
    used: ctx.used.length,
    tests: ctx.tests.length,
    truncated,
  }
}

/** A context prompt budget in proportion to the diff: roughly one character of context per character of change, within bounds. */
export function contextBudget(diffChars: number, floor = 8_000, ceiling = 30_000): number {
  return Math.max(floor, Math.min(diffChars, ceiling))
}
