import type { AvatarSource } from '@gitgoose/shared'
import { useState } from 'react'

/**
 * The image URL for an author, or null to show initials only (then nothing is requested). The
 * URL is served by the main process (src/main/avatars.ts), which answers 404 when there is no
 * picture; the page itself never reaches the network.
 */
export function avatarSrc(email: string, source: AvatarSource): string | null {
  if (source === 'initials' || !email) return null
  return `gitgoose-avatar://author/${encodeURIComponent(email.trim().toLowerCase())}`
}

/**
 * Images that have loaded once this session. Rows are virtualized, so an avatar is mounted again
 * on every scroll; one already known to load starts as loaded (the image is in the browser's
 * cache) instead of flashing the initials for a frame.
 */
const known = new Set<string>()

export type AvatarStatus = 'none' | 'loading' | 'loaded' | 'failed'

/**
 * Where an avatar image is: none (initials only), loading, loaded or failed. The initials and
 * their coloured disc are drawn until it has loaded, so an image with transparent parts sits on
 * the page, not on the lane colour. A failed image (a 404 for an author without a picture) is
 * removed and the initials stay.
 */
export function useAvatarImage(src: string | null): { status: AvatarStatus; onLoad: () => void; onError: () => void } {
  const initial = (s: string | null): AvatarStatus => (!s ? 'none' : known.has(s) ? 'loaded' : 'loading')
  const [state, setState] = useState(() => ({ src, status: initial(src) }))
  // A new src (another author in a reused row, or the setting changed) starts over.
  let current = state
  if (state.src !== src) {
    current = { src, status: initial(src) }
    setState(current)
  }
  return {
    status: current.status,
    onLoad: () => {
      if (!src) return
      known.add(src)
      setState({ src, status: 'loaded' })
    },
    onError: () => {
      if (src) known.delete(src)
      setState({ src, status: 'failed' })
    },
  }
}
