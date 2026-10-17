import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { FixtureRepo, initRepo, tempDir } from './index'

/**
 * A realistic repository for developing and eyeballing the UI: ~3,000 commits over two years
 * from 8 authors, 25-ish branches, 40 annotated tags, real file edits (not appends), renames,
 * squash merges, an orphan gh-pages branch, two remotes, stashes, a ready-made conflict and a
 * dirty working tree. Everything comes from a seeded random generator, so the same options always
 * produce the same hashes (and the same screenshots).
 *
 * The history is written with `git fast-import`, which is fast but makes us supply each merge's
 * tree ourselves. The trick that keeps that simple: a feature branch *claims* its files when it
 * starts, and while it is open no other branch touches them. A merge's tree is then just the
 * target's files with the feature's versions of its claimed files laid on top, which is always a
 * correct, conflict-free result.
 */

export interface DevRepoOptions {
  commits?: number
  seed?: number
  dir?: string
  /** Where the bare "origin" and "upstream" repositories go (default: temp dirs). */
  remotesDir?: string
}

export interface DevRepoInfo {
  dir: string
  /** Branch that has a guaranteed conflict with develop. */
  conflictBranch: string
  authors: { name: string; email: string }[]
}

// ---------------------------------------------------------------- deterministic randomness

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Rand {
  private next: () => number
  constructor(seed: number) {
    this.next = mulberry32(seed)
  }
  float(): number {
    return this.next()
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!
  }
  chance(p: number): boolean {
    return this.next() < p
  }
}

// ---------------------------------------------------------------- content

const AUTHORS = [
  { name: 'Ada Lovelace', email: 'ada@analytical.example' },
  { name: 'Grace Hopper', email: 'grace@cobol.example' },
  { name: 'Linus Torvalds', email: 'linus@kernel.example' },
  { name: 'Margaret Hamilton', email: 'margaret@apollo.example' },
  { name: 'Ken Thompson', email: 'ken@bell.example' },
  { name: 'Barbara Liskov', email: 'barbara@clu.example' },
  // GitHub noreply addresses: avatars resolve without signing in.
  { name: 'Octo Cat', email: '583231+octocat@users.noreply.github.com' },
  { name: 'Hubot', email: '480938+hubot@users.noreply.github.com' },
] as const

const WORDS = ['user', 'session', 'cache', 'route', 'token', 'config', 'graph', 'node', 'branch', 'commit',
  'diff', 'patch', 'index', 'remote', 'stash', 'tag', 'merge', 'layout', 'theme', 'panel', 'query', 'event']
const VERBS = ['load', 'parse', 'render', 'update', 'resolve', 'compute', 'format', 'validate', 'fetch', 'apply']
const SCOPES = ['router', 'graph', 'api', 'ui', 'auth', 'cache', 'build', 'docs', 'deps', 'store', 'diff']
const TYPES = ['feat', 'fix', 'refactor', 'chore', 'docs', 'test', 'perf', 'style'] as const

function camel(r: Rand): string {
  const a = r.pick(VERBS)
  const b = r.pick(WORDS)
  return a + b[0]!.toUpperCase() + b.slice(1)
}

function codeLine(r: Rand): string {
  switch (r.int(0, 7)) {
    case 0: return `  const ${r.pick(WORDS)} = ${camel(r)}(${r.pick(WORDS)}, ${r.int(0, 99)})`
    case 1: return `  if (!${r.pick(WORDS)}) return ${r.pick(['null', 'undefined', '[]', '{}', 'false'])}`
    case 2: return `  // ${r.pick(VERBS)} the ${r.pick(WORDS)} before the ${r.pick(WORDS)} changes`
    case 3: return `  ${r.pick(WORDS)}.${camel(r)}()`
    case 4: return `  return ${r.pick(WORDS)}.${r.pick(['map', 'filter', 'find'])}((x) => x.${r.pick(WORDS)})`
    case 5: return `  for (const ${r.pick(WORDS)} of ${r.pick(WORDS)}s) ${camel(r)}(${r.pick(WORDS)})`
    case 6: return `  await ${camel(r)}({ ${r.pick(WORDS)}: ${r.int(1, 500)} })`
    default: return `  log.debug('${r.pick(VERBS)} ${r.pick(WORDS)}', ${r.pick(WORDS)})`
  }
}

