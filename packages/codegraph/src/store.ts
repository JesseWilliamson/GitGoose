import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { Extracted, Reference, ReferenceKind, Symbol } from './extract'
import type { DefinitionKind } from './languages'

/**
 * The graph on disk: SQLite, through Node's built-in binding (no native module to build).
 *
 * Content is stored per **blob**, never per path: git names content by its hash, so a file that
 * is the same in a thousand commits is parsed once. A **tree** (a commit, the index, or the
 * working tree) is just rows of (path, blob). Answering "where is `total` defined as of commit
 * X?" is a join: symbols named `total` whose blob is in tree X. Indexing commit Y after X parses
 * only the blobs Y has that X did not.
 *
 * One writer (the indexer) and any number of readers (the main process answering queries):
 * WAL mode lets them run at the same time.
 */

/** Bump when the schema or what is extracted changes: an old database is rebuilt. */
export const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  -- 'ok' parsed; 'skipped' no grammar or too big; 'error' the parser failed.
  status TEXT NOT NULL,
  symbols INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS symbols (
  blob TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  signature TEXT NOT NULL,
  parent TEXT
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols (name);
CREATE INDEX IF NOT EXISTS symbols_blob ON symbols (blob);
CREATE TABLE IF NOT EXISTS refs (
  blob TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  within TEXT
);
CREATE INDEX IF NOT EXISTS refs_name ON refs (name);
CREATE INDEX IF NOT EXISTS refs_blob ON refs (blob);
CREATE TABLE IF NOT EXISTS trees (
  rev TEXT NOT NULL,
  path TEXT NOT NULL,
  blob TEXT NOT NULL,
  PRIMARY KEY (rev, path)
);
CREATE INDEX IF NOT EXISTS trees_blob ON trees (rev, blob);
`

export interface TreeEntry {
  path: string
  blob: string
}

export interface FoundSymbol extends Symbol {
  path: string
  blob: string
}

export interface FoundReference extends Reference {
  path: string
  blob: string
}

export interface StoreStats {
  blobs: number
  symbols: number
  refs: number
  trees: string[]
}

export class GraphStore {
  private db: DatabaseSync
  private stmts = new Map<string, StatementSync>()

  /**
   * Open (creating if needed) a database. A reader opens an existing file read-only and sees
   * the writer's commits as they land. An old schema is dropped and rebuilt by the writer.
   */
  constructor(readonly file: string, readonly readOnly = false) {
    this.db = new DatabaseSync(file, { readOnly })
    if (!readOnly) {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
      const v = this.tryMeta('schema')
      if (v !== String(SCHEMA_VERSION)) {
        this.db.exec('DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS blobs; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS refs; DROP TABLE IF EXISTS trees;')
        this.db.exec(SCHEMA)
        this.setMeta('schema', String(SCHEMA_VERSION))
      }
    }
  }

  close(): void {
    this.db.close()
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.stmts.set(sql, s)
    }
    return s
  }

  private tryMeta(key: string): string | null {
    try {
      return this.meta(key)
    } catch {
      return null // no meta table yet
    }
  }

  meta(key: string): string | null {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.stmt('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
  }

  // ---------------------------------------------------------------- writing

  /** Of these blob ids, the ones already parsed (or skipped): the indexer leaves them alone. */
  knownBlobs(ids: string[]): Set<string> {
    const known = new Set<string>()
    const q = this.stmt('SELECT id FROM blobs WHERE id = ?')
    for (const id of ids) if (q.get(id)) known.add(id)
    return known
  }

  /** Record a parsed blob (null: not parseable), replacing whatever was there. */
  putBlob(id: string, extracted: Extracted | null, status: 'ok' | 'skipped' | 'error' = extracted ? 'ok' : 'skipped'): void {
    this.transaction(() => {
      this.stmt('DELETE FROM symbols WHERE blob = ?').run(id)
      this.stmt('DELETE FROM refs WHERE blob = ?').run(id)
      this.stmt('INSERT OR REPLACE INTO blobs (id, status, symbols) VALUES (?, ?, ?)').run(id, status, extracted?.symbols.length ?? 0)
      if (!extracted) return
      const sym = this.stmt('INSERT INTO symbols (blob, name, kind, line, end_line, signature, parent) VALUES (?, ?, ?, ?, ?, ?, ?)')
      for (const s of extracted.symbols) sym.run(id, s.name, s.kind, s.line, s.endLine, s.signature, s.parent ?? null)
      const ref = this.stmt('INSERT INTO refs (blob, name, kind, line, col, within) VALUES (?, ?, ?, ?, ?, ?)')
      for (const r of extracted.refs) ref.run(id, r.name, r.kind, r.line, r.column, r.within ?? null)
    })
  }

  /** Replace a tree's entries (only files with a grammar need listing). */
  setTree(rev: string, entries: TreeEntry[]): void {
    this.transaction(() => {
      this.stmt('DELETE FROM trees WHERE rev = ?').run(rev)
      const ins = this.stmt('INSERT INTO trees (rev, path, blob) VALUES (?, ?, ?)')
      for (const e of entries) ins.run(rev, e.path, e.blob)
    })
  }

  /** Forget trees other than these (a checkout later does not need every commit ever shown). */
  keepTrees(revs: string[]): void {
    const keep = new Set(revs)
    for (const rev of this.trees()) if (!keep.has(rev)) this.stmt('DELETE FROM trees WHERE rev = ?').run(rev)
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  // ---------------------------------------------------------------- reading

  hasTree(rev: string): boolean {
    return !!this.stmt('SELECT 1 FROM trees WHERE rev = ? LIMIT 1').get(rev)
  }

  trees(): string[] {
    return (this.stmt('SELECT DISTINCT rev FROM trees').all() as { rev: string }[]).map((r) => r.rev)
  }

  tree(rev: string): TreeEntry[] {
    return this.stmt('SELECT path, blob FROM trees WHERE rev = ? ORDER BY path').all(rev) as unknown as TreeEntry[]
  }

  /** Where `name` is defined, as of a tree. */
  definitions(name: string, rev: string, limit = 200): FoundSymbol[] {
    const rows = this.stmt(
      'SELECT t.path, s.blob, s.name, s.kind, s.line, s.end_line, s.signature, s.parent FROM symbols s JOIN trees t ON t.blob = s.blob AND t.rev = ? WHERE s.name = ? ORDER BY t.path, s.line LIMIT ?',
    ).all(rev, name, limit) as { path: string; blob: string; name: string; kind: DefinitionKind; line: number; end_line: number; signature: string; parent: string | null }[]
    return rows.map((r) => ({ path: r.path, blob: r.blob, name: r.name, kind: r.kind, line: r.line, endLine: r.end_line, signature: r.signature, ...(r.parent ? { parent: r.parent } : {}) }))
  }

  /** Where `name` is used, as of a tree. */
  references(name: string, rev: string, limit = 500): FoundReference[] {
    const rows = this.stmt(
      'SELECT t.path, r.blob, r.name, r.kind, r.line, r.col, r.within FROM refs r JOIN trees t ON t.blob = r.blob AND t.rev = ? WHERE r.name = ? ORDER BY t.path, r.line, r.col LIMIT ?',
    ).all(rev, name, limit) as { path: string; blob: string; name: string; kind: ReferenceKind; line: number; col: number; within: string | null }[]
    return rows.map((r) => ({ path: r.path, blob: r.blob, name: r.name, kind: r.kind, line: r.line, column: r.col, ...(r.within ? { within: r.within } : {}) }))
  }

  /** Every definition in a blob, by line. */
  symbolsIn(blob: string): Symbol[] {
    const rows = this.stmt('SELECT name, kind, line, end_line, signature, parent FROM symbols WHERE blob = ? ORDER BY line, end_line DESC').all(blob) as { name: string; kind: DefinitionKind; line: number; end_line: number; signature: string; parent: string | null }[]
    return rows.map((r) => ({ name: r.name, kind: r.kind, line: r.line, endLine: r.end_line, signature: r.signature, ...(r.parent ? { parent: r.parent } : {}) }))
  }

  /** The blob a path has in a tree, if listed. */
  blobOf(rev: string, path: string): string | null {
    const row = this.stmt('SELECT blob FROM trees WHERE rev = ? AND path = ?').get(rev, path) as { blob: string } | undefined
    return row?.blob ?? null
  }

  stats(): StoreStats {
    const n = (sql: string) => (this.stmt(sql).get() as { n: number }).n
    return { blobs: n('SELECT COUNT(*) AS n FROM blobs'), symbols: n('SELECT COUNT(*) AS n FROM symbols'), refs: n('SELECT COUNT(*) AS n FROM refs'), trees: this.trees() }
  }
}
