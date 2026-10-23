import type { Ref } from '@gitgoose/shared'
import { describe, expect, it } from 'vitest'
import { defaultOpen, parentIndex, sidebarRows, type SidebarInput, type SidebarRow } from './sidebarRows'

const ref = (kind: Ref['kind'], shortName: string, date?: number): Ref => ({
  kind, shortName, hash: 'a'.repeat(40), date,
  name: kind === 'local' ? `refs/heads/${shortName}` : kind === 'remote' ? `refs/remotes/${shortName}` : `refs/tags/${shortName}`,
})

const base: SidebarInput = {
  refs: [ref('local', 'feature/login'), ref('local', 'feature/search'), ref('local', 'main'), ref('remote', 'origin/main'), ref('remote', 'origin/feature/x'),
    ref('tag', 'v1', 100), ref('tag', 'v3', 300), ref('tag', 'v2', 200)],
  headBranch: 'main', pins: [], remotes: ['origin'], stashes: [], hasGitHub: false, pulls: null, pullsLoading: false,
  worktrees: [], submodules: [], lfs: null, folders: true, tagLimit: 250, filter: '', showReflog: true,
  isOpen: (k) => defaultOpen(k, 1),
}
/** A row as a short string, indented by depth. */
const show = (rows: SidebarRow[]) => rows.map((r) => '  '.repeat(r.depth) + (
  r.kind === 'header' ? `# ${r.title}` : r.kind === 'workspace' ? `@${r.item}` : r.kind === 'folder' ? `${r.name}/` : r.kind === 'ref' ? r.label
    : r.kind === 'remote' ? `[${r.remote}]` : r.kind === 'empty' ? `(${r.text})` : r.kind === 'more-tags' ? `+${r.hidden} older` : r.kind))
const rows = (patch: Partial<SidebarInput> = {}) => show(sidebarRows({ ...base, ...patch }))

describe('sidebarRows', () => {
  it('lists Tower\'s sections in order, branches as a folder tree, remotes and tags closed', () => {
    expect(rows()).toEqual([
      '# Workspace', '  @working-copy', '  @history', '  @stashes', '    (No stashes)', '  @reflog',
      '# Pinned',
      '# Branches', '  feature/', '    login', '    search', '  main',
      '# Remotes', '  [origin]',
      '# Tags',
      '# Worktrees',
    ])
  })

  it('opens what is open: a remote as a tree of its branches, tags newest first', () => {
    const open = new Set(['remote:origin', 'section:tags'])
    expect(rows({ isOpen: (k) => open.has(k) || defaultOpen(k, 1) }).slice(12)).toEqual([
      '# Remotes', '  [origin]', '    feature/', '      x', '    main',
      '# Tags', '  v3', '  v2', '  v1',
      '# Worktrees',
    ])
  })

  it('a collapsed folder hides its branches; folders can be turned off', () => {
    expect(rows({ isOpen: (k) => k !== 'folder:branches:feature' && defaultOpen(k, 1) })).toContain('  feature/')
    expect(rows({ isOpen: (k) => k !== 'folder:branches:feature' && defaultOpen(k, 1) })).not.toContain('    login')
    expect(rows({ folders: false }).slice(7, 11)).toEqual(['# Branches', '  feature/login', '  feature/search', '  main'])
  })

  it('the filter flattens and narrows branches, remotes and tags, opening what it searches', () => {
    expect(rows({ filter: 'FEAT' }).slice(6)).toEqual([
      '# Pinned',
      '# Branches', '  feature/login', '  feature/search',
      '# Remotes', '  [origin]', '    feature/x',
      '# Tags',
      '# Worktrees',
    ])
  })

  it('pinned branches come first in pin order, and only ones that exist', () => {
    expect(rows({ pins: ['main', 'gone', 'feature/search'] }).slice(6, 9)).toEqual(['# Pinned', '  main', '  feature/search'])
  })

  it('an empty Pinned section is only its header', () => {
    expect(rows().slice(6, 8)).toEqual(['# Pinned', '# Branches'])
    expect(rows({ pins: ['main'] }).slice(6, 9)).toEqual(['# Pinned', '  main', '# Branches'])
  })

  it('a long tag list is shortened, newest first, with the rest one click away', () => {
    expect(rows({ tagLimit: 2, isOpen: (k) => k === 'section:tags' || defaultOpen(k, 1) }).slice(14, 18)).toEqual(['# Tags', '  v3', '  v2', '  +1 older'])
    // The filter still searches every tag.
    expect(rows({ tagLimit: 2, filter: 'v1' })).toContain('  v1')
  })

  it('stashes and pull requests sit under their Workspace items', () => {
    const stash = { index: 0, ref: 'stash@{0}', hash: 'b'.repeat(40), message: 'WIP on main', date: 1 }
    const pull = { number: 5, title: 'Fix', branch: 'fix', base: 'main', author: 'ada', draft: false, fromFork: false, url: '' }
    const r = rows({ stashes: [stash], hasGitHub: true, pulls: { state: 'ok', pulls: [pull] } as never, isOpen: (k) => k === 'ws:pulls' || defaultOpen(k, 1), showReflog: false })
    expect(r.slice(0, 6)).toEqual(['# Workspace', '  @working-copy', '  @history', '  @stashes', '    stash', '  @pulls'])
    expect(r[6]).toBe('    pull')
  })

  it('← goes to the row\'s folder, remote or section', () => {
    const r = sidebarRows(base)
    const login = r.findIndex((x) => x.kind === 'ref' && x.label === 'login')
    expect(r[parentIndex(r, login)]).toMatchObject({ kind: 'folder', path: 'feature' })
    expect(r[parentIndex(r, parentIndex(r, login))]).toMatchObject({ kind: 'header', section: 'branches' })
  })

  it('2,000 refs stay cheap: one pass, rows only for what is open', () => {
    const many = Array.from({ length: 2000 }, (_, i) => ref(i % 2 ? 'local' : 'tag', `team${i % 20}/topic-${i}`, i))
    const t = performance.now()
    const r = sidebarRows({ ...base, refs: many, isOpen: () => true, tagLimit: Infinity })
    expect(performance.now() - t).toBeLessThan(100)
    expect(r.filter((x) => x.kind === 'ref')).toHaveLength(2000)
  })
})
