/**
 * pnpm dev:repo [--force] [--commits N]
 *
 * Builds the development repository into .fixtures/dev-repo (its remotes go in
 * .fixtures/dev-repo-remotes). `pnpm dev` opens it automatically when it exists.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeDevRepo } from './devrepo'

const root = resolve(import.meta.dirname, '../../..')
const dir = join(root, '.fixtures', 'dev-repo')
const args = process.argv.slice(2)
const i = args.indexOf('--commits')
const commits = i >= 0 ? Number(args[i + 1]) : 3000

if (existsSync(join(dir, '.git')) && !args.includes('--force')) {
  console.log(`${dir} already exists. Use --force to rebuild it.`)
} else {
  const t = Date.now()
  makeDevRepo({ commits, dir, remotesDir: join(root, '.fixtures', 'dev-repo-remotes') })
  console.log(`Built ${dir} in ${((Date.now() - t) / 1000).toFixed(1)} s`)
}
