/**
 * pnpm dev:repo [--force] [--commits N]
 *
 * Builds the development repository into .fixtures/dev-repo (its remotes go in
 * .fixtures/dev-repo-remotes). `pnpm dev` opens it automatically when it exists.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CONFLICT_BRANCHES, makeDevRepo } from './devrepo'

const root = resolve(import.meta.dirname, '../../..')
const dir = join(root, '.fixtures', 'dev-repo')
const args = process.argv.slice(2)
const i = args.indexOf('--commits')
const commits = i >= 0 ? Number(args[i + 1]) : 3000

if (existsSync(join(dir, '.git')) && !args.includes('--force')) {
  console.log(`${dir} already exists. Use --force to rebuild it.`)
} else {
  const t = Date.now()
  const { bulkStashFiles } = makeDevRepo({ commits, dir, remotesDir: join(root, '.fixtures', 'dev-repo-remotes') })
  console.log(`Built ${dir} in ${((Date.now() - t) / 1000).toFixed(1)} s

Things to try (rebuild with --force to start over):
  Merge conflicts      merge one of these into develop:
                         ${CONFLICT_BRANCHES.renameVsEdit}  (content, and a rename against an edit)
                         ${CONFLICT_BRANCHES.deleteVsEdit}  (deleted by them)
                         ${CONFLICT_BRANCHES.bothAdded}  (both added)
                         ${CONFLICT_BRANCHES.binary}  (binary file)
  .gitignore           discard the unstaged .gitignore change: npm-debug.log is ignored again, .idea/ shows up
  Thousands of files   apply stash@{0} for ${bulkStashFiles.toLocaleString('en-US')} changes, discard all, apply again
  Push and pull        develop is 2 ahead and 3 behind origin`)
}
