/**
 * The code indexer: an Electron utility process (see ADR-008).
 *
 * Parsing is CPU-bound, so it runs here, away from the main process and the window. Main
 * sends one message per request over `process.parentPort`; progress and results come back
 * with the request's id. One process serves every open repository; grammars (the WASM
 * parsers) are loaded once and shared.
 */
import { CodeParser, directoryLocator, GraphStore, Grammars } from '@gitgoose/codegraph/node'
import { CodeIndexer, GitRunner } from '@gitgoose/git'

export type IndexerRequest =
  | { type: 'open'; repoId: string; path: string; gitPath: string; env: Record<string, string>; dbFile: string; grammarDir: string | null }
  | { type: 'sync'; id: number; repoId: string; what: 'rev' | 'index' | 'worktree'; rev?: string }
  | { type: 'close'; repoId: string }

export type IndexerReply =
  | { type: 'opened'; repoId: string }
  | { type: 'progress'; id: number; done: number; total: number }
  /** A sync finished; `key` is the tree's key in the store (a commit's full hash). */
  | { type: 'done'; id: number; key?: string }
  | { type: 'error'; id: number; message: string }

interface Open {
  indexer: CodeIndexer
  store: GraphStore
  /** Syncs of one repository run one after another: they share its cat-file process and store. */
  queue: Promise<unknown>
}

const repos = new Map<string, Open>()
let parser: CodeParser | null = null

function parserFor(grammarDir: string | null): CodeParser {
  parser ??= new CodeParser(new Grammars(grammarDir ? directoryLocator(grammarDir) : undefined))
  return parser
}

const port = process.parentPort
const reply = (m: IndexerReply) => port.postMessage(m)

function handle(req: IndexerRequest): void {
  switch (req.type) {
    case 'open': {
      repos.get(req.repoId)?.indexer.dispose()
      repos.get(req.repoId)?.store.close()
      const store = new GraphStore(req.dbFile)
      const runner = new GitRunner({ cwd: req.path, gitPath: req.gitPath, env: req.env })
      repos.set(req.repoId, { indexer: new CodeIndexer(runner, req.path, store, parserFor(req.grammarDir)), store, queue: Promise.resolve() })
      reply({ type: 'opened', repoId: req.repoId })
      return
    }
    case 'close': {
      const o = repos.get(req.repoId)
      if (!o) return
      repos.delete(req.repoId)
      o.indexer.cancel()
      void o.queue.then(() => {
        o.indexer.dispose()
        o.store.close()
      })
      return
    }
    case 'sync': {
      const o = repos.get(req.repoId)
      if (!o) {
        reply({ type: 'error', id: req.id, message: 'Repository is not open in the indexer.' })
        return
      }
      const onProgress = (p: { done: number; total: number }) => reply({ type: 'progress', id: req.id, done: p.done, total: p.total })
      o.queue = o.queue.then(async () => {
        try {
          let key: string | undefined
          if (req.what === 'rev') key = await o.indexer.syncRev(req.rev!, onProgress)
          else if (req.what === 'index') await o.indexer.syncIndex(onProgress)
          else await o.indexer.syncWorktree(onProgress)
          reply({ type: 'done', id: req.id, key })
        } catch (e) {
          reply({ type: 'error', id: req.id, message: e instanceof Error ? e.message : String(e) })
        }
      })
      return
    }
  }
}

port.on('message', (e: { data: IndexerRequest }) => handle(e.data))
