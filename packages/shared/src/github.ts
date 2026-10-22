/**
 * GitHub, without signing in: which remotes are GitHub, and the pull request shapes that cross
 * IPC. The requests themselves run in the main process (apps/desktop/src/main/github/).
 */

/**
 * owner/repo for a github.com remote URL, or null for anything else. Handles the forms git
 * accepts: https://github.com/o/r(.git), git@github.com:o/r(.git), ssh://git@github.com/o/r.
 */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const u = url.trim()
  const m =
    /^(?:https?|git|ssh):\/\/(?:[^@/]+@)?(?:www\.)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(u) ??
    /^(?:[^@/]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(u)
  if (!m) return null
  const [, owner, repo] = m
  return owner && repo && !owner.startsWith('.') ? { owner, repo } : null
}

/**
 * The repository's GitHub remote: origin when it is on GitHub, else the first one that is. Main
 * (pull requests, avatars) and the renderer (where to push first) both pick with this, so they agree.
 */
export function pickGitHubRemote(remotes: { name: string; url: string }[]): { owner: string; repo: string; remote: string } | null {
  const found = remotes.map((r) => ({ remote: r.name, gh: parseGitHubRemote(r.url) })).filter((x) => x.gh)
  const pick = found.find((x) => x.remote === 'origin') ?? found[0]
  return pick ? { ...pick.gh!, remote: pick.remote } : null
}

/** An open pull request on the repository's GitHub remote. */
export interface PullRequest {
  number: number
  title: string
  author: string
  /** The PR's branch name (on the fork, when `fromFork`). */
  branch: string
  headSha: string
  base: string
  draft: boolean
  url: string
  fromFork: boolean
}

/** What the pull request list can show: why it is empty, or the PRs. */
export type PullRequestList =
  | { state: 'no-remote' }
  | { state: 'ok'; owner: string; repo: string; pulls: PullRequest[] }
