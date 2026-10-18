import type { Ref, RefKind } from '@gitgoose/shared'

/**
 * for-each-ref fields, NUL separated, one ref per line:
 * refname, objectname, *objectname (peeled tag target, empty for non-tags), upstream, upstream:track,
 * committerdate, symref (the target of a symbolic ref such as origin/HEAD)
 */
export const REFS_FORMAT = '%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(symref)'

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

/**
 * The main line, as full ref names: the branch origin/HEAD points at (the remote's default
 * branch) and the local branch of the same name. Without origin/HEAD, main, else master. Only
 * refs that exist. `output` is for-each-ref with REFS_FORMAT, `refs` its parsed form.
 */
export function trunkRefs(output: string, refs: readonly Ref[]): string[] {
  const names = new Set(refs.map((r) => r.name))
  let remoteDefault: string | undefined
  for (const line of output.split('\n')) {
    const f = line.split('\x00')
    if (f[0] === 'refs/remotes/origin/HEAD' && f[6]?.startsWith('refs/remotes/origin/')) remoteDefault = f[6].slice('refs/remotes/origin/'.length)
  }
  for (const b of [remoteDefault, 'main', 'master']) {
    if (!b) continue
    const found = [`refs/heads/${b}`, `refs/remotes/origin/${b}`].filter((n) => names.has(n))
    if (found.length) return found
  }
  return []
}
