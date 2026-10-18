import { CodeParser, GraphStore, type TreeEntry } from '@gitgoose/codegraph/node'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CatFile } from './catfile'
import type { GitRunner } from './runner'

/** The tree keys for the two trees that are not commits. */
export const WORKTREE = 'worktree'
export const INDEX = 'index'

export interface IndexProgress {
  /** Files parsed so far in this sync and how many it has to parse. */
  done: number
  total: number
}

/**
 * Builds the code graph of one repository (see ADR-008).
 *
 * A sync of a tree lists its files, records (path, blob) for every file a grammar parses, and
 * parses only the blobs the store has not seen. The first sync of a repository parses
 * everything once; after that a commit costs its changed files, and a checkout costs the files
 * that differ. Runs in a utility process: parsing is CPU-bound.
 */
export class CodeIndexer {
  private cat: CatFile
  private parser: CodeParser
  private cancelled = false

  constructor(
    private runner: GitRunner,
    private worktree: string,
    readonly store: GraphStore,
    parser?: CodeParser,
  ) {
    this.cat = new CatFile(runner)
    this.parser = parser ?? new CodeParser()
  }

  cancel(): void {
    this.cancelled = true
  }

  dispose(): void {
    this.cat.dispose()
  }

  /** Index a commit (or any tree-ish). Returns the key the tree is stored under: the full hash. */
  async syncRev(rev: string, onProgress?: (p: IndexProgress) => void): Promise<string> {
    const hash = (await this.runner.run(['rev-parse', `${rev}^{commit}`], { readOnly: true })).stdout.trim()
    if (this.store.hasTree(hash)) return hash
    const out = await this.runner.run(['ls-tree', '-r', '-z', hash], { readOnly: true })
    const entries: TreeEntry[] = []
    for (const rec of out.stdout.split('\0')) {
      // "<mode> <type> <sha>\t<path>"
      const tab = rec.indexOf('\t')
      if (tab < 0) continue
      const [, type, sha] = rec.slice(0, tab).split(' ')
      const path = rec.slice(tab + 1)
      if (type === 'blob' && sha && this.parser.supports(path)) entries.push({ path, blob: sha })
    }
    await this.parseMissing(entries, (blob) => this.cat.read(blob).then((b) => b?.toString('utf8') ?? null), onProgress)
    if (!this.cancelled) this.store.setTree(hash, entries)
    return hash
  }

  /** Index the index (staged content): blobs straight from `ls-files -s`. */
  async syncIndex(onProgress?: (p: IndexProgress) => void): Promise<void> {
    const entries = await this.indexEntries()
    await this.parseMissing(entries, (blob) => this.cat.read(blob).then((b) => b?.toString('utf8') ?? null), onProgress)
    if (!this.cancelled) this.store.setTree(INDEX, entries)
  }

  /**
   * Index the working tree. Unchanged tracked files share the index's blobs; modified and
   * untracked ones are read from disk and hashed as git would, so unchanged content between
   * two syncs is never parsed twice.
   */
  async syncWorktree(onProgress?: (p: IndexProgress) => void): Promise<void> {
    const entries = await this.indexEntries()
    const byPath = new Map(entries.map((e) => [e.path, e]))
    const changed = (await this.runner.run(['diff', '--name-only', '-z', '--diff-filter=ACMRTUXB'], { readOnly: true })).stdout.split('\0').filter(Boolean)
    const deleted = (await this.runner.run(['diff', '--name-only', '-z', '--diff-filter=D'], { readOnly: true })).stdout.split('\0').filter(Boolean)
    const untracked = (await this.runner.run(['ls-files', '-z', '--others', '--exclude-standard'], { readOnly: true })).stdout.split('\0').filter(Boolean)
    for (const p of deleted) byPath.delete(p)
    const texts = new Map<string, string>()
    for (const p of [...changed, ...untracked]) {
      if (!this.parser.supports(p)) continue
      const text = await readFile(join(this.worktree, p), 'utf8').catch(() => null)
      if (text === null) {
        byPath.delete(p)
        continue
      }
      const blob = (await this.runner.run(['hash-object', '--stdin'], { readOnly: true, input: text })).stdout.trim()
      byPath.set(p, { path: p, blob })
      texts.set(blob, text)
    }
    const all = [...byPath.values()]
    await this.parseMissing(all, (blob) => (texts.has(blob) ? Promise.resolve(texts.get(blob)!) : this.cat.read(blob).then((b) => b?.toString('utf8') ?? null)), onProgress)
    if (!this.cancelled) this.store.setTree(WORKTREE, all)
  }

  private async indexEntries(): Promise<TreeEntry[]> {
    const out = await this.runner.run(['ls-files', '-s', '-z'], { readOnly: true })
    const entries: TreeEntry[] = []
    for (const rec of out.stdout.split('\0')) {
      // "<mode> <sha> <stage>\t<path>"
      const tab = rec.indexOf('\t')
      if (tab < 0) continue
      const [, sha, stage] = rec.slice(0, tab).split(' ')
      const path = rec.slice(tab + 1)
      if (stage === '0' && sha && this.parser.supports(path)) entries.push({ path, blob: sha })
    }
    return entries
  }

  /** Parse the blobs of `entries` the store does not know yet. */
  private async parseMissing(entries: TreeEntry[], read: (blob: string) => Promise<string | null>, onProgress?: (p: IndexProgress) => void): Promise<void> {
    const want = [...new Set(entries.map((e) => e.blob))]
    const known = this.store.knownBlobs(want)
    const todo = entries.filter((e) => !known.has(e.blob))
    const pathOf = new Map<string, string>()
    for (const e of todo) pathOf.set(e.blob, e.path)
    const blobs = [...pathOf]
    let done = 0
    onProgress?.({ done, total: blobs.length })
    for (const [blob, path] of blobs) {
      if (this.cancelled) return
      const text = await read(blob)
      let status: 'ok' | 'skipped' | 'error' = 'skipped'
      let extracted = null
      if (text !== null && !text.includes('\0')) {
        try {
          extracted = await this.parser.parse(path, text)
          status = extracted ? 'ok' : 'skipped'
        } catch {
          status = 'error'
        }
      }
      this.store.putBlob(blob, extracted, status)
      done++
      if (done % 20 === 0 || done === blobs.length) onProgress?.({ done, total: blobs.length })
    }
  }
}
