# Exercise 1: the lane layout

**File:** `packages/graph/src/layout.ts`, method `GraphLayout.next()`
**Tests:** `packages/graph/src/layout.test.ts` (`pnpm test packages/graph`)
**Background:** ADR-003, and the long comment at the top of layout.ts

## The idea in one paragraph

Walk commits newest to oldest. Keep an array `lanes` where `lanes[i]` is the hash the line in
column i is heading down to. A commit takes the leftmost lane waiting for it (or a free one if
none waits: it is a branch tip). Its first parent inherits that lane, so a branch runs straight
down. Extra parents (merges) join a lane already waiting for that parent, or open a new one.
Each row records the line segments that cross it, split at the node: `pass` (straight through),
`top` (into the node) and `bottom` (out of it). Because the only state is `lanes`, you can lay out
page 2 later without redoing page 1.

## Do it

1. Replace the body of `next()` with `throw new Error('todo')`. Keep the class, `freeSlot` and
   `newColor`.
2. Get the simple tests passing first: "linear history", then "merge", then "octopus".
3. "Reserves lane 0 for HEAD" needs the seed in the constructor. Why does seeding lanes[0] with
   HEAD's hash make HEAD land in lane 0, and what happens to the commits above it?
4. "Satisfies invariants" runs every fixture shape. Read `checkInvariants` first: it says what
   "correct" means better than any example.

## Questions to answer before peeking

- Why must input be in topological order, not date order? What breaks if a parent comes first?
- When two children share a parent, two lanes wait for the same hash. Where do they meet?
- Why is `freeSlot(lane)` (excluding the node's own lane) used for extra parents?
- The benchmark lays out 100k commits in ~90 ms. What is the time complexity, and when would it
  get worse?

## Extensions

- GitKraken also keeps `main` in a stable lane. Add `LayoutOptions.pinned: string[]` that seeds
  extra lanes after HEAD. What happens when HEAD *is* main?
- Lanes never move sideways once open, so a long-lived branch can leave a gap when the lane to its
  left closes. Try compacting: when a lane frees up, shift lanes to its right left by one. Which
  edges now need to be diagonal `pass` edges, and does `GraphCell` draw those?
