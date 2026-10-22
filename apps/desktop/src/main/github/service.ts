import type { Repo } from '@gitgoose/git'
import type { PullRequestList } from '@gitgoose/shared'
import type { AvatarLookup } from '../avatars'
import { GitHubApi } from './api'
import { lookupAuthorAvatar } from './avatarLookup'
import type { GitHubEndpoints } from './config'
import { githubRemote } from './remote'

/**
 * Everything the app asks GitHub, in one place, and all of it without signing in. Plain Node (no
 * Electron imports): index.ts wires it to net.fetch and the open repositories.
 *
 *   - avatars: which GitHub account wrote a commit (GET /repos/:o/:r/commits/:sha)
 *   - pull requests: list them when the user opens the list (public repositories only)
 *   - a new pull request: GitHub's own compare page, opened in the browser
 *
 * One GitHubApi serves all of it, so avatars and the pull request list share one rate limit.
 */
export interface GitHubServiceDeps {
  endpoints: GitHubEndpoints
  fetch: typeof fetch
  /** The open repositories (avatars look for the author's commits in them). */
  repos: () => Repo[]
  now?: () => number
}

export class GitHubService {
  readonly api: GitHubApi

  constructor(private deps: GitHubServiceDeps) {
    this.api = new GitHubApi({ base: deps.endpoints.api, fetch: deps.fetch, now: deps.now })
  }

  /** The avatar for an author email, via a pushed commit of theirs that GitHub knows. */
  authorAvatar(email: string): Promise<AvatarLookup> {
    return lookupAuthorAvatar(email, this.deps.repos(), this.api)
  }

  /** Open pull requests of the repository's GitHub remote. Called only when the user asks. */
  async pullRequests(repo: Repo): Promise<PullRequestList> {
    const gh = await githubRemote(repo)
    if (!gh) return { state: 'no-remote' }
    const pulls = await this.api.pulls(gh.owner, gh.repo)
    return { state: 'ok', owner: gh.owner, repo: gh.repo, pulls }
  }

  /**
   * GitHub's page for opening a pull request from `branch` into `base`, with the title and
   * description filled in. Creating one through the API needs a token; this page lets the user
   * finish it in the browser, where they are signed in already.
   */
  async compareUrl(repo: Repo, pr: { branch: string; base: string; title: string; body: string }): Promise<string> {
    const gh = await githubRemote(repo)
    if (!gh) throw new Error('This repository has no GitHub remote.')
    // Branch names keep their slashes (feature/x): GitHub reads the path as base...head.
    const ref = (name: string) => encodeURIComponent(name).replace(/%2F/g, '/')
    const query = [`expand=1`, `title=${encodeURIComponent(pr.title)}`, ...(pr.body ? [`body=${encodeURIComponent(pr.body)}`] : [])].join('&')
    return `${this.deps.endpoints.web}/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/compare/${ref(pr.base)}...${ref(pr.branch)}?${query}`
  }

  /** The remote that points at GitHub (for fetching pull/N/head). */
  async remoteName(repo: Repo): Promise<string | null> {
    return (await githubRemote(repo))?.remote ?? null
  }

  /** A page on the configured GitHub host (nothing else is opened from these calls). */
  isGitHubUrl(url: string): boolean {
    return url.startsWith(this.deps.endpoints.web + '/')
  }
}