function newSourceFile(r: Rand): string[] {
  const lines = [`import { ${camel(r)} } from './${r.pick(WORDS)}'`, `import type { ${r.pick(WORDS)[0]!.toUpperCase()}Options } from '../types'`, '']
  const fns = r.int(2, 6)
  for (let f = 0; f < fns; f++) {
    lines.push(`export function ${camel(r)}(${r.pick(WORDS)}: string, ${r.pick(WORDS)}?: number) {`)
    for (let i = r.int(3, 12); i > 0; i--) lines.push(codeLine(r))
    lines.push('}', '')
  }
  return lines
}

function newDocFile(r: Rand, title: string): string[] {
  const lines = [`# ${title}`, '']
  for (let p = r.int(2, 5); p > 0; p--) {
    lines.push(`## ${r.pick(VERBS)} ${r.pick(WORDS)}`, '')
    for (let i = r.int(2, 6); i > 0; i--) lines.push(`The ${r.pick(WORDS)} ${r.pick(VERBS)}s each ${r.pick(WORDS)} when the ${r.pick(WORDS)} changes.`)
    lines.push('')
  }
  return lines
}

/** Change a file the way people do: replace, insert and delete a few lines somewhere in it. */
function editLines(r: Rand, lines: string[]): string[] {
  const out = [...lines]
  for (let n = r.int(1, 3); n > 0; n--) {
    const at = r.int(0, Math.max(0, out.length - 1))
    const op = r.int(0, 2)
    if (op === 0 && out.length) out[at] = codeLine(r)
    else if (op === 1) out.splice(at, 0, ...Array.from({ length: r.int(1, 4) }, () => codeLine(r)))
    else if (out.length > 8) out.splice(at, r.int(1, 2))
  }
  return out
}

// ---------------------------------------------------------------- simulation

type Files = Map<string, string[] | Buffer>

interface Branch {
  name: string
  tip: number // fast-import mark
  files: Files
  claimed: Set<string>
  /** Paths this branch added, changed, deleted or renamed since it forked. */
  touched: Set<string>
  commits: number
  squash?: boolean
}

/** Files the generator never deletes or renames: the conflict setup and the odd-path examples rely on them. */
const PROTECTED = new Set(['src/config.ts', 'src/utils/format.ts', 'docs/Design Notes.md', 'docs/résumé-ünïcode.md',
  'scripts/windows-setup.bat', 'package.json', 'README.md'])

const HOUR = 3600
const START = 1_700_000_000

