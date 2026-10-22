import type { Repo } from '@gitgoose/git'
import { pickGitHubRemote } from '@gitgoose/shared'

export interface GitHubRemote {
  owner: string
  repo: string
  /** The remote's name in this repository (origin, upstream, …). */
  remote: string
}

/**
 * The repository's GitHub remote (origin first), or null. Read each time, not cached: it is one
 * cheap config read, and remotes can be added, renamed or re-pointed from the app at any moment.
 */
export async function githubRemote(repo: Repo): Promise<GitHubRemote | null> {
  try {
    const r = await repo.runner.run(['config', '-z', '--get-regexp', '^remote\\..*\\.url$'], { readOnly: true, okCodes: [1] })
    // -z: "remote.<name>.url\n<value>\0" per entry.
    return pickGitHubRemote(r.stdout.split('\0').filter(Boolean).map((entry) => {
      const nl = entry.indexOf('\n')
      return { name: entry.slice('remote.'.length, nl - '.url'.length), url: entry.slice(nl + 1) }
    }))
  } catch {
    return null
  }
}
