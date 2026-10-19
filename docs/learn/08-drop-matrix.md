# Exercise 8: the drop matrix

**File:** `apps/desktop/src/renderer/src/lib/dnd.ts`, the function `dropPlan` and its helpers
(`localBranch`, `remoteBranch`, `tag`, `commitDrop`, `fileDrop`)
**Tests:** `apps/desktop/src/renderer/src/lib/dnd.test.ts` (`pnpm test lib/dnd`)
**Background:** ADR-009 (why a matrix and not a menu), spec 003's drag-and-drop table, ADR-005
(why a plain drop can just run)

## The idea in one paragraph

A drag and drop is a sentence with three words: *this* (the source), *there* (the target) and
*how* (Alt or not). Tower's rule is that those three words are enough, so there is no menu asking
what you meant. That turns drag and drop into a lookup table, and a lookup table is the easiest
kind of code to test: one row of the table, one test. `dropPlan` is that table written as code.
It does not *do* anything: it returns what the drop would do, as plain data (`{ op: 'merge', ref }`),
and a label for the badge. Running it is someone else's job (`performDrop` in `lib/actions.ts`).
Keeping "decide" and "do" apart is why this exercise needs no git, no Electron and no DOM.

## Do it

1. On a scratch branch, replace the body of `dropPlan` with `return null` and keep the types.
   Run the tests: everything in "everything else is not a target" passes already. Notice that:
   the safe default for an unknown pair is "not a target".
2. Rebuild it one `describe` at a time, in the order of the file. Start with "local branch →
   HEAD branch…": four targets mean "HEAD" (its sidebar row or pill, the Working Copy item, the
   WIP row, HEAD's own graph row). Write one helper for "is this target HEAD?" before the second
   test needs it.
3. "commit(s) → onto a commit": the editable part of the branch is in `ctx.editable`. Both ends
   must be on it. Why both, and not only the target? (Look at what `Repo.squashOnto` does with the
   commits it is given.)
4. The Alt rows: for most of them Alt picks an alternative, and for the rest (marked "–" in the
   spec) Alt does the same as a plain drop. Is that the right call, or should those return null
   with Alt held? Think about what a user who holds Alt by accident would experience.
5. Compare with the reference. Theirs and yours will differ in shape; check that the labels match
   exactly, because the badge shows the label and the e2e tests read it.

## The question

"Commit → another local branch" cherry-picks onto a branch that is **not checked out**, and the
reference does it with `git merge-tree --write-tree --merge-base C^ <branch> C`, then
`commit-tree` and `update-ref` (`Repo.cherryPickOnto` in `packages/git/src/repo.ts`).

- Why can't it just run `git cherry-pick`? What does cherry-pick need that the branch does not
  have while it is not checked out?
- The obvious workaround is a temporary checkout: check out the branch, cherry-pick, check the
  old branch out again. List what can go wrong. Start with: uncommitted changes in the working
  tree; a conflict half-way through (where is the user now, and which branch are they on?); the
  file watcher and the editor seeing every file change twice; a branch that is checked out in
  another worktree.
- Why is `C^` the merge base? Draw the three trees (base, ours, theirs) for a commit that edits
  one line, and check that the merge gives "the branch, plus C's change".
- `update-ref <branch> <new> <old>` takes the old value. What does it protect against, and
  where else in the code base is the same trick used for undo?
