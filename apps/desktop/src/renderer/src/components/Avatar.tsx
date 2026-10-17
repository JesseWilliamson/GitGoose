import { useState } from 'react'
import { hashColor, initials, laneColor } from '../lib/format'

/** An author's avatar for HTML contexts (author column, commit details): initials under the image. */
export function Avatar({ name, email, src, size }: { name: string; email: string; src: string | null; size: number }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold text-white"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: laneColor(hashColor(email)) }} title={`${name} <${email}>`}>
      {initials(name)}
      {src && !failed && <img src={src} alt="" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />}
    </span>
  )
}
