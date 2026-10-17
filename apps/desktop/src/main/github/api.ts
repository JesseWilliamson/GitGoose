/** The two GitHub REST calls the app makes. Plain Node; fetch is passed in. */

export class GitHubAuthError extends Error {
  constructor() {
    super('GitHub no longer accepts this sign-in (the token was revoked or expired).')
    this.name = 'GitHubAuthError'
  }
}

export class GitHubApi {
  constructor(private base: string, private token: string, private fetchFn: typeof fetch) {}

  private async get(path: string): Promise<Response> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 401) throw new GitHubAuthError()
    return res
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
