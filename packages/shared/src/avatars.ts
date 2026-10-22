/** Where an author's avatar comes from, by email. Pure, so it is shared and unit-tested. */

/** 'initials' never touches the network; 'github' asks GitHub without signing in (src/main/avatars.ts). */
export type AvatarSource = 'initials' | 'github'

/** Where GitHub serves avatar images. Tests point the app at a local stand-in instead. */
export const DEFAULT_AVATAR_BASE = 'https://avatars.githubusercontent.com'

/** "12345+octocat@users.noreply.github.com" -> 12345; older noreply addresses have no id. */
export function githubNoreplyId(email: string): string | null {
  return /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i.exec(email.trim())?.[1] ?? null
}

/**
 * The image URL for a GitHub noreply address, which names the account by id, so no API call is
 * needed. Null for any other address (main then asks GitHub's commits API, see avatars.ts).
 */
export function noreplyAvatarUrl(email: string, base: string = DEFAULT_AVATAR_BASE): string | null {
  const id = githubNoreplyId(email)
  return id ? `${base}/u/${id}?s=64&v=4` : null
}
