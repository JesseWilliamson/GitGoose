// Copies the tree-sitter grammars (WASM) and their tags queries into out/grammars, laid out as
// <package>/<file>, which electron-builder ships as resources/grammars (see electron-builder.yml)
// and the indexer reads through `directoryLocator`. Run by `pnpm dist` after the build.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const registry = require('@gitgoose/codegraph/grammars.json')
const out = join(import.meta.dirname, '..', 'out', 'grammars')
rmSync(out, { recursive: true, force: true })
const files = new Set()
for (const g of Object.values(registry)) for (const f of [g.wasm, ...g.queries]) files.add(f)
for (const spec of files) {
  const to = join(out, spec)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(require.resolve(spec), to)
}
console.log(`grammars: ${files.size} files into ${out}`)