export function makeDevRepo(opts: DevRepoOptions = {}): DevRepoInfo {
  const total = opts.commits ?? 3000
  const r = new Rand(opts.seed ?? 42)
  const dir = opts.dir ?? tempDir('gitsquid-dev-')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const repo = initRepo(dir)

  const out: string[] = []
  let mark = 0
  let time = START
  let pr = 100
  let commitCount = 0

  const cloneFiles = (f: Files): Files => new Map([...f].map(([k, v]) => [k, Buffer.isBuffer(v) ? v : [...v]]))
  const data = (s: string | Buffer) => {
    const b = typeof s === 'string' ? Buffer.from(s) : s
    out.push(`data ${b.length}`)
    out.push(b as unknown as string)
  }
  const fileBytes = (path: string, v: string[] | Buffer): Buffer =>
    Buffer.isBuffer(v) ? v : Buffer.from(v.join(path.endsWith('.bat') ? '\r\n' : '\n') + (v.length ? (path.endsWith('.bat') ? '\r\n' : '\n') : ''))

  /** Write a commit to the fast-import stream. `changes` maps path -> new content, or null to delete. */
  const writeCommit = (ref: string, message: string, author: { name: string; email: string }, from: number | null,
    merge: number | null, changes: Map<string, string[] | Buffer | null>, deleteAll = false): number => {
    mark++
    time += r.int(1, 30) * HOUR / 6
    commitCount++
    const who = `${author.name} <${author.email}> ${time} +0000`
    out.push(`commit ${ref}`, `mark :${mark}`, `author ${who}`, `committer ${who}`)
    data(message)
    if (from !== null) out.push(`from :${from}`)
    if (merge !== null) out.push(`merge :${merge}`)
    if (deleteAll) out.push('deleteall')
    for (const [path, v] of changes) {
      if (v === null) out.push(`D ${path}`)
      else {
        out.push(`M 100644 inline ${path}`)
        data(fileBytes(path, v))
      }
    }
    out.push('')
    return mark
  }

  // ---- the initial project
  const base: Files = new Map()
  const dirs = ['src', 'src/graph', 'src/ui', 'src/api', 'src/store', 'src/utils', 'tests']
  for (let i = 0; i < 60; i++) {
    const d = r.pick(dirs)
    const name = `${d}/${r.pick(WORDS)}${r.pick(['', 'View', 'Service', 'Store', 'Utils'])}-${i}.ts`
    base.set(name, newSourceFile(r))
  }
  base.set('src/utils/format.ts', ['export function format(value: string) {', '  // keep this short', '  const trimmed = value.trim()', '  return trimmed', '}', ''])
  base.set('src/config.ts', ['export const config = {', "  name: 'gitsquid-dev',", '  retries: 3,', '  timeoutMs: 5000,', '}', ''])
  base.set('README.md', newDocFile(r, 'Dev project'))
  base.set('docs/Design Notes.md', newDocFile(r, 'Design notes'))
  base.set('docs/résumé-ünïcode.md', newDocFile(r, 'Unicode in paths'))
  base.set('scripts/windows-setup.bat', ['@echo off', 'echo Setting up', 'npm install', 'echo Done'])
  base.set('package.json', ['{', '  "name": "gitsquid-dev",', '  "version": "0.1.0",', '  "private": true', '}'])
  // A 2 MB binary asset, generated from the seed.
  const bin = Buffer.alloc(2 * 1024 * 1024)
  for (let i = 0; i < bin.length; i += 4) bin.writeUInt32LE(Math.floor(r.float() * 0xffffffff), i)
  base.set('assets/hero.bin', bin)

  const init = new Map<string, string[] | Buffer | null>(base)
  const rootMark = writeCommit('refs/heads/main', 'Initial commit', AUTHORS[0], null, null, init)
  const main: Branch = { name: 'main', tip: rootMark, files: cloneFiles(base), claimed: new Set(), touched: new Set(), commits: 1 }
  const develop: Branch = { name: 'develop', tip: rootMark, files: cloneFiles(base), claimed: new Set(), touched: new Set(), commits: 0 }
  out.push('reset refs/heads/develop', `from :${rootMark}`, '')

  const features: Branch[] = []
  const finished: Branch[] = []
  const releases: Branch[] = []
  let version = { major: 1, minor: 0, patch: 0 }
  let tags = 0
  let squashes = 0
  const claimedAll = () => new Set(features.flatMap((f) => [...f.claimed]))

  const message = (type: string, scope: string) => `${type}(${scope}): ${r.pick(VERBS)} ${r.pick(WORDS)} ${r.pick(['handling', 'state', 'logic', 'layout', 'errors', 'tests'])}`

  /** One ordinary commit on `b`, editing 1-6 files (only `allowed` ones, if given). */
  const workOn = (b: Branch, allowed: (p: string) => boolean) => {
    const changes = new Map<string, string[] | Buffer | null>()
    const textFiles = [...b.files.keys()].filter((p) => !Buffer.isBuffer(b.files.get(p)) && allowed(p))
    for (let n = r.int(1, 6); n > 0 && textFiles.length; n--) {
      const roll = r.float()
      if (roll < 0.05) {
        // A new file next to an existing one.
        const near = r.pick(textFiles)
        const path = `${near.slice(0, near.lastIndexOf('/') + 1)}${camel(r)}-${mark}.ts`
        const lines = newSourceFile(r)
        b.files.set(path, lines)
        changes.set(path, lines)
        b.touched.add(path)
        textFiles.push(path)
        if (b !== develop && b !== main) b.claimed.add(path)
      } else if (roll < 0.08 && textFiles.length > 30) {
        const path = r.pick(textFiles)
        if (PROTECTED.has(path)) continue
        b.files.delete(path)
        changes.set(path, null)
        b.touched.add(path)
        textFiles.splice(textFiles.indexOf(path), 1)
      } else if (roll < 0.13) {
        // A rename, with a small edit so it is a realistic "similar" rename.
        const from = r.pick(textFiles)
        if (PROTECTED.has(from) || from.startsWith('docs/')) continue
        const to = from.replace(/[^/]+$/, `${camel(r)}-${mark}.ts`)
        const lines = b.files.get(from) as string[]
        b.files.delete(from)
        const edited = [...lines]
        if (edited.length > 3) edited[1] = codeLine(r)
        b.files.set(to, edited)
        changes.set(from, null)
        changes.set(to, edited)
        b.touched.add(from).add(to)
        textFiles.splice(textFiles.indexOf(from), 1, to)
        if (b !== develop && b !== main) b.claimed.add(to)
      } else {
        const path = r.pick(textFiles)
        if (path === 'src/config.ts' || path === 'src/utils/format.ts') continue // reserved for the conflict branch
        if (!path.endsWith('.ts') && !path.endsWith('.md') && r.chance(0.7)) continue // mostly edit code
        const edited = editLines(r, b.files.get(path) as string[])
        b.files.set(path, edited)
        changes.set(path, edited)
        b.touched.add(path)
      }
    }
    if (!changes.size) return
    const t = r.pick(TYPES)
    b.tip = writeCommit(`refs/heads/${b.name}`, message(t, r.pick(SCOPES)), r.pick(AUTHORS), b.tip, null, changes)
    b.commits++
  }

  /** Merge (or squash) feature `f` into `into`. */
  const land = (f: Branch, into: Branch) => {
    const changes = new Map<string, string[] | Buffer | null>()
    for (const p of f.touched) {
      const v = f.files.get(p)
      if (v === undefined) {
        if (into.files.has(p)) {
          into.files.delete(p)
          changes.set(p, null)
        }
      } else {
        into.files.set(p, Buffer.isBuffer(v) ? v : [...v])
        changes.set(p, v)
      }
    }
    const num = pr++
    const short = f.name.replace(/^feature\//, '')
    if (f.squash) {
      into.tip = writeCommit(`refs/heads/${into.name}`, `feat: ${short.replace(/-/g, ' ')} (#${num})`, r.pick(AUTHORS), into.tip, null, changes)
    } else {
      into.tip = writeCommit(`refs/heads/${into.name}`, `Merge pull request #${num} from team/${f.name}\n\n${short.replace(/-/g, ' ')}`,
        r.pick(AUTHORS), into.tip, f.tip, changes)
    }
    into.commits++
  }

  const release = () => {
    // develop -> main with --no-ff; main only changes through these merges, so its tree is develop's.
    const changes = new Map<string, string[] | Buffer | null>()
    for (const [p, v] of develop.files) if (main.files.get(p) !== v) changes.set(p, v)
    for (const p of main.files.keys()) if (!develop.files.has(p)) changes.set(p, null)
    main.files = cloneFiles(develop.files)
    const tag = `v${version.major}.${version.minor}.${version.patch}`
    main.tip = writeCommit('refs/heads/main', `Release ${tag}`, r.pick(AUTHORS), main.tip, develop.tip, changes)
    out.push(`tag ${tag}`, `from :${main.tip}`, `tagger ${AUTHORS[2].name} <${AUTHORS[2].email}> ${time} +0000`)
    // A tag's message is its last part: only one optional newline may follow (unlike a commit).
    data(`Release ${tag}\n`)
    tags++
    if (version.minor === 0 && version.patch === 0) {
      // Each major gets a maintenance branch that lives on, never merged back.
      const rb: Branch = { name: `release/${version.major}.x`, tip: main.tip, files: cloneFiles(main.files), claimed: new Set(), touched: new Set(), commits: 0 }
      out.push(`reset refs/heads/${rb.name}`, `from :${main.tip}`, '')
      releases.push(rb)
    }
    if (r.chance(0.12)) version = { major: version.major + 1, minor: 0, patch: 0 }
    else if (r.chance(0.5)) version = { ...version, minor: version.minor + 1, patch: 0 }
    else version = { ...version, patch: version.patch + 1 }
  }

  const releaseEvery = Math.max(20, Math.floor(total / 40))
  let sinceRelease = 0

  while (commitCount < total - 20) {
    const roll = r.float()
    if (roll < 0.08 && features.length < 7) {
      const claimed = new Set<string>()
      const taken = claimedAll()
      const candidates = [...develop.files.keys()].filter((p) => !taken.has(p) && !Buffer.isBuffer(develop.files.get(p)) &&
        p !== 'src/config.ts' && p !== 'src/utils/format.ts')
      for (let i = r.int(2, 6); i > 0 && candidates.length; i--) claimed.add(r.pick(candidates))
      const name = `feature/${r.pick(VERBS)}-${r.pick(WORDS)}-${mark}`
      const f: Branch = { name, tip: develop.tip, files: cloneFiles(develop.files), claimed, touched: new Set(), commits: 0, squash: squashes < 2 && r.chance(0.08) }
      if (f.squash) squashes++
      out.push(`reset refs/heads/${name}`, `from :${develop.tip}`, '')
      features.push(f)
    } else if (roll < 0.5 && features.length) {
      const f = r.pick(features)
      workOn(f, (p) => f.claimed.has(p))
    } else if (roll < 0.58 && features.some((f) => f.commits >= 4)) {
      const f = r.pick(features.filter((x) => x.commits >= 4))
      land(f, develop)
      features.splice(features.indexOf(f), 1)
      finished.push(f)
    } else if (roll < 0.6 && releases.length) {
      const rb = r.pick(releases)
      workOn(rb, () => true)
    } else {
      const taken = claimedAll()
      workOn(develop, (p) => !taken.has(p))
    }
    if (++sinceRelease >= releaseEvery && tags < 40) {
      release()
      sinceRelease = 0
    }
  }

  // gh-pages: an orphan branch with a few commits of its own.
  let pages = writeCommit('refs/heads/gh-pages', 'Publish site', AUTHORS[6], null, null, new Map([['index.html', ['<!doctype html>', '<h1>Docs</h1>']]]), true)
  for (let i = 0; i < 3; i++) pages = writeCommit('refs/heads/gh-pages', `Publish site (${i + 2})`, AUTHORS[6], pages, null, new Map([['index.html', ['<!doctype html>', `<h1>Docs v${i + 2}</h1>`]]]))

  out.push(`reset refs/heads/develop`, `from :${develop.tip}`, '')
  const input = Buffer.concat(out.map((x) => (Buffer.isBuffer(x) ? Buffer.concat([x as unknown as Buffer, Buffer.from('\n')]) : Buffer.from(x + '\n'))))
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, input, maxBuffer: 1 << 30 })

  // Real repositories delete most merged branches; keep about ten so the sidebar looks lived-in.
  for (const f of finished.slice(0, Math.max(0, finished.length - 10))) {
    if (!f.squash) execFileSync('git', ['update-ref', '-d', `refs/heads/${f.name}`], { cwd: dir })
  }

  repo.tick = commitCount
  finishWorkingState(repo, r, opts.remotesDir)
  return { dir, conflictBranch: CONFLICT_BRANCH, authors: [...AUTHORS] }
}

