# Exercise 4: the undo journal

**Files:** `packages/git/src/undo.ts`, and `record`/`perform` usage in `packages/git/src/repo.ts`
**Tests:** "commits and undo", "branches" and "stash" blocks in `packages/git/src/repo.test.ts`
**Background:** ADR-005

## The idea

Before each operation, write down how to reverse it, as data. Undo replays that. The interesting
part is what git already keeps for you and what it does not:

- Moving a branch never destroys commits: they stay in the object database and the reflog.
  So undoing a commit, merge or rebase is "move the branch back".
- Working-tree edits are not in git at all. Discarding them is the one truly destructive thing.
  So before destroying them, copy them in: `git hash-object -w` (one file) or `git stash create`
  (the whole tree, without touching the stash list).

## Read first

- Why does undoing a merge use `reset --keep` and not `reset --hard`? Try both on a repo with an
  unrelated uncommitted edit.
- Why does `undo()` refuse when HEAD has moved since the operation?
- `stash apply` has no undo entry. Why is it harder than `stash pop`?

## Do it: make `stash apply` undoable

1. Write the test first: apply a stash onto a working tree that already has an unrelated edit,
   undo, and check the working tree is exactly as before (including the unrelated edit).
2. Design the inverse. Hint: `git stash create` before applying gives you a snapshot of the tree
   *before*. What do you restore from it, and how do you avoid clobbering files the stash did not
   touch?
3. Add the `UndoAction` variant and its `perform` case.

## Extensions

- Redo: what must the journal record so an undo can itself be reversed?
- The journal is lost on restart. Persist it per repository. What could make a persisted entry
  dangerous to replay days later, and how does `expectHead` help?
