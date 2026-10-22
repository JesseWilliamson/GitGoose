import type { Repo } from '@gitgoose/git'
import type { AvatarLookup } from '../avatars'
import { RateLimitedError, type GitHubApi } from './api'
import { githubRemote } from './remote'

/**
 * Which GitHub account wrote an author's commits, without signing in: find the author's newest
 * commit that is already on a GitHub remote of an open repository, and ask GitHub's public commits
 * API who it belongs to (GitHub matches the commit email against every account's verified emails).
 *
 * Only pushed commits are looked up (the remote's tracking refs): GitHub cannot know the others,
 * so asking about them would spend the hourly limit on certain misses.
 */
export async function lookupAuthorAvatar(email: string, repos: Repo[], api: GitHubApi): Promise<AvatarLookup> {
  let answered = false
  for (const repo of repos) {
    const gh = await githubRemote(repo)
    if (!gh) continue
    const sha = (await repo.runner.run(
      ['log', '-1', '--format=%H', '--fixed-strings', '--regexp-ignore-case', `--author=<${email}>`, `--remotes=${gh.remote}`],
      { readOnly: true },
    ).catch(() => ({ stdout: '' }))).stdout.trim()
    if (!sha) continue
    try {
      const url = await api.commitAuthorAvatar(gh.owner, gh.repo, sha)
      answered = true
      if (url) return { kind: 'url', url: sized(url) }
    } catch (e) {
      // No answer (the hourly limit, or GitHub unreachable): nothing learnt, ask again later.
      return { kind: 'later', until: e instanceof RateLimitedError ? e.until : undefined }
    }
  }
  // 'none' only when GitHub itself said it knows no account. Without a GitHub remote or a pushed
  // commit nobody was asked, and opening another repository or fetching may change that.
  return answered ? { kind: 'none' } : { kind: 'later' }
}

/** GitHub avatar URLs take a size; 64 px covers the graph at 2x. */
function sized(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.set('s', '64')
    return u.toString()
  } catch {
    return url
  }
}
