import type { Repo } from '@gitsquid/git'
import { githubPromptKind, parseGitHubRemote, type DeviceCodeInfo, type GitHubAccount, type GitHubStatus } from '@gitsquid/shared'
import { GitHubApi, GitHubAuthError } from './api'
import { DeviceFlowError, pollForToken, requestDeviceCode, type DeviceCode, type FlowDeps, type GitHubEndpoints } from './deviceFlow'
import type { TokenStore } from './tokenStore'

/**
 * Everything "signed in with GitHub" means, in one place. Plain Node (no Electron imports):
 * index.ts wires it to safeStorage, net.fetch and the window.
 *
 * What the token is used for, and nothing else:
 *   - avatars: which GitHub account wrote a commit (GET /repos/:o/:r/commits/:sha)
 *   - HTTPS push/fetch to github.com, only with the "repo" scope and the setting on
 */
export interface GitHubServiceDeps {
  endpoints: GitHubEndpoints
  store: TokenStore
  fetch: typeof fetch
  sleep?: FlowDeps['sleep']
  /** The open repositories (avatars look for the author's commits in them). */
  repos: () => Repo[]
  /** The "Use GitHub sign-in for HTTPS" setting. */
  httpsEnabled: () => boolean
  onChange: (status: GitHubStatus) => void
}

export class GitHubService {
  private flow: { code: DeviceCode; abort: AbortController; done: Promise<GitHubAccount> } | null = null
  /** The last flow's outcome, for a wait that arrives after polling already finished. */
  private last: Promise<GitHubAccount> | null = null
  private persisted = true
  /** owner/repo per repository path: remotes rarely change, and this runs per unknown author. */
  private remotes = new Map<string, Promise<{ owner: string; repo: string; remote: string } | null>>()

  constructor(private deps: GitHubServiceDeps) {}

  status(): GitHubStatus {
    const s = this.deps.store.load()
    return { configured: !!this.deps.endpoints.clientId, account: s?.account ?? null, persisted: s ? this.persisted : true }
  }

  /** Start a device flow and return the code to show. Polling continues in the background. */
  async startSignIn(scopes: readonly string[]): Promise<DeviceCodeInfo> {
    this.cancelSignIn()
    const abort = new AbortController()
    const flowDeps = { fetch: this.deps.fetch, sleep: this.deps.sleep }
    const code = await requestDeviceCode(this.deps.endpoints, scopes, flowDeps, abort.signal)
    const done = pollForToken(this.deps.endpoints, code, flowDeps, abort.signal).then(async ({ token, scopes: granted }) => {
      const user = await new GitHubApi(this.deps.endpoints.api, token, this.deps.fetch).user()
      const account: GitHubAccount = { ...user, scopes: granted }
      this.persisted = this.deps.store.save(account, token).persisted
      this.remotes.clear()
      this.deps.onChange(this.status())
      return account
    }).finally(() => {
      if (this.flow?.abort === abort) this.flow = null
    })
    // Nobody may be waiting yet (the renderer asks next); do not let a rejection go unhandled.
    done.catch(() => {})
    this.flow = { code, abort, done }
    this.last = done
    return { userCode: code.userCode, verificationUri: code.verificationUri, expiresIn: code.expiresIn }
  }

  /** Resolves when the user approves on GitHub; rejects on denial, expiry or cancel. */
  waitForSignIn(): Promise<GitHubAccount> {
    return this.flow?.done ?? this.last ?? Promise.reject(new DeviceFlowError('cancelled'))
  }

  /**
   * A GitHub page to open in the browser. Main opens it, so the renderer never chooses a URL,
   * and the code page from GitHub's answer must be on GitHub's own host.
   */
  pageUrl(page: 'verification' | 'applications'): string | null {
    const web = this.deps.endpoints.web
    if (page === 'applications') return `${web}/settings/connections/applications/${encodeURIComponent(this.deps.endpoints.clientId)}`
    const uri = this.flow?.code.verificationUri
    return uri && uri.startsWith(web + '/') ? uri : null
  }

