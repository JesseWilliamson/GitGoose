import { useAvatarImage } from '../lib/avatar'
import { hashColor, initials, laneColor } from '../lib/format'

/**
 * An author's avatar for HTML contexts (author column, commit details): initials on a coloured
 * disc until the image has loaded, then the image alone on no background (see useAvatarImage).
 */
export function Avatar({ name, email, src, size }: { name: string; email: string; src: string | null; size: number }) {
  const { status, onLoad, onError } = useAvatarImage(src)
  const loaded = status === 'loaded'
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold text-white"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: loaded ? undefined : laneColor(hashColor(email)) }}
      title={`${name} <${email}>`} data-avatar={status}>
      {!loaded && initials(name)}
      {src && status !== 'failed' && <img src={src} alt="" onLoad={onLoad} onError={onError} className="absolute inset-0 size-full object-cover" />}
    </span>
  )
}

/** The people on a commit, in the order to stack them: the author first, then its co-authors. */
export interface StackedAuthor {
  name: string
  email: string
  src: string | null
}

/**
 * Overlapping avatars for a co-authored commit, as GitHub stacks them: the author on top, each
 * co-author tucked a third of an avatar behind it, ringed in the page colour so the edges stay
 * readable. Past `max` people the stack ends in a "+N". One person draws as a plain avatar, so
 * the ordinary row is unchanged.
 */
export function AvatarStack({ people, size, max = 3 }: { people: StackedAuthor[]; size: number; max?: number }) {
  const shown = people.slice(0, max)
  const extra = people.length - shown.length
  const overlap = Math.round(size / 3)
  return (
    <span className="flex shrink-0 items-center">
      {shown.map((p, i) => (
        // Later siblings paint over earlier ones, so the z-index has to say otherwise.
        <span key={`${p.email}|${p.name}`} className="relative inline-flex rounded-full"
          style={i ? { marginLeft: -overlap, zIndex: shown.length - i, boxShadow: '0 0 0 1.5px var(--gs-bg)' } : { zIndex: shown.length }}>
          <Avatar name={p.name} email={p.email} src={p.src} size={size} />
        </span>
      ))}
      {extra > 0 && (
        <span className="ml-1 shrink-0 text-2xs font-medium text-faint" title={people.slice(max).map((p) => `${p.name} <${p.email}>`).join('\n')}>
          +{extra}
        </span>
      )}
    </span>
  )
}
