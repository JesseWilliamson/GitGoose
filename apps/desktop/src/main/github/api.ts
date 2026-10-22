/**
 * The GitHub REST calls the app makes, all without signing in. Plain Node: fetch and the clock
 * are passed in, so tests drive it with a fake.
 *
 * Without a token GitHub allows 60 API requests an hour per IP address. When it says the limit is
 * used up we remember until when, and every call before then fails at once with
 * RateLimitedError, without a request: asking again early only earns another refusal.
 */

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

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export class RateLimitedError extends Error {
  readonly code = 'github-rate-limited'
  constructor(readonly until: number) {
    super(`GitHub allows 60 requests an hour without signing in, and they are used up until ${clock(until)}.`)
    this.name = 'RateLimitedError'
  }
}

/** GitHub's advice when a limit response says nothing more: wait at least a minute. */
const DEFAULT_PAUSE_MS = 60_000

/**
 * Until when (ms since the epoch) GitHub must not be asked again, from a response's headers, or 0
 * when it may. A refusal (403 or 429) gives the time by `retry-after` (seconds from now), or by
 * `x-ratelimit-reset` (unix seconds) once `x-ratelimit-remaining` is 0. A success with nothing
 * remaining also pauses: the next request would only be refused.
 */
export function rateLimitPause(res: Response, now: number): number {
  const remaining = res.headers.get('x-ratelimit-remaining')
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  const retryAfter = Number(res.headers.get('retry-after'))
  const atReset = remaining === '0' && reset > 0 ? reset * 1000 : 0
  if (res.status !== 403 && res.status !== 429) return atReset > now ? atReset : 0
  let until = 0
  if (retryAfter > 0) until = now + retryAfter * 1000
  else if (atReset) until = atReset
  // A 403 with no rate limit headers at all is some other refusal, not a limit.
  else if (res.status === 429 || remaining !== null) until = now + DEFAULT_PAUSE_MS
  else return 0
  // A reset time already past (a clock off by a little) still means "not right now".
  return Math.max(until, now + 1000)
}

export interface GitHubApiDeps {
  /** https://api.github.com, or a test's fake. */
  base: string
  fetch: typeof fetch
  now?: () => number
}

export class GitHubApi {
  private limitedUntil = 0
  /** Repositories GitHub answered 404 for (private, or gone): not asked about again this session. */
  private hidden = new Set<string>()
  /** Requests actually sent (tests use it to prove a pause sends nothing). */
  requests = 0

  constructor(private deps: GitHubApiDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Until when GitHub is not asked (the rate limit), or 0 when it may be. */
  pausedUntil(): number {
    return this.limitedUntil > this.now() ? this.limitedUntil : 0
  }

  private async get(path: string): Promise<Response> {
    const paused = this.pausedUntil()
    if (paused) throw new RateLimitedError(paused)
    this.requests++
    // No Authorization header, ever: GitGoose does not sign in to GitHub.
    const res = await this.deps.fetch(`${this.deps.base}${path}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15_000),
    })
    const until = rateLimitPause(res, this.now())
    if (until) this.limitedUntil = Math.max(this.limitedUntil, until)
    if (until && (res.status === 403 || res.status === 429)) throw new RateLimitedError(until)
    return res
  }

  async pulls(owner: string, repo: string): Promise<PullRequest[]> {
    const res = await this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=100`)
    if (res.status === 404) throw new Error('GitHub answered 404: it lists pull requests only for public repositories when not signed in, and GitGoose does not sign in.')
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string }
      throw new Error(`Could not list pull requests: ${body.message || `GitHub answered ${res.status}`}`)
    }
    return ((await res.json()) as RawPull[]).map((p) => toPull(p, owner, repo))
  }

  /**
   * The avatar of the GitHub account GitHub attributes this commit to (by any of that account's
   * verified emails), or null when GitHub says it has no such account, commit or repository.
   * Throws when GitHub could not answer (rate limit, network, server error): that is no answer.
   */
  async commitAuthorAvatar(owner: string, repo: string, sha: string): Promise<string | null> {
    const key = `${owner}/${repo}`.toLowerCase()
    if (this.hidden.has(key)) return null
    const res = await this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`)
    if (res.status === 404) {
      this.hidden.add(key)
      return null
    }
    // 422: GitHub does not have this commit.
    if (res.status === 422) return null
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const c = (await res.json()) as { author?: { avatar_url?: string } | null }
    return c.author?.avatar_url ?? null
  }
}