  cancelSignIn(): void {
    this.flow?.abort.abort()
    this.flow = null
    this.last = null
  }

  /**
   * Forget the token. GitHub's revoke endpoint needs the OAuth App's client secret, which a
   * desktop app cannot keep secret (that is why it uses the device flow), so the grant itself is
   * removed on github.com: the Accounts panel links to the page.
   */
  signOut(): void {
    this.cancelSignIn()
    this.deps.store.clear()
    this.persisted = true
    this.remotes.clear()
    this.deps.onChange(this.status())
  }

  /** A key that changes with sign-in, so avatars missed while signed out are looked up again. */
  avatarVariant(): string {
    return this.deps.store.load() ? 'gh' : ''
  }

  /** The avatar image URL for an author email, via a commit of theirs that GitHub knows. */
  async resolveAvatar(email: string): Promise<string | null> {
    const stored = this.deps.store.load()
    if (!stored) return null
    const api = new GitHubApi(this.deps.endpoints.api, stored.token, this.deps.fetch)
    for (const repo of this.deps.repos()) {
      const gh = await this.githubRemote(repo)
      if (!gh) continue
      // Only commits already on that remote: GitHub cannot know about unpushed ones.
      const sha = (await repo.runner.run(
        ['log', '-1', '--format=%H', '--fixed-strings', '--regexp-ignore-case', `--author=<${email}>`, `--remotes=${gh.remote}`],
        { readOnly: true },
      )).stdout.trim()
      if (!sha) continue
      try {
        const url = await api.commitAuthorAvatar(gh.owner, gh.repo, sha)
        if (url) return sized(url)
      } catch (e) {
        if (e instanceof GitHubAuthError) return null
      }
    }
    return null
  }

  private githubRemote(repo: Repo) {
    let p = this.remotes.get(repo.path)
    if (!p) {
      p = repo.runner.run(['config', '-z', '--get-regexp', '^remote\\..*\\.url$'], { readOnly: true, okCodes: [1] }).then((r) => {
        // -z: "remote.<name>.url\n<value>\0" per entry. origin first, then the others.
        const found = r.stdout.split('\0').filter(Boolean).map((entry) => {
          const nl = entry.indexOf('\n')
          const name = entry.slice('remote.'.length, nl - '.url'.length)
          return { name, gh: parseGitHubRemote(entry.slice(nl + 1)) }
        }).filter((x) => x.gh)
        found.sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'))
        const first = found[0]
        return first ? { ...first.gh!, remote: first.name } : null
      }, () => null)
      this.remotes.set(repo.path, p)
    }
    return p
  }

  /** Answer git's credential prompt for https://github.com, when the user turned that on. */
  answerPrompt(prompt: string): string | null {
    const active = this.httpsActive()
    if (!active) return null
    const kind = githubPromptKind(prompt)
    if (kind === 'username') return active.account.login
    if (kind === 'password') return active.token
    return null
  }

  private httpsActive() {
    const s = this.deps.store.load()
    return this.deps.httpsEnabled() && s?.account.scopes.includes('repo') ? s : null
  }

  /**
   * Environment for every git command. While the token answers github.com's prompts, the user's
   * credential helpers are switched off for https://github.com only: otherwise git would hand
   * our token to them after a successful push, and `credential.helper=store` writes it to
   * ~/.git-credentials in clear text. GIT_CONFIG_COUNT/KEY/VALUE is config from the environment
   * (git 2.31+); an empty helper value resets the list for that URL.
   */
  credentialEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
    if (!this.httpsActive()) return {}
    const n = Number(base.GIT_CONFIG_COUNT ?? 0) || 0
    return {
      GIT_CONFIG_COUNT: String(n + 1),
      [`GIT_CONFIG_KEY_${n}`]: 'credential.https://github.com.helper',
      [`GIT_CONFIG_VALUE_${n}`]: '',
    }
  }
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
