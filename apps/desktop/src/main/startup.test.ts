import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Everything the main process imports statically is loaded before the window can open. These
 * modules cost tens to hundreds of milliseconds each to load and are needed only later (an
 * agent conversation, the API fallback, the first file watch) or never in this process (the
 * parser, which runs in the indexer), so the main process loads them with `import()` where
 * they are used. `import type` is free: it disappears from the build.
 *
 * `pnpm bench` checks the same on the built bundle, where a dependency could also arrive
 * through a workspace package.
 */
const LAZY = ['@anthropic-ai/sdk', '@agentclientprotocol/sdk', '@parcel/watcher', 'web-tree-sitter', 'electron-updater']

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return sources(path)
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : []
  })
}

describe('main process startup', () => {
  it('loads heavy modules on first use, not at startup', () => {
    const main = import.meta.dirname
    const found: string[] = []
    for (const file of sources(main)) {
      const text = readFileSync(file, 'utf8')
      // Static imports that are not type-only: `import x from 'm'`, `import { a } from 'm'`, `import 'm'`.
      for (const m of text.matchAll(/^import\s+(?!type\s)(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
        if (LAZY.includes(m[1]!)) found.push(`${relative(main, file)} imports ${m[1]}`)
      }
    }
    expect(found).toEqual([])
  })
})