export const CONFLICT_BRANCH = 'conflict/renames-vs-edits'

/** The parts fast-import cannot express: a real conflict, remotes, stashes, a dirty working tree. */
function finishWorkingState(repo: FixtureRepo, r: Rand, remotesDir?: string): void {
  const remoteDir = (name: string) => {
    if (!remotesDir) return tempDir(`gitsquid-dev-${name}-`)
    const d = join(remotesDir, name)
    rmSync(d, { recursive: true, force: true })
    mkdirSync(remotesDir, { recursive: true })
    return d
  }
  const g = (...args: string[]) => repo.git(...args)
  g('checkout', '-q', '-f', 'develop')

  // A branch that conflicts with develop: it renames format.ts and edits the same lines develop edits.
  g('checkout', '-q', '-b', CONFLICT_BRANCH)
  repo.write('src/config.ts', "export const config = {\n  name: 'gitsquid-dev',\n  retries: 5,\n  timeoutMs: 10000,\n}\n")
  g('mv', 'src/utils/format.ts', 'src/utils/formatting.ts')
  repo.write('src/utils/formatting.ts', 'export function format(value: string) {\n  // keep this short\n  const trimmed = value.trim().toLowerCase()\n  return trimmed\n}\n')
  repo.commit('refactor(utils): rename format to formatting, lower-case values')
  g('checkout', '-q', 'develop')
  repo.write('src/config.ts', "export const config = {\n  name: 'gitsquid-dev',\n  retries: 2,\n  timeoutMs: 3000,\n}\n")
  repo.write('src/utils/format.ts', 'export function format(value: string) {\n  // keep this short\n  const trimmed = value.trim().replace(/\\s+/g, " ")\n  return trimmed\n}\n')
  repo.commit('fix(config): fewer retries, shorter timeout; collapse whitespace in format')

  // origin: a bare copy. Then someone else pushes 3 commits to develop, and we make 2 of our own.
  const origin = remoteDir('origin')
  rmSync(origin, { recursive: true, force: true })
  execFileSync('git', ['clone', '-q', '--bare', repo.dir, origin])
  g('remote', 'add', 'origin', origin)
  g('fetch', '-q', 'origin')
  g('branch', '-q', '--set-upstream-to=origin/develop', 'develop')
  g('branch', '-q', '--set-upstream-to=origin/main', 'main')
  const other = initRepo(tempDir('gitsquid-dev-other-'))
  rmSync(other.dir, { recursive: true, force: true })
  execFileSync('git', ['clone', '-q', '-b', 'develop', origin, other.dir])
  other.tick = repo.tick + 100
  for (let i = 1; i <= 3; i++) other.commit(`chore(deps): bump ${['vite', 'react', 'zustand'][i - 1]} (from a teammate)`, { [`deps-${i}.txt`]: `${i}\n` })
  other.git('push', '-q', 'origin', 'develop')
  repo.tick += 200
  for (let i = 1; i <= 2; i++) repo.commit(`wip: local change ${i}`, { [`local-${i}.txt`]: `local ${i}\n` })
  g('fetch', '-q', 'origin')

  // upstream: another remote, with a branch origin does not have.
  const upstream = remoteDir('upstream')
  rmSync(upstream, { recursive: true, force: true })
  execFileSync('git', ['clone', '-q', '--bare', origin, upstream])
  other.git('remote', 'add', 'upstream', upstream)
  other.git('checkout', '-q', '-b', 'upstream-experiment')
  other.commit('feat: experiment only upstream has', { 'experiment.txt': 'x\n' })
  other.git('push', '-q', 'upstream', 'upstream-experiment')
  g('remote', 'add', 'upstream', upstream)
  g('fetch', '-q', 'upstream')

  // Three stashes.
  const tracked = g('ls-files', 'src').split('\n').filter((p) => p.endsWith('.ts') && !p.includes('format') && !p.includes('config'))
  for (let i = 1; i <= 3; i++) {
    const path = tracked[r.int(0, tracked.length - 1)]!
    repo.write(path, `// stashed experiment ${i}\n` + g('show', `HEAD:${path}`))
    repo.tick++
    g('stash', 'push', '-q', '-m', `experiment ${i}`)
  }

  // A dirty working tree: 3 modified, 1 staged, 2 untracked, 1 deleted.
  const pickFile = (i: number) => tracked[(i * 7) % tracked.length]!
  for (let i = 0; i < 3; i++) repo.write(pickFile(i), g('show', `HEAD:${pickFile(i)}`) + `// edited in the working tree ${i}\n`)
  repo.write(pickFile(3), g('show', `HEAD:${pickFile(3)}`) + '// staged change\n')
  g('add', '--', pickFile(3))
  repo.write('notes/todo.md', '- [ ] try the three-pane merge\n')
  repo.write('scratch.ts', 'export const scratch = 1\n')
  rmSync(join(repo.dir, pickFile(4)))
}
