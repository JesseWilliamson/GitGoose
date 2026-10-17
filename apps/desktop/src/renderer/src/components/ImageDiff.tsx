import type { DiffTarget, ImageSide } from '@gitsquid/shared'
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { reportError } from '../lib/store'

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml',
}

export function imageMime(path: string): string | undefined {
  return MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()]
}

type Mode = '2-up' | 'swipe' | 'onion'

interface Loaded {
  url: string | null
  size: number
  tooBig: boolean
  w?: number
  h?: number
}

/**
 * Before and after for an image, in three views: side by side,
 * a swipe divider over the two, or the new one faded over the old (onion skin). Loaded only when
 * shown; files over the size cap show their size instead.
 */
export function ImageDiff({ repoId, target, path }: { repoId: string; target: DiffTarget; path: string }) {
  const [sides, setSides] = useState<{ old: Loaded | null; new: Loaded | null } | null>(null)
  const [mode, setMode] = useState<Mode>('2-up')
  const [amount, setAmount] = useState(50)
  const key = JSON.stringify(target)

  useEffect(() => {
    let live = true
    const urls: string[] = []
    const load = (s: ImageSide | null): Loaded | null => {
      if (!s) return null
      if (!s.data) return { url: null, size: s.size, tooBig: true }
      const url = URL.createObjectURL(new Blob([s.data as BlobPart], { type: imageMime(path) }))
      urls.push(url)
      return { url, size: s.size, tooBig: false }
    }
    api.imagePair(repoId, target).then((p) => {
      if (live) setSides({ old: load(p.old), new: load(p.new) })
    }, (e) => reportError('Could not load the image', e))
    return () => {
      live = false
      urls.forEach((u) => URL.revokeObjectURL(u))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, key])

  if (!sides) return <div className="flex flex-1 items-center justify-center text-sm text-faint">Loading image…</div>
  const both = !!sides.old?.url && !!sides.new?.url
  const measured = (which: 'old' | 'new') => (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    setSides((s) => s && { ...s, [which]: { ...s[which]!, w: img.naturalWidth, h: img.naturalHeight } })
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="image-diff">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-3 text-xs">
        {(['2-up', 'swipe', 'onion'] as Mode[]).map((m) => (
          <button key={m} disabled={!both && m !== '2-up'} onClick={() => setMode(m)}
            className={clsx('rounded px-2 py-1 disabled:opacity-40', mode === m ? 'bg-select font-medium' : 'text-muted hover:bg-hover')}>
            {m === '2-up' ? 'Side by side' : m === 'swipe' ? 'Swipe' : 'Onion skin'}
          </button>
        ))}
        {mode !== '2-up' && both && (
          <input type="range" min={0} max={100} value={amount} onChange={(e) => setAmount(Number(e.target.value))} className="ml-3 w-40" aria-label={mode === 'swipe' ? 'Divider' : 'Opacity'} />
        )}
      </div>
      <div className="checkerboard min-h-0 flex-1 overflow-auto p-6">
        {mode === '2-up' || !both ? (
          <div className="flex flex-wrap items-start justify-center gap-6">
            <Side label="Before" side={sides.old} onLoad={measured('old')} testId="image-old" />
            <Side label="After" side={sides.new} onLoad={measured('new')} testId="image-new" />
          </div>
        ) : (
          <div className="flex justify-center">
            <div className="relative inline-block">
              <img src={sides.old!.url!} alt="Before" className="block max-w-none" />
              <img src={sides.new!.url!} alt="After" className="absolute top-0 left-0 block max-w-none"
                style={mode === 'swipe' ? { clipPath: `inset(0 0 0 ${amount}%)` } : { opacity: amount / 100 }} />
              {mode === 'swipe' && <div className="absolute top-0 bottom-0 w-px bg-accent" style={{ left: `${amount}%` }} />}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Side({ label, side, onLoad, testId }: { label: string; side: Loaded | null; onLoad: (e: React.SyntheticEvent<HTMLImageElement>) => void; testId: string }) {
  return (
    <figure className="flex max-w-full flex-col items-center gap-2" data-testid={testId}>
      <figcaption className="rounded bg-panel/90 px-2 py-0.5 text-[11px] text-muted">
        {label}{side ? ` · ${formatBytes(side.size)}${side.w ? ` · ${side.w}×${side.h}` : ''}` : ''}
      </figcaption>
      {!side ? <div className="rounded bg-panel/90 px-3 py-6 text-xs text-faint">{label === 'Before' ? 'Added in this change' : 'Deleted in this change'}</div>
        : side.tooBig ? <div className="rounded bg-panel/90 px-3 py-6 text-xs text-faint">Too large to show ({formatBytes(side.size)})</div>
        : <img src={side.url!} alt={label} onLoad={onLoad} className="max-h-[70vh] max-w-full border border-line object-contain" />}
    </figure>
  )
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}
