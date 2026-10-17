import type { Ref, RefKind } from '@gitsquid/shared'

/**
 * for-each-ref fields, NUL separated, one ref per line:
 * refname, objectname, *objectname (peeled tag target, empty for non-tags), upstream, upstream:track
 */
export const REFS_FORMAT = '%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(committerdate:unix)'

export function parseRefs(output: string): Ref[] {
  const refs: Ref[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    const [name = '', object = '', peeled = '', upstream = '', track = '', date = ''] = line.split('\x00')
    const kind = refKind(name)
    if (!kind) continue
    // origin/HEAD is a symbolic pointer to the remote's default branch, not a branch.
    if (kind === 'remote' && name.endsWith('/HEAD')) continue
    const ref: Ref = { name, shortName: shortRefName(name), kind, hash: peeled || object }
    if (date) ref.date = Number(date)
    if (upstream) {
      ref.upstream = upstream
      ref.ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0)
      ref.behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
      if (track === 'gone') ref.upstreamGone = true
    }
    refs.push(ref)
  }
  return refs
}

export function refKind(name: string): RefKind | null {
  if (name.startsWith('refs/heads/')) return 'local'
  if (name.startsWith('refs/remotes/')) return 'remote'
  if (name.startsWith('refs/tags/')) return 'tag'
  if (name === 'refs/stash') return 'stash'
  return null
}

export function shortRefName(name: string): string {
  return name.replace(/^refs\/(heads|remotes|tags)\//, '')
}
