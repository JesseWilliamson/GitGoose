/** Where an author's avatar comes from, by email. Pure, so it is shared and unit-tested. */

export type AvatarSource = 'initials' | 'github' | 'gravatar'

export interface AvatarBases {
  github: string
  gravatar: string
}

export const DEFAULT_AVATAR_BASES: AvatarBases = {
  github: 'https://avatars.githubusercontent.com',
  gravatar: 'https://gravatar.com',
}

/** "12345+octocat@users.noreply.github.com" -> 12345; older noreply addresses have no id. */
export function githubNoreplyId(email: string): string | null {
  return /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i.exec(email.trim())?.[1] ?? null
}

/**
 * The image URL for an author, or null when this source cannot know them (the initials then show).
 * `sha256Hex` is passed in so this file needs no crypto import (it also runs in the renderer).
 */
export function avatarUrl(email: string, source: AvatarSource, sha256Hex: (s: string) => string, bases: AvatarBases = DEFAULT_AVATAR_BASES): string | null {
  const e = email.trim().toLowerCase()
  if (!e || source === 'initials') return null
  if (source === 'github') {
    const id = githubNoreplyId(e)
    return id ? `${bases.github}/u/${id}?s=64&v=4` : null
  }
  return `${bases.gravatar}/avatar/${sha256Hex(e)}?s=64&d=404`
}
