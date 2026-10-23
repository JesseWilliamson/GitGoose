import { Repo } from '@gitgoose/git'
import { initRepo, makeFixture } from '@gitgoose/fixtures'
import { afterEach, describe, expect, it } from 'vitest'
import { capContext, MAX_CONTEXT_CHARS, renderContext, summarizeStatus, type ContextPart } from './context'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f()
})

async function open(r: { dir: string }) {
  const repo = await Repo.open(r.dir, {})
  cleanup.push(() => repo.dispose())
  return repo
}

describe('capContext (pure)', () => {
  const part = (name: string, detail: number): ContextPart => ({ header: `Context: ${name}`, head: `overview of ${name}`, detail: 'Q'.repeat(detail) })

  it('keeps everything that fits, in order, under one introduction', () => {
    const text = capContext([part('a', 100), part('b', 200)], 10_000)
    expect(text.indexOf('Context: a')).toBeLessThan(text.indexOf('Context: b'))
    expect(text).not.toContain('truncated')
    expect(text.match(/Q/g)).toHaveLength(300)
  })

  it('returns nothing for no parts', () => {
    expect(capContext([])).toBe('')
  })

  it('trims the largest detail first and keeps the small one whole', () => {
    const text = capContext([part('big', 50_000), part('small', 500)], 2_000)
    expect(text.length).toBeLessThanOrEqual(2_000)
    expect(text).toContain('… truncated')
    const [big, small] = [text.split('### Context: small')[0]!, text.split('### Context: small')[1]!]
    expect(small.match(/Q/g)).toHaveLength(500)
    expect(big).toContain('overview of big')
    expect(big.match(/Q/g)!.length).toBeLessThan(50_000)
  })

  it('never goes over the cap, however many chips there are', () => {
    const many = Array.from({ length: 40 }, (_, i) => part(`p${i}`, 5_000))
    expect(capContext(many).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
    expect(capContext(many, 3_000).length).toBeLessThanOrEqual(3_000)
  })
})

describe('summarizeStatus (pure)', () => {
  it('lists staged, unstaged, conflicted and untracked files, and a rename with its old path', () => {
    const z = [
      '# branch.oid abc', '# branch.head main',
      '1 M. N... 100644 100644 100644 h1 h2 staged.ts',
      '1 .M N... 100644 100644 100644 h1 h2 work tree.ts',
      '2 R. N... 100644 100644 100644 h1 h2 R100 new.ts', 'old.ts',
      'u UU N... 100644 100644 100644 100644 h1 h2 h3 clash.ts',
      '? fresh.ts', '',
    ].join('\0')
    const text = summarizeStatus(z)
    expect(text).toContain('On branch main')
    expect(text).toContain('Staged (2)')
    expect(text).toContain('modified: staged.ts')
    expect(text).toContain('renamed: new.ts (from old.ts)')
    expect(text).toContain('Not staged (1)')
    expect(text).toContain('modified: work tree.ts')
    expect(text).toContain('Conflicted (1)')
    expect(text).toContain('clash.ts')
    expect(text).toContain('Untracked (1)')
  })

  it('says so when nothing changed', () => {
    expect(summarizeStatus('# branch.head main\0')).toBe('On main. No uncommitted changes.')
  })
})

describe('renderContext (real git)', () => {
  it('a commit: header with the short hash and subject, the full message, the stat and the patch; lockfiles left out', async () => {
    const r = initRepo()
    r.commit('base', { 'a.txt': 'a\n' })
    const hash = r.commit('Add the widget registry\n\nRegisters widgets by name so plugins can add their own.', {
      'src/widgets.ts': 'export const widgets = new Map()\n',
      'pnpm-lock.yaml': 'lockfile: contents-nobody-needs\n',
    })
    const text = await renderContext(await open(r), [{ kind: 'commits', hashes: [hash] }])
    expect(text).toContain(`Context: commit ${hash.slice(0, 7)} Add the widget registry`)
    expect(text).toContain('Registers widgets by name')
    expect(text).toContain('src/widgets.ts')
    expect(text).toContain('+export const widgets = new Map()')
    expect(text).not.toContain('pnpm-lock.yaml')
    expect(text).not.toContain('contents-nobody-needs')
  })

  it('several commits: each one is a part; a bad hash is said, not thrown', async () => {
    const r = makeFixture('linear')
    const hashes = r.git('log', '--format=%H', '-3').trim().split('\n')
    const text = await renderContext(await open(r), [{ kind: 'commits', hashes }, { kind: 'commits', hashes: ['not-a-hash'] }])
    for (const h of hashes) expect(text).toContain(`Context: commit ${h.slice(0, 7)}`)
    expect(text).toContain('no valid commit hashes')
  })

  it('a branch: its latest commits and the diff stat since the merge base with HEAD', async () => {
    const r = makeFixture('branches')
    r.git('checkout', '-q', '-b', 'topic/x', 'main')
    r.commit('Feature work', { 'feature.txt': 'f\n' })
    r.git('checkout', '-q', 'main')
    const text = await renderContext(await open(r), [{ kind: 'ref', name: 'refs/heads/topic/x' }])
    expect(text).toContain('Context: branch topic/x')
    expect(text).toContain('Feature work')
    expect(text).toContain('feature.txt')
    expect(text).toContain('Changed since it forked from HEAD')
  })

  it('a tag, a branch already in HEAD, and names that are gone or not names', async () => {
    const r = makeFixture('linear')
    r.git('tag', 'v1', 'HEAD~2')
    const text = await renderContext(await open(r), [{ kind: 'ref', name: 'refs/tags/v1' }, { kind: 'ref', name: 'refs/heads/gone' }, { kind: 'ref', name: '--upload-pack=x' }])
    expect(text).toContain('Context: tag v1')
    expect(text).toContain('already in HEAD')
    expect(text).toContain('gone does not exist any more')
    expect(text).toContain('not a valid name')
  })

  it('a stash: its message, stat and patch', async () => {
    const r = makeFixture('linear')
    r.write('file.txt', 'changed for the stash\n')
    r.git('stash', 'push', '-m', 'half-done idea')
    const text = await renderContext(await open(r), [{ kind: 'stash', ref: 'stash@{0}', index: 0 }, { kind: 'stash', ref: '--x', index: 1 }])
    expect(text).toContain('Context: stash stash@{0}')
    expect(text).toContain('half-done idea')
    expect(text).toContain('+changed for the stash')
    expect(text).toContain('not a stash')
  })

  it('files: at a commit, and in the changes list (staged and not staged)', async () => {
    const r = makeFixture('linear')
    const head = r.git('rev-parse', 'HEAD').trim()
    r.write('file.txt', 'worktree edit\n')
    r.write('other.txt', 'staged\n')
    r.git('add', 'other.txt')
    const repo = await open(r)
    const at = await renderContext(repo, [{ kind: 'files', rev: head, paths: ['file.txt'] }])
    expect(at).toContain(`file.txt at ${head.slice(0, 7)}`)
    expect(at).toContain('+line 5')
    const work = await renderContext(repo, [{ kind: 'files', rev: 'worktree', paths: ['file.txt', 'other.txt'] }])
    expect(work).toContain('Staged:')
    expect(work).toContain('+staged')
    expect(work).toContain('Not staged:')
    expect(work).toContain('+worktree edit')
  })

  it('uncommitted changes: the status summary and both diffs, lockfiles left out', async () => {
    const r = makeFixture('linear')
    r.write('file.txt', 'edited\n')
    r.write('new.txt', 'untracked\n')
    r.write('staged.txt', 'staged\n')
    r.git('add', 'staged.txt')
    r.write('yarn.lock', 'noise\n')
    r.git('add', 'yarn.lock')
    const text = await renderContext(await open(r), [{ kind: 'wip' }])
    expect(text).toContain('Context: uncommitted changes')
    expect(text).toContain('Staged (')
    expect(text).toContain('Untracked (1)')
    expect(text).toContain('+edited')
    expect(text).toContain('+staged')
    expect(text).not.toContain('+noise')
  })

  it('compare: the log between, the stat and the patch; with the working tree when `to` is null', async () => {
    const r = makeFixture('linear')
    const [c5, c2] = [r.git('rev-parse', 'HEAD').trim(), r.git('rev-parse', 'HEAD~3').trim()]
    const repo = await open(r)
    const text = await renderContext(repo, [{ kind: 'compare', from: c2, to: c5 }])
    expect(text).toContain(`Context: compare ${c2.slice(0, 7)}..${c5.slice(0, 7)}`)
    expect(text).toContain('Commit 5')
    expect(text).toContain('file.txt')
    r.write('file.txt', 'now\n')
    const wt = await renderContext(repo, [{ kind: 'compare', from: c5, to: null }])
    expect(wt).toContain('working tree')
    expect(wt).toContain('+now')
    expect(await renderContext(repo, [{ kind: 'compare', from: '--bad', to: null }])).toContain('not a valid revision')
  })

  it('is capped at 60k characters with a truncation marker, and the overviews survive', async () => {
    const r = makeFixture('linear')
    r.commit('Big change', { 'src/big.ts': Array.from({ length: 8_000 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n' })
    const hash = r.git('rev-parse', 'HEAD').trim()
    const text = await renderContext(await open(r), [{ kind: 'commits', hashes: [hash] }, { kind: 'wip' }])
    expect(text.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
    expect(text).toContain('… truncated')
    expect(text).toContain('Big change')
    expect(text).toContain('src/big.ts')
    expect(text).toContain('Context: uncommitted changes')
  })
})
