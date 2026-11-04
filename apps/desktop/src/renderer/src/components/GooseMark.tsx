/**
 * The GitGoose mark: a goose's head and neck, white on the app's indigo, with an orange beak.
 * Drawn inline (no image file), so it follows the theme's accent and stays sharp at any scale.
 */
export function GooseMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden data-testid="goose-mark">
      <rect width="24" height="24" rx="6" fill="var(--gs-accent)" />
      {/* Body and neck: one stroke, from the tail up to the head. */}
      <path d="M8.6 18.6c-2.4 0-3.6-1.5-3.6-3.1 0-2.3 2.3-3.5 4.6-3.5h1.6V8.4" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12.6" cy="7.3" r="2.7" fill="#fff" />
      <path d="M14.9 6.5l3.4 1.1-3.4 1.1z" fill="#ff9f43" />
      <circle cx="13.1" cy="6.7" r="0.6" fill="var(--gs-accent)" />
      {/* A wing, as a commit on the line. */}
      <circle cx="16" cy="15.4" r="2.1" fill="none" stroke="#fff" strokeWidth="1.6" />
      <path d="M11.2 15.4h2.7" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
