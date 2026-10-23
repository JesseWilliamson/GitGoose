import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Deterministic test repositories.
 *
 * Every commit gets a fixed author, committer and timestamp (advancing one minute per commit),
 * so the same shape always produces the same hashes. Tests run real git against these instead
 * of mocking it: a parser can only pass by handling what git actually prints.
 */

export type Shape =
  | 'empty' | 'linear' | 'branches' | 'octopus' | 'orphan' | 'tags' | 'stash'
  | 'conflict' | 'crlf' | 'renames' | 'criss-cross' | 'with-remote'

export const SHAPES: Shape[] = ['empty', 'linear', 'branches', 'octopus', 'orphan', 'tags', 'stash',
  'conflict', 'crlf', 'renames', 'criss-cross', 'with-remote']

const BASE_TIME = 1_700_000_000

export class FixtureRepo {
  tick = 0
  constructor(readonly dir: string) {}

  env(): NodeJS.ProcessEnv {
    const date = `${BASE_TIME + this.tick * 60} +0000`
    return {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ada Lovelace', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: 'Ada Lovelace', GIT_COMMITTER_EMAIL: 'ada@example.com', GIT_COMMITTER_DATE: date,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullDevice(),
      LC_ALL: 'C',
    }
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, env: this.env(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  }

  /**
   * git's output, or null when it fails. For polling a ref or setting the app is about to create:
   * expect.poll gives up at the first throw instead of polling again.
   */
  gitOrNull(...args: string[]): string | null {
    try {
      return this.git(...args)
    } catch {
      return null
    }
  }

  /** Run git and return the exit code instead of throwing (for merges expected to conflict). */
  tryGit(...args: string[]): number {
    return spawnSync('git', args, { cwd: this.dir, env: this.env(), stdio: 'ignore' }).status ?? -1
  }

  write(path: string, content: string): this {
    const abs = join(this.dir, path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    return this
  }

  /** Write files, stage everything, commit. Returns the new commit hash. */
  commit(message: string, files: Record<string, string> = {}): string {
    for (const [p, c] of Object.entries(files)) this.write(p, c)
    this.git('add', '-A')
    this.git('commit', '--allow-empty', '-q', '-m', message)
    this.tick++
    return this.head()
  }

  merge(branch: string, message?: string): string {
    this.git('merge', '-q', '--no-ff', '-m', message ?? `Merge ${branch}`, branch)
    this.tick++
    return this.head()
  }

  head(): string {
    return this.git('rev-parse', 'HEAD').trim()
  }

  checkout(...args: string[]): this {
    this.git('checkout', '-q', ...args)
    return this
  }
}

function nullDevice(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}

export function tempDir(prefix = 'gitgoose-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function initRepo(dir: string = tempDir()): FixtureRepo {
  const r = new FixtureRepo(dir)
  r.git('init', '-q', '-b', 'main')
  r.git('config', 'user.name', 'Ada Lovelace')
  r.git('config', 'user.email', 'ada@example.com')
  r.git('config', 'commit.gpgsign', 'false')
  r.git('config', 'core.autocrlf', 'false')
  return r
}

/** Build a repository of the given shape in a fresh temp directory. */
export function makeFixture(shape: Shape): FixtureRepo {
  const r = initRepo()
  switch (shape) {
    case 'empty':
      break

    case 'linear':
      for (let i = 1; i <= 5; i++) r.commit(`Commit ${i}`, { 'file.txt': `line ${i}\n`.repeat(i) })
      break

    case 'branches':
      // main: A - B ------- M - E
      //            \       /
      // feature:    C - D
      // wip (from B):  F
      r.commit('A', { 'a.txt': 'a\n' })
      r.commit('B', { 'b.txt': 'b\n' })
      r.checkout('-b', 'feature')
      r.commit('C', { 'c.txt': 'c\n' })
      r.commit('D', { 'd.txt': 'd\n' })
      r.checkout('main')
      r.checkout('-b', 'wip')
      r.commit('F', { 'f.txt': 'f\n' })
      r.checkout('main')
      r.merge('feature', 'M')
      r.commit('E', { 'e.txt': 'e\n' })
      break

    case 'octopus':
      r.commit('base', { 'base.txt': 'base\n' })
      for (const b of ['one', 'two', 'three']) {
        r.checkout('-b', b, 'main')
        r.commit(`on ${b}`, { [`${b}.txt`]: `${b}\n` })
      }
      r.checkout('main')
      r.git('merge', '-q', '-m', 'octopus', 'one', 'two', 'three')
      r.tick++
      break

    case 'orphan':
      r.commit('main 1', { 'm.txt': '1\n' })
      r.commit('main 2', { 'm.txt': '2\n' })
      r.git('checkout', '-q', '--orphan', 'pages')
      r.git('rm', '-rq', '--cached', '.')
      r.git('clean', '-fdq')
      r.commit('pages 1', { 'index.html': '<h1>hi</h1>\n' })
      r.checkout('main')
      break

    case 'tags':
      r.commit('first', { 'x.txt': '1\n' })
      r.git('tag', 'v0.1')
      r.commit('second', { 'x.txt': '2\n' })
      r.git('tag', '-a', 'v0.2', '-m', 'Release 0.2')
      break

    case 'stash':
      r.commit('base', { 'x.txt': 'base\n' })
      r.write('x.txt', 'changed once\n')
      r.git('stash', 'push', '-q', '-m', 'first stash')
      r.write('x.txt', 'changed twice\n')
      r.git('stash', 'push', '-q', '-m', 'second stash')
      break

    case 'conflict':
      // main and other both change line 2 of story.txt. Merging other into main conflicts.
      r.commit('base', { 'story.txt': 'one\ntwo\nthree\n', 'same.txt': 'same\n' })
      r.checkout('-b', 'other')
      r.commit('theirs', { 'story.txt': 'one\nTWO (theirs)\nthree\n' })
      r.checkout('main')
      r.commit('ours', { 'story.txt': 'one\nTwo (ours)\nthree\n' })
      break

    case 'crlf':
      r.commit('windows file', { 'win.txt': 'one\r\ntwo\r\nthree\r\n', 'unix.txt': 'one\ntwo\n' })
      break

    case 'renames':
      r.commit('add', { 'old name.txt': 'content that is long enough to be detected as a rename\n'.repeat(5) })
      r.git('mv', 'old name.txt', 'new name.txt')
      r.commit('rename')
      break

    case 'criss-cross':
      // Two branches that merge each other: the classic history with two merge bases.
      r.commit('root', { 'r.txt': 'r\n' })
      r.checkout('-b', 'side')
      r.commit('s1', { 's.txt': '1\n' })
      r.checkout('main')
      r.commit('m1', { 'm.txt': '1\n' })
      r.checkout('side')
      r.merge('main', 'merge main into side')
      r.checkout('main')
      r.git('merge', '-q', '--no-ff', '-m', 'merge side into main', 'side~1')
      r.tick++
      break

    case 'with-remote': {
      // A bare "origin" plus a clone of it with one unpushed commit.
      const origin = initRepo(tempDir('gitgoose-origin-'))
      origin.commit('initial', { 'readme.md': '# hi\n' })
      origin.commit('second', { 'readme.md': '# hi\nthere\n' })
      const bare = tempDir('gitgoose-bare-')
      execFileSync('git', ['clone', '-q', '--bare', origin.dir, bare])
      rmSync(r.dir, { recursive: true, force: true })
      execFileSync('git', ['clone', '-q', bare, r.dir])
      r.git('config', 'user.name', 'Ada Lovelace')
      r.git('config', 'user.email', 'ada@example.com')
      r.tick = 2
      r.commit('local only', { 'local.txt': 'local\n' })
      break
    }
  }
  return r
}

/**
 * A large repository built with `git fast-import`, which writes commits directly into a pack
 * without touching the working tree. 100k commits take a few seconds instead of minutes.
 * Every 50 commits a side branch of 5 commits is merged back, so the graph has real lanes.
 */
export function makeLargeRepo(commits: number, dir: string = tempDir('gitgoose-large-')): string {
  initRepo(dir)
  const lines: string[] = []
  let mark = 0
  let t = BASE_TIME
  const who = (time: number) => `Ada Lovelace <ada@example.com> ${time} +0000`
  const emit = (branch: string, msg: string, from: number | null, merge: number | null, file: string) => {
    mark++
    t += 60
    lines.push(`commit refs/heads/${branch}`, `mark :${mark}`, `author ${who(t)}`, `committer ${who(t)}`,
      `data ${Buffer.byteLength(msg)}`, msg)
    if (from !== null) lines.push(`from :${from}`)
    if (merge !== null) lines.push(`merge :${merge}`)
    const content = `${msg}\n`
    lines.push(`M 100644 inline ${file}`, `data ${Buffer.byteLength(content)}`, content, '')
    return mark
  }
  let main = emit('main', 'commit 1', null, null, 'main.txt')
  let n = 1
  while (n < commits) {
    if (n % 50 === 0 && n + 6 <= commits) {
      let side = main
      for (let k = 0; k < 5; k++) side = emit(`side-${n}`, `side ${n}.${k}`, side, null, `side-${n % 7}.txt`)
      main = emit('main', `merge side ${n}`, main, side, 'main.txt')
      n += 6
    } else {
      main = emit('main', `commit ${n + 1}`, main, null, 'main.txt')
      n++
    }
  }
  // Keep only a few side branches as refs; the rest were merged and can go.
  const input = lines.join('\n') + '\n'
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, input, maxBuffer: 1 << 30 })
  const sides = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/heads/side-*'], { cwd: dir, encoding: 'utf8' })
    .split('\n').filter(Boolean)
  for (const ref of sides.slice(0, -5)) execFileSync('git', ['update-ref', '-d', ref], { cwd: dir })
  execFileSync('git', ['checkout', '-q', '-f', 'main'], { cwd: dir })
  return dir
}

export function removeFixture(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

export { makeDevRepo, CONFLICT_BRANCH, CONFLICT_BRANCHES, type DevRepoInfo, type DevRepoOptions } from './devrepo'
export { fakeGitHub, FAKE_AVATAR_PNG, type FakeGitHub, type FakeGitHubOptions } from './fakeGitHub'
export { FAKE_MODELS, fakeAnthropic, type FakeAnthropic } from './fakeAnthropic'
