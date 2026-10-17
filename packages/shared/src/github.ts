/**
 * GitHub sign-in: the shapes that cross IPC, and the pure rules (which remotes are GitHub, which
 * credential prompts the sign-in may answer). The flow itself runs in the main process
 * (apps/desktop/src/main/github/).
 */

export interface GitHubAccount {
  login: string
  name: string | null
  avatarUrl: string
  /** Granted OAuth scopes, e.g. ["read:user"] or ["read:user", "repo"]. */
  scopes: string[]
}

export interface GitHubStatus {
  /** False when this build has no OAuth client id (sign-in is then unavailable). */
  configured: boolean
  account: GitHubAccount | null
  /** False when there is no OS keychain: signed in until quit only. */
  persisted: boolean
}

/** What the sign-in dialog shows while GitHub waits for the user to enter the code. */
export interface DeviceCodeInfo {
  userCode: string
  verificationUri: string
  /** Seconds until the code expires. */
  expiresIn: number
}

/** The scopes each feature needs. Sign-in asks for `basic`; HTTPS auth asks again for `repo`. */
export const GITHUB_SCOPES = {
  basic: ['read:user'],
  repo: ['read:user', 'repo'],
} as const

export function hasScope(account: GitHubAccount | null, scope: string): boolean {
  return !!account?.scopes.includes(scope)
}

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
 * Which part of a git credential prompt this is, when it is for https://github.com exactly.
 * Git asks "Username for 'https://github.com': " and then
 * "Password for 'https://user@github.com': ". The host must match exactly: the token must never
 * be offered to github.com.evil.example or to an http:// URL.
 */
export function githubPromptKind(prompt: string): 'username' | 'password' | null {
  const m = /^(Username|Password) for 'https:\/\/(?:[^@'/]+@)?github\.com\/?'\s*:?\s*$/.exec(prompt.trim())
  if (!m) return null
  return m[1] === 'Username' ? 'username' : 'password'
}
