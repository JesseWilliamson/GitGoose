import type { UndoEntry } from '@gitsquid/shared'

/**
 * Undo.
 *
 * Git already keeps most of what undo needs: commits are never destroyed by moving a branch,
 * and the reflog remembers where refs pointed. What git does not remember is *which* of its
 * operations the user did in this app, and how to reverse each one. So before every operation
 * we record the inverse as plain data, and undo replays it.
 *
 * Working-tree changes are the exception: discarding a file or `reset --hard` really destroys
 * data. For those we first copy the data into git's object database (`git hash-object -w` for a
 * file, `git stash create` for the whole tree). Objects stay there, unreferenced, until
 * `git gc` prunes them weeks later, which is plenty of time to undo.
 */
export type UndoAction =
  /** Move the checked-out branch (or detached HEAD) back. 'keep' refuses to clobber local edits. */
  | { kind: 'reset'; to: string; mode: 'soft' | 'keep' }
  /**
   * Point a ref somewhere, or delete it when `to` is null. `from` is the value the ref must still
   * have (null: it must not exist), so undo refuses rather than clobber a ref someone moved.
   */
  | { kind: 'update-ref'; ref: string; to: string | null; from: string | null }
  /** Put the index back to a tree saved with `git write-tree` (undoing a mixed reset). */
  | { kind: 'read-tree'; tree: string }
  | { kind: 'checkout'; target: string; detach: boolean }
  | { kind: 'rename-branch'; from: string; to: string }
  /** upstream null: the branch tracked nothing. */
  | { kind: 'set-upstream'; branch: string; upstream: string | null }
  /** Remotes: put one back (undo of remove), remove one (undo of add), rename, or set a URL. */
  | { kind: 'remote-add'; name: string; url: string; pushUrl?: string }
  | { kind: 'remote-remove'; name: string }
  | { kind: 'remote-rename'; from: string; to: string }
  | { kind: 'remote-url'; name: string; url: string | null; push: boolean }
  /** Pop the stash entry whose commit is `hash`, wherever it now sits in the list. */
  | { kind: 'stash-pop'; hash: string }
  | { kind: 'stash-store'; hash: string; message: string }
  /** Drop the stash entry whose commit is `hash` (undo of a snapshot: the working tree was never touched). */
  | { kind: 'stash-drop'; hash: string }
  /** Apply a stash commit made with `git stash create` (no ref, just the object). */
  | { kind: 'stash-apply'; hash: string }
  /** Write every file of a saved tree into the working tree (backup taken during conflicts). */
  | { kind: 'restore-tree'; tree: string }
  /**
   * Throw away working-tree changes that are saved elsewhere (a stash entry being restored), but
   * only if they are still exactly `tree` plus the `untracked` files: anything else the user
   * changed since makes it refuse, before it touches a thing.
   */
  | { kind: 'drop-applied'; tree: string; untracked: { path: string; blob: string }[] }
  /** Worktrees: remove one (git refuses if it has changes), or add one back with a branch or a detached commit. */
  | { kind: 'worktree-remove'; path: string }
  | { kind: 'worktree-add'; path: string; branch?: string; commit: string }
  /**
   * Submodules. forget: undo of add, deletes its checkout and clone, refusing if it moved from
   * `commit` or has changes. restore: undo of remove, checks it out again from the clone git kept.
   */
  | { kind: 'submodule-forget'; path: string; name: string; commit: string }
  | { kind: 'submodule-restore'; path: string }
  /** Put a config value back (null: unset it), in this repository's config or the user's global one. */
  | { kind: 'config'; scope: 'local' | 'global'; key: string; value: string | null }
  /** Write saved blobs back to the working tree. `blob: null` means the file did not exist. */
  | { kind: 'restore-files'; files: { path: string; blob: string | null; mode?: number }[] }

export interface JournalEntry {
  id: number
  label: string
  time: number
  actions: UndoAction[]
  /** HEAD right after the operation. If HEAD has moved since, undo would be guessing, so it refuses. */
  expectHead: string | undefined
}

export class UndoJournal {
  private entries: JournalEntry[] = []
  /** Undone entries that can be redone: the redo actions, and the entry to put back afterwards. */
  private redos: { redo: JournalEntry; original: JournalEntry }[] = []
  private nextId = 1

  constructor(private limit = 100) {}

  /** A new operation: like in an editor, it ends any chance to redo what was undone before it. */
  record(label: string, actions: UndoAction[], expectHead: string | undefined): JournalEntry {
    const entry: JournalEntry = { id: this.nextId++, label, time: Date.now(), actions, expectHead }
    this.redos = []
    this.restore(entry)
    return entry
  }

  /** Put an entry back on the undo stack (after a redo) without clearing the redo stack. */
  restore(entry: JournalEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.limit) this.entries.shift()
  }

  pushRedo(redo: JournalEntry, original: JournalEntry): void {
    this.redos.push({ redo, original })
  }

  peekRedo() {
    return this.redos[this.redos.length - 1]
  }

  popRedo() {
    return this.redos.pop()
  }

  clearRedo(): void {
    this.redos = []
  }

  redoList(): UndoEntry[] {
    return this.redos.map(({ redo }) => ({ id: redo.id, label: redo.label, time: redo.time })).reverse()
  }

  peek(): JournalEntry | undefined {
    return this.entries[this.entries.length - 1]
  }

  pop(): JournalEntry | undefined {
    return this.entries.pop()
  }

  list(): UndoEntry[] {
    return this.entries.map(({ id, label, time }) => ({ id, label, time })).reverse()
  }

  clear(): void {
    this.entries = []
  }
}
