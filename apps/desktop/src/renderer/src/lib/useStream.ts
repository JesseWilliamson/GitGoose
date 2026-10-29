import type { StreamFile, StreamTarget } from '@gitgoose/shared'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { reportError, useSetting, type RepoView } from './store'
import type { StreamBlock } from './stream'

/** A block the reader is asked to show, before anything is loaded. */
export interface BlockSpec {
  key: string
  target: StreamTarget
  hash?: string
  title: string
}

const isWorking = (t: StreamTarget) => t.kind === 'unstaged' || t.kind === 'staged' || (t.kind === 'range' && t.to === null)

/**
 * The files of a stream's blocks, loaded as they are needed: the first block at once, the others
 * when their row comes into view (`loadBlock`), and the diffs past a block's line budget file by
 * file (`loadFiles`). Working-copy blocks load again when files change on disk; commits never do.
 */
export function useStreamBlocks(view: RepoView, specs: BlockSpec[]): {
  blocks: StreamBlock[]
  loadBlock: (i: number) => void
  loadFiles: (i: number, paths: string[]) => void
} {
  const context = useSetting('contextLines')
  const ignoreWhitespace = useSetting('ignoreWhitespace')
  const [files, setFiles] = useState<ReadonlyMap<string, StreamFile[]>>(new Map())
  const inFlight = useRef(new Set<string>())
  const specsKey = specs.map((s) => s.key).join('\n')
  const optsKey = `${context}:${ignoreWhitespace}`
  const working = specs.some((s) => isWorking(s.target))
  const tick = working ? `${view.worktreeTick}:${JSON.stringify(view.snapshot.status)}` : ''
  // The current specs, for callbacks that outlive a render.
  const current = useRef(specs)
  current.current = specs

  const fetchBlock = useCallback((spec: BlockSpec, paths?: string[]) => {
    const flight = `${spec.key}\u0000${optsKey}\u0000${paths?.join('\u0001') ?? '*'}`
    if (inFlight.current.has(flight)) return
    inFlight.current.add(flight)
    api.diffStream(view.id, spec.target, { context, ignoreWhitespace, ...(paths ? { paths } : {}) }).then((got) => {
      setFiles((prev) => {
        const next = new Map(prev)
        if (!paths) next.set(spec.key, got)
        else {
          const by = new Map(got.map((f) => [f.path, f]))
          const was = prev.get(spec.key)
          if (was) next.set(spec.key, was.map((f) => (by.get(f.path)?.diff ? { ...f, diff: by.get(f.path)!.diff } : f)))
        }
        return next
      })
    }, (e) => reportError('Could not load the changes', e)).finally(() => inFlight.current.delete(flight))
  }, [view.id, context, ignoreWhitespace, optsKey])

  // A new set of blocks or other diff options: start over, with the first block loaded at once.
  useEffect(() => {
    setFiles(new Map())
    inFlight.current.clear()
    const first = current.current[0]
    if (first) fetchBlock(first)
  }, [specsKey, optsKey, fetchBlock])

  // The working copy changed on disk: read its blocks again, keeping what is on screen until the
  // new files arrive (emptying first would flash the stream to "loading" on every save).
  const loaded = useRef(files)
  loaded.current = files
  const firstTick = useRef(true)
  useEffect(() => {
    if (firstTick.current) {
      firstTick.current = false
      return
    }
    for (const spec of current.current) if (isWorking(spec.target) && loaded.current.has(spec.key)) fetchBlock(spec)
  }, [tick, fetchBlock])

  const blocks = useMemo<StreamBlock[]>(() => specs.map((s) => ({ ...s, files: files.get(s.key) ?? null })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by key: specs is a fresh array each render
    [specsKey, files])

  const loadBlock = useCallback((i: number) => {
    const spec = current.current[i]
    if (spec) fetchBlock(spec)
  }, [fetchBlock])
  const loadFiles = useCallback((i: number, paths: string[]) => {
    const spec = current.current[i]
    if (spec && paths.length) fetchBlock(spec, paths)
  }, [fetchBlock])
  return { blocks, loadBlock, loadFiles }
}
