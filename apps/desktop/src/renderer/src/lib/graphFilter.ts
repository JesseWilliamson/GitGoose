import type { GraphFilter, Ref } from '@gitgoose/shared'

/**
 * Whether a branch shows in the graph under the repository's filter: not hidden (by name, or with
 * its whole remote), and among the soloed ones when anything is soloed. The checked-out branch
 * always shows; the graph is never without HEAD.
 */
export function refShown(r: Ref, filter: GraphFilter, headBranch: string | undefined): boolean {
  if (r.kind === 'local' && r.shortName === headBranch) return true
  const remote = r.kind === 'remote' ? `refs/remotes/${r.shortName.split('/')[0]}/*` : null
  if (filter.hidden.includes(r.name) || (remote && filter.hidden.includes(remote))) return false
  return !filter.solo.length || filter.solo.includes(r.name)
}
