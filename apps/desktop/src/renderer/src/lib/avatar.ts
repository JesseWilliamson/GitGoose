import type { AvatarSource } from '@gitsquid/shared'

/**
 * The image URL for an author, or null to show initials only. The URL is served by the main
 * process (src/main/avatars.ts); the page itself never reaches the network.
 */
export function avatarSrc(email: string, source: AvatarSource): string | null {
  if (source === 'initials' || !email) return null
  return `gitsquid-avatar://author/${encodeURIComponent(email.trim().toLowerCase())}`
}
