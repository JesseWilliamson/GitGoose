import type { SearchField } from '@gitgoose/shared'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { ensureLoaded, reportError, updateRepo, type RepoView } from '../lib/store'
import { Spinner } from './ui'

/**
 * Search over the graph: type, and every commit that does not match greys out
 * (the graph keeps its shape, so you see where matches sit in history). Enter and Shift+Enter,
 * or the arrows, move between matches; Esc closes it and the graph comes back.
 *
 * "Commits" searches message, author, SHA, branch and tag names at once (Repo.search 'all').
 * Files and Code are slower, separate walks, so they are opt-in scopes.
 */

const SCOPES: { value: SearchField; label: string; hint: string }[] = [
  { value: 'all', label: 'Commits', hint: 'Message, author, SHA, branches and tags' },
  { value: 'path', label: 'Files', hint: 'Commits that changed a matching file path' },
  { value: 'content', label: 'Code', hint: 'Commits that added or removed matching text' },
]

const DEBOUNCE_MS = 200

export function SearchBar({ view }: { view: RepoView }) {
  const s = view.search
  const [query, setQuery] = useState(s?.query ?? '')
  const [field, setField] = useState<SearchField>(s?.field && SCOPES.some((x) => x.value === s.field) ? s.field : 'all')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  /** Only the newest request may write results: an older one can finish after a newer one. */
  const latest = useRef(0)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [view.searchFocus])

  const go = async (hash: string) => {
    updateRepo(view.id, { selected: { kind: 'commit', hash } })
    await ensureLoaded(view.id, hash)
  }

  const run = async (q: string, f: SearchField) => {
    const id = ++latest.current
    if (!q.trim()) {
      setBusy(false)
      updateRepo(view.id, { search: null })
      return
    }
    setBusy(true)
    try {
      const hits = await api.search(view.id, f, q)
      if (id !== latest.current) return
      updateRepo(view.id, { search: { field: f, query: q, hits, index: 0 } })
      if (hits[0]) await go(hits[0])
    } catch (e) {
      if (id === latest.current) reportError('Search failed', e)
    } finally {
      if (id === latest.current) setBusy(false)
    }
  }

  // Live: search once typing pauses.
  useEffect(() => {
    if (s && s.query === query && s.field === field) return
    const t = setTimeout(() => void run(query, field), DEBOUNCE_MS)
    return () => clearTimeout(t)
    // `s` is the result of this effect; re-running on it would loop.
  }, [query, field])

  const current = !!s && s.query === query && s.field === field
  const step = (d: number) => {
    if (!s || !s.hits.length) return
    const index = (s.index + d + s.hits.length) % s.hits.length
    updateRepo(view.id, { search: { ...s, index } })
    void go(s.hits[index]!)
  }

  const close = () => {
    latest.current++
    updateRepo(view.id, { search: null, searchOpen: false })
  }

  return (
    <div className="absolute top-1 right-9 z-20 flex h-8 w-[min(460px,calc(100%-2.5rem))] items-center rounded-md border border-accent bg-raised text-xs shadow-lg shadow-black/25"
      data-testid="search-bar" role="search">
      <select value={field} onChange={(e) => setField(e.target.value as SearchField)} title="Search in" data-testid="search-scope"
        className="h-full rounded-l-md border-r border-line bg-transparent px-1.5 text-muted outline-none">
        {SCOPES.map((f) => <option key={f.value} value={f.value} title={f.hint}>{f.label}</option>)}
      </select>
      <Search size={13} className="ml-2 shrink-0 text-faint" />
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (current) step(e.shiftKey ? -1 : 1)
            else void run(query, field)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          }
        }}
        placeholder={SCOPES.find((x) => x.value === field)!.hint}
        data-testid="search-input"
        spellCheck={false}
        className="h-full min-w-0 flex-1 bg-transparent px-2 text-[13px] outline-none"
      />
      {busy && <Spinner className="mr-1 text-faint" />}
      {s && current && !busy && (
        <span className="px-1 whitespace-nowrap text-faint" data-testid="search-count">
          {s.hits.length ? `${s.index + 1} of ${s.hits.length}` : 'No matches'}
        </span>
      )}
      <button onClick={() => step(-1)} disabled={!s?.hits.length} className="px-1 text-muted hover:text-fg disabled:opacity-30" title="Previous match (Shift+Enter)"
        data-testid="search-prev"><ChevronUp size={14} /></button>
      <button onClick={() => step(1)} disabled={!s?.hits.length} className="px-1 text-muted hover:text-fg disabled:opacity-30" title="Next match (Enter)"
        data-testid="search-next"><ChevronDown size={14} /></button>
      <button onClick={close} className="mr-1 px-1 text-muted hover:text-fg" title="Close (Esc)" data-testid="search-close"><X size={14} /></button>
    </div>
  )
}
