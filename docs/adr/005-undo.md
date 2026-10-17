# ADR-005: Undo by recording inverses

**Status:** accepted

## Decision

Every write operation in `Repo` records its inverse as data (`UndoAction[]`) in an in-memory
journal, together with the HEAD it produced. Undo replays the inverse of the latest entry, and
refuses if HEAD has moved since (another tool changed the repository).

| operation | inverse |
|---|---|
| commit / amend | `reset --soft` to the previous commit (changes stay staged) |
| merge, rebase, pull, cherry-pick, revert | `reset --keep` to before (refuses to clobber edits) |
| reset --soft / --mixed | `reset --soft` back, then `read-tree` the index saved with `git write-tree` |
| reset --hard | `reset --keep` back, then apply a backup made with `git stash create` (or, during a conflicted merge, a tree built in a throwaway index) |
| discard files or lines | write back blobs saved with `git hash-object -w` |
| checkout | check out the previous branch or commit |
| create / delete / rename branch or tag | delete / recreate (with upstream) / rename back |
| stash push / pop / drop | pop that stash (found by its commit, wherever it now sits) / `stash store` the saved stash commit |

## Why

- Git keeps commits after branches move (reflog), but not *which* operations the user did or
  how to reverse them. Recording the inverse is simple and exact.
- Destroyed working-tree data is the hard part. `git hash-object -w` and `git stash create`
  copy it into the object database without touching the working tree or the stash list; the
  objects survive until `git gc` prunes them weeks later.
- With undo available, the UI does not need "are you sure?" dialogs. Confirmation remains only
  for changes to remotes, which undo cannot reverse.

## Safety checks

- Undo refuses if HEAD has moved since the operation.
- Ref changes pass the expected old value to `git update-ref`, so undo refuses rather than delete
  a branch that gained commits from another tool.
- Each write returns the id of the entry it recorded (or null if nothing changed). A toast's Undo
  button undoes exactly that entry and is refused if something newer happened; the toolbar and
  Ctrl/Cmd+Z step back through the journal in order.
- Saved file copies use `hash-object --no-filters`, so undo restores the exact bytes (CRLF, LFS).

## Consequences

- The journal is per session (not persisted). Restarting the app forgets it; the reflog still
  has everything for manual recovery.
- An undone stash drop comes back as `stash@{0}`, because `git stash store` always pushes on top.
