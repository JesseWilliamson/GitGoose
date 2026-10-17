# Exercise 5: three-way merge

**Files:** `packages/shared/src/merge3.ts` (the algorithm), `apps/desktop/src/renderer/src/lib/mergeState.ts`
(how the three-pane view keeps track of it), `components/MergePanes.tsx` (the view)
**Background:** PLAN-2 §8. Tests: `merge3.test.ts`, `mergeState.test.ts`, `e2e/merge.spec.ts`

## The idea

A two-way diff can tell you that line 9 differs between your branch and theirs. It cannot tell
you *who changed it*. The common ancestor (the merge base, stage 1 in the index) can. So diff
the base against each side separately:

```
base ──diff──▶ ours      changes: [line 2], [line 9]
base ──diff──▶ theirs    changes: [line 5], [line 9]
```

Now walk both lists in base order and group changes that overlap or touch in the base:

- a group with changes from one side only: take that side. No conflict, whatever the other side
  did elsewhere.
- a group where both sides produced identical text: also fine.
- anything else is a **conflict**: both sides rewrote the same region of the base differently.

Between groups, all three versions agree. That is all diff3 is. Git's merge-file, IntelliJ and
this app all do this, so "conflict" means something precise and checkable, not "the files
differ".

The diff underneath is Myers' algorithm (1986). Think of the edit graph: the base along x, the
other file along y, a diagonal step wherever two lines match. A shortest edit script is a path
from the top-left corner to the bottom-right with the fewest non-diagonal steps. Myers searches
by number of edits D = 0, 1, 2…, and for each diagonal k = x − y it remembers only the furthest
x it has reached, sliding down free diagonals ("snakes") as far as they go. The first D whose
frontier reaches the corner is the answer; the saved frontiers let you walk back to recover the
path.

## Read first

- In `diffLines`, why strip the common prefix and suffix before calling `myers`? What does a
  typical merge conflict look like as a fraction of the file?
- `trace` saves one frontier per D, and each frontier has 2D+1 entries. What is the total memory
  for D edits? Why does `MAX_EDITS` exist, and why is "one big hunk" still a *correct* answer?
- In `merge3`, clustering uses `aStart <= end`, not `<`. Find the test case that fails if you
  change it, and explain why git calls two changes on adjacent lines a conflict.
- In `mergeState.ts`, the result's block positions are mapped with different `assoc` for change
  blocks and unchanged blocks. Trace what happens when you type at the very start of a conflict.
- Why do the status changes go through `invertedEffects` instead of React state? What would
  Ctrl+Z do otherwise?

## Do it

1. On a scratch branch, replace the body of `merge3` with `throw new Error('todo')` and run
   `pnpm test packages/shared/src/merge3.test.ts`. Rebuild it. The 400 random cases compare
   your output with `git merge-file -p`, so you are checking yourself against git itself.
2. Harder: rebuild `myers` too. Start with the forward pass only and return `true` when the
   end is reachable, then add the backtrack.
3. Feature: `git merge-file --diff3` shows the base inside conflict markers (`|||||||`). Add a
   "Git's merge (diff3 style)" option to the *Start from* menu. Which file do you change, and
   what test would prove it?

## Questions

- Two people make the same fix on both branches, plus one more line each. How does the
  'both-same' rule handle it? (Try it in a test.)
- IntelliJ marks a conflict resolved as soon as you apply either side. Git counts a file
  resolved only when you stage it. Which one does GitSquid follow where, and why both?
- `git merge` with rename detection put base and ours for `src/utils/formatting.ts` under the
  new path even though only theirs renamed the file (try the dev repo's conflict branch). Where
  in git does that happen, and what would break if we read the versions by the old path?
