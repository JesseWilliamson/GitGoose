import type { CodePeek } from '@gitgoose/shared'
import { identifierAt } from '@gitgoose/codegraph'
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { openInEditor } from '../lib/actions'
import { api } from '../lib/api'

const mod = (e: React.MouseEvent) => (window.gitgoose?.platform === 'darwin' ? e.metaKey : e.ctrlKey)

/**
 * Ctrl/Cmd+click on a word in a diff: the identifier under the pointer, or null. Uses the
 * browser's caret-from-point to find the text node and offset that was clicked.
 */
export function identifierFromClick(e: React.MouseEvent): string | null {
  if (!mod(e) || e.button !== 0) return null
  const range = document.caretRangeFromPoint?.(e.clientX, e.clientY)
  const node = range?.startContainer
  if (!node || node.nodeType !== Node.TEXT_NODE) return null
  return identifierAt(node.textContent ?? '', range.startOffset)
}

/**
 * Code Peek (CodeRabbit's "code graph" made local): where a name is defined and used, as of the
 * revision the diff shows. Definitions come with their first lines; a reference opens the file
 * in your editor (the working-tree copy) at that line.
 */
export function CodePeekPanel({ repoId, repoPath, name, rev, onClose }: { repoId: string; repoPath: string; name: string; rev: string | null; onClose: () => void }) {
  const [peek, setPeek] = useState<CodePeek | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setPeek(null)
    setError(null)
    api.codePeek(repoId, name, rev).then((p) => live && setPeek(p), (e) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [repoId, name, rev])
  // Esc closes the peek, not the whole file view (whose own Esc listener runs later, on bubble).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const open = (path: string, line: number) => void openInEditor(`${repoPath}/${path}`, line)
  return (
    <div className="flex h-[42%] min-h-40 shrink-0 flex-col border-t border-line bg-panel" data-testid="code-peek">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
        <span className="font-semibold">Peek</span>
        <code className="rounded bg-hover px-1.5 font-mono">{name}</code>
        <span className="text-faint">{rev ? `as of ${rev.slice(0, 7)}` : 'in the working tree'}</span>
        {peek && <span className="text-faint">· {peek.definitions.length} definition{peek.definitions.length === 1 ? '' : 's'}, {peek.references.length}{peek.truncated ? '+' : ''} use{peek.references.length === 1 ? '' : 's'}</span>}
        <span className="flex-1" />
        <button onClick={onClose} title="Close (Esc)" aria-label="Close peek" className="rounded p-1 text-muted hover:bg-hover hover:text-fg"><X size={13} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px]">
        {error && <div className="p-3 font-sans text-xs text-del">{error}</div>}
        {!peek && !error && <div className="p-3 font-sans text-xs text-faint">Searching…</div>}
        {peek && peek.definitions.length === 0 && <div className="px-3 pt-2 font-sans text-xs text-faint">No definition found (it may come from a dependency).</div>}
        {peek?.definitions.map((d) => (
          <div key={`${d.path}:${d.line}`} className="border-b border-line/60" data-testid="peek-definition">
            <button onClick={() => open(d.path, d.line)} className="flex w-full items-center gap-2 px-3 pt-2 pb-1 text-left font-sans text-xs hover:text-accent">
              <span className="rounded bg-accent/15 px-1 text-[10px] text-accent">{d.kind}</span>
              <span className="truncate">{d.path}:{d.line}</span>
            </button>
            <pre className="selectable overflow-x-auto px-3 pb-2 text-muted">{d.preview.join('\n')}{d.endLine > d.line + 14 ? '\n…' : ''}</pre>
          </div>
        ))}
        {peek && peek.references.length > 0 && (
          <div className="py-1">
            <div className="px-3 py-1 font-sans text-[11px] font-semibold text-faint uppercase">Used in</div>
            {peek.references.map((r) => (
              <button key={`${r.path}:${r.line}:${r.column}`} onClick={() => open(r.path, r.line)} data-testid="peek-reference"
                className="flex w-full items-center gap-3 px-3 py-0.5 text-left hover:bg-hover">
                <span className="w-56 shrink-0 truncate font-sans text-xs text-muted">{r.path}:{r.line}</span>
                <span className="truncate">{r.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
