# Exercise 7: straight lanes (a branch on top of another goes straight up)

**File:** `packages/graph/src/layout.ts`, the two rules in `GraphLayout.next()` and the
`headOnTrunk` line in the constructor
**Tests:** `packages/graph/src/layout.test.ts`, the block "a branch on top of a reserved line
continues it" and "satisfies invariants with straight tips" (`pnpm test packages/graph`)
**Background:** ADR-003, sections "Lane 0 is the trunk, not HEAD" and "A branch on top of a
reserved line continues it"; exercise 1 first if you have not done it

## The idea in one paragraph

The layout reserves two columns before it has seen any commit: lane 0 for the trunk, and HEAD's
lane for the dashed line from the "uncommitted changes" row. A branch on top of main has its tip
arrive *before* main's tip, so it finds lane 0 reserved, opens a column to the right and curves
back in. The layout cannot fix that by itself: it streams, and when the tip arrives it has no idea
where its line will end. Git does know, so `Repo.straightTips` asks it once per ref change and
hands the layout two lists of tips. The layout trusts them: a listed tip continues the reserved
line instead of opening a new one.

## Do it

1. On a scratch branch, delete rule A and rule B from `next()` (the two `else if` branches that
   test `this.overTrunk` and `this.overHead`, and the code that moves the pending lane), and the
   `this.overTrunk.has(opts.head)` part of `headOnTrunk` in the constructor. Run the tests: the
   new block goes red, every older test stays green. That is the first thing to notice: without
   hints, the layout is exactly what it was.
2. "branch on top of trunk" first. Rule A is two lines. Where must it sit relative to the
   existing `this.trunk?.has(commit.hash)` check, and why does it test that no lane waits for the
   commit?
3. "branch on top of trunk, checked out". Here the tip *is* HEAD, so a lane already waits for it
   and rule A does not apply. Fix it in the constructor instead.
4. "branch on top of HEAD with WIP". Rule B: the tip takes the pending column, and the pending
   line moves right. The row has to say so: a `pass` edge whose `from` and `to` differ. Read
   `checkInvariants` again: it allows exactly this one kind of diagonal line, and `pendingPath`
   in the test follows the dashed line down to make sure it is never cut.
5. "colours stay per column" and the paging tests: if they fail, your moved line has the wrong
   colour or your rule depends on something outside `lanes`/`trunk`.
6. Then look at `edgePath('pass', ...)` in `apps/desktop/src/renderer/src/lib/edges.ts`: before
   this change it ignored `x2`. Why was that safe until now?

## Questions to answer before peeking

- **Why does the trunk rule need the *first-parent* check (in `Repo.straightTips`) while the
  pending-lane rule would still draw correctly without it?** Build the counter-example: a branch
  that merged main. What does each rule do with it if git listed it anyway?
- Rule A lets only the first listed tip have lane 0. What does a second branch on top of main
  look like, and why is that the right answer rather than a limitation?
- The layout could find these tips itself, by renaming a lane to lane 0 retroactively when the
  trunk tip arrives with one incoming line (ADR-003 describes it). Which property of the layout
  would that break, and which test says so?
- `straightTips` runs only when the refs change. What would it cost on a repository with 2,000
  remote branches, most of them merged, and which part of the command bounds it?

## Extensions

- Tags: a release tag on top of main is not a branch, so it is not listed. Should it be?
- Rule B moves the dashed line one column right. Try moving it left instead when there is a free
  column there. Which invariant now needs relaxing, and is the picture better?
