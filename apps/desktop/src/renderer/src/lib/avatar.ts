import type { AvatarSource } from '@gitsquid/shared'
import { useStore } from './store'

/**
 * The image URL for an author, or null to show initials only. The URL is served by the main
 * process (src/main/avatars.ts); the page itself never reaches the network.
 */
export function avatarSrc(email: string, source: AvatarSource, variant = ''): string | null {
  if (source === 'initials' || !email) return null
  const url = `gitsquid-avatar://author/${encodeURIComponent(email.trim().toLowerCase())}`
  // The browser caches images by URL. Signing in to GitHub can turn a miss (initials) into a
  // picture, so the sign-in state is part of the URL: the change makes the page ask again.
  return variant ? `${url}?v=${variant}` : url
}

/** "gh" while signed in to GitHub (see avatarSrc). */
export function useAvatarVariant(): string {
  return useStore((s) => (s.github?.account ? 'gh' : ''))
}
