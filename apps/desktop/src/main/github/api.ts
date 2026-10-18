/** The GitHub REST calls the app makes. Plain Node; fetch is passed in. */

import type { PullRequest } from '@gitgoose/shared'

interface RawPull {
  number: number
  title: string
  draft?: boolean
  html_url: string
  user?: { login?: string } | null
  head: { ref: string; sha: string; repo?: { full_name?: string } | null }
  base: { ref: string }
}

function toPull(p: RawPull, owner: string, repo: string): PullRequest {
  return {
    number: p.number, title: p.title, author: p.user?.login ?? '', branch: p.head.ref, headSha: p.head.sha,
    base: p.base.ref, draft: !!p.draft, url: p.html_url,
    fromFork: (p.head.repo?.full_name ?? '').toLowerCase() !== `${owner}/${repo}`.toLowerCase(),
  }
}

export class GitHubAuthError extends Error {
  constructor() {
    super('GitHub no longer accepts this sign-in (the token was revoked or expired).')
    this.name = 'GitHubAuthError'
  }
}

export class GitHubApi {
  constructor(private base: string, private token: string, private fetchFn: typeof fetch) {}

  private async get(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 401) throw new GitHubAuthError()
    return res
  }

  /** GitHub's own words for a failed call ("Validation Failed: A pull request already exists…"). */
  private async failure(res: Response, what: string): Promise<Error> {
    const body = (await res.json().catch(() => ({}))) as { message?: string; errors?: { message?: string }[] }
    const detail = [body.message, ...(body.errors ?? []).map((e) => e.message)].filter(Boolean).join(': ')
    if (res.status === 404 || res.status === 403) return new Error(`${what}: GitHub said ${res.status}${detail ? ` (${detail})` : ''}. Private repositories need sign-in with repository access.`)
    return new Error(`${what}: ${detail || `GitHub answered ${res.status}`}`)
  }

  async pulls(owner: string, repo: string): Promise<PullRequest[]> {
    const res = await this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=100`)
    if (!res.ok) throw await this.failure(res, 'Could not list pull requests')
    return ((await res.json()) as RawPull[]).map((p) => toPull(p, owner, repo))
  }

  async createPull(owner: string, repo: string, pr: { title: string; body: string; head: string; base: string; draft: boolean }): Promise<PullRequest> {
    const res = await this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, { method: 'POST', body: pr })
    if (!res.ok) throw await this.failure(res, 'Could not create the pull request')
    return toPull((await res.json()) as RawPull, owner, repo)
  }

  async user(): Promise<{ login: string; name: string | null; avatarUrl: string }> {
    const res = await this.get('/user')
    if (!res.ok) throw new Error(`GitHub: GET /user answered ${res.status}`)
    const u = (await res.json()) as { login: string; name: string | null; avatar_url: string }
    return { login: u.login, name: u.name ?? null, avatarUrl: u.avatar_url }
  }

  /**
   * The avatar of the GitHub account GitHub attributes this commit to (by any of that account's
   * verified emails), or null when the commit is unknown to GitHub or has no linked account.
   */
  async commitAuthorAvatar(owner: string, repo: string, sha: string): Promise<string | null> {
    const res = await this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}`)
    if (!res.ok) return null
    const c = (await res.json()) as { author?: { avatar_url?: string } | null }
    return c.author?.avatar_url ?? null
  }
}
