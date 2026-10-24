// `pnpm typecheck` at the root runs every package's typecheck. The site's needs the dsviz checkout
// beside the repository (see vite.config.ts); without it, say so and pass, so CI for the app is not
// held hostage by a repository it does not need. The Pages workflow checks dsviz out and gets the
// real check.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const here = fileURLToPath(new URL('..', import.meta.url))
const dsviz = resolve(here, '../../../DiagramBuilder')
if (!existsSync(resolve(dsviz, 'packages/core/src/index.ts'))) {
  console.log('site: dsviz checkout not found beside the repository, typecheck skipped (clone github.com/JesseWilliamson/DiagramBuilder next to GitGoose to run it)')
  process.exit(0)
}
if (!existsSync(resolve(dsviz, 'packages/core/dist/index.d.ts'))) {
  console.error('site: dsviz is not built; run `npm install && npm run build` in ../DiagramBuilder first')
  process.exit(1)
}
execFileSync('npx', ['tsc', '-p', resolve(here, 'tsconfig.json')], { stdio: 'inherit', cwd: here })
