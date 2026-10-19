# ADR-003: Graph layout and rendering

**Status:** accepted

## Decision

- Layout (`packages/graph`) is a pure, incremental lane assignment over commits in topological
  order (date or topological, see "Commit order" below), with lane 0 kept for the main line (see "Lane 0 is the trunk" below; it used to be HEAD's), which a branch on top of it continues (see the last section). Output per row: node lane, colour, and edges split
  at the node into `pass`, `top` and `bottom` parts.
- Rendering is a virtualized list (`@tanstack/react-virtual`). Each visible row draws its own
  small SVG from its edges. Only ~40 rows exist in the DOM at any time.
- The log lives in mutable arrays outside React state (`getLog()` in the store); React sees a
  version counter. Rows are memoized and take their offset as a number so scrolling re-renders
  the list but not the rows.

## Why

- Splitting edges at the node means each row can be drawn without looking at its neighbours,
  which is what makes per-row rendering (and virtualization) possible.
- Incremental layout lets the first screenful appear before git finishes printing the log.
- SVG per row is simple and inspectable. The plan said to switch to Canvas only if profiling
  showed SVG was the bottleneck. The benchmark shows 60 fps scrolling over 100k commits (same as
  the idle frame rate), so SVG stays.

## Measured (tools/bench, 100k commits, Linux VM without GPU)

| metric | value |
|---|---|
| layout of all 100k commits | ~90 ms |
| app launch to first painted rows | ~520 ms |
| scroll | 60 fps (idle 60 fps) |

The first measurement found rows re-rendering on every scroll frame (a fresh `style` object
defeated `memo`): 48 fps. Passing `top` as a number fixed it.

## Column width (added after testing on expressjs/express)

Real histories can have dozens of lanes open at once: about 40 in Express, from long-lived release
branches and hundreds of tags. Sizing the graph column to fit them all left commit messages a few
characters wide. The column now shows at most 8 lanes by default and clips the rest (a "›" in
the header says lanes are hidden); dragging the header edge resizes it and the width persists.

## Lane 0 is the trunk, not HEAD (amended after use)

Reserving lane 0 for HEAD meant every checkout rebuilt the graph around the new branch: it slid to
the left edge and main and everything else shifted right. It felt like the graph jumping. GitKraken
keeps the main line on the left instead, and so do we now:

- The snapshot names the trunk refs (`trunkRefs`: origin/HEAD's branch, local and remote, else
  main or master), keeping only refs the graph filter lets the walk reach. A trunk ref the log
  never reaches would hold lane 0 empty all the way down.
- The layout holds lane 0 free until the first trunk commit arrives. That commit takes lane 0 and
  colour 0, and lines waiting for it curve in.
- HEAD still gets a lane reserved from the top for the dashed line from the "uncommitted changes"
  row: lane 0 when HEAD is a trunk tip, else lane 1. `GraphLayout.headLane`/`headColor` tell the
  WIP row where to draw.

A checkout now leaves the main line where it is. Side branches can still shift a column to make
room for HEAD's lane, which is the price of the dashed WIP line.

## Commit order: date or topological (added in Plan 4, phase 1)

Settings → Graph → Commit order picks `--date-order` (the default: newest first, branches
interleaved by time, as in GitKraken and Tower) or `--topo-order` (each branch's commits kept in one
block; dates run out of order). The layout needs nothing else: both orders put every child above
its parents, which is the only thing `packages/graph` relies on. A change of order is a new walk
(`Repo.setCommitOrder` resets the refs key, so the next snapshot bumps `refsVersion`) and the
renderer swaps the new first page in, as it does after any ref change. Search walks in the same
order so its hits step down the graph.

First page (300 commits) of a 100k-commit history, `tools/bench`, Linux VM:

| order | no commit-graph | with commit-graph |
|---|---|---|
| `--date-order` | 614 ms | 9.9 ms |
| `--topo-order` | 566 ms | 8.1 ms |
| (no order flag, for comparison: `git log` directly) | 9 ms | 6 ms |

**Why.** The plan expected date order to stream and topo order not to. That is half right, and
the measurement corrected it. A plain `git log` walks a priority queue keyed on commit date and
prints each commit as it pops it; that is why it starts at once. But it can print a parent above
one of its children when clocks are skewed or a branch was rebased onto newer work, and the lane
layout must never see that. `--date-order` is not the plain walk: in git it is a topological sort
that breaks ties by date (`revs->topo_order` with `REV_SORT_BY_COMMIT_DATE`), so it carries the
same promise and the same cost as `--topo-order`. To be sure no unprinted commit is a child of the
next one, git without extra information must walk the whole history first; that is the ~600 ms.

**What the commit-graph changes.** The commit-graph file stores a generation number per commit
(git uses them for an incremental topological walk since 2.20): a commit's generation is greater than every one of its
parents'. With it git can prove "nothing still unseen is a child of this commit" by walking only
as far as the generation numbers say, so both orders print the first page in a few milliseconds,
almost exactly as fast as the plain walk. GitGoose writes the commit-graph in the background when a
repository lacks one (ADR-004), so the slow column only applies to the first open of a repository
without one. `bench --check` now also holds topological order with a commit-graph to the
first-page budget.

## A branch on top of a reserved line continues it (added in Plan 4, phase 2)

The two reservations above (lane 0 held for the trunk, HEAD's lane seeded at the top) have a cost.
A branch sitting on top of main has its tip arrive *before* main's tip, while lane 0 is still
held, so it opened a lane to the right and curved back into lane 0 at main's tip:

```
 before           after
 │ ╭─● Z          ● Z   topic
 │ │ ● Y          ● Y
 │ │ ● X          ● X
 ●─╯   B main     ● B   main
 ●     A          ● A
```

Tower draws the right-hand picture because it reserves nothing. We keep the reservations (a
checkout must not reshuffle the graph) and add one exception, driven by git:

- **Git says which tips are straight over a reserved line.** When the refs change, `Repo.straightTips`
  runs one `for-each-ref` with `%(ahead-behind:<trunk tip>)` and `%(ahead-behind:<HEAD>)` (git
  2.41+, one walk for all refs). A branch not behind and ahead contains the base; a bounded
  `rev-list --first-parent -n <ahead+1>` then checks its own line actually runs down to it (a
  branch that merged main contains main without its first parents ever reaching it). The tip
  hashes go on the snapshot as `graph.straight: { overTrunk, overHead }`, and into the refs key.
- **The layout honours it** (`LayoutOptions.straight`):
  - *Rule A.* A tip (no lane waits for it) in `overTrunk` arriving while lane 0 is held takes lane
    0 and the hold ends. Its first-parent chain brings the line down to the trunk tip in lane 0.
    A second such tip finds lane 0 taken and curves in as before.
  - *Rule B.* A tip in `overHead` arriving while HEAD's lane is still pending takes that column;
    the pending (dashed) line steps aside to the first free column on its right, with a `pass`
    edge on that row whose `to` differs from its `from`. That is the only diagonal pass the layout
    emits; `edgePath` draws it as an S-curve that clears the node.
  - When HEAD itself is in `overTrunk` (topic checked out, on top of main), HEAD's lane is lane 0
    from the top, as when HEAD is a trunk tip: one straight line from the WIP row to the trunk.
  - When HEAD is a trunk tip, rules A and B pick the same tip: lane 0 for the branch, and the
    dashed line steps to lane 1 and curves into HEAD.
- Without hints (older git, no trunk, no HEAD commit) the layout is exactly what it was.

The trunk tip is the trunk ref that contains the others (origin/main one ahead of main: origin/main).
If main and origin/main have diverged there is no such line, and `overTrunk` is empty.

**Rejected: inferring it in the layout.** The layout streams. When Z arrives nobody knows whether
its line will reach B. A bounded retroactive fix is possible: when B arrives with exactly one
incoming lane k and lane 0 still held, rename lane k to lane 0 on every row since that lane's tip.
It needs no git at all, but it edits rows that are already on screen (and in the virtualized
list's memoized rows), spans page boundaries, and breaks the property that pushing page 2 never
changes page 1, which the paging-equivalence test and the renderer's swap-in both rely on. One
extra `for-each-ref`, run only when the refs change, is simpler and deterministic, and the layout
stays a pure single pass. The cost is one walk per ref change; candidates are branches not yet
merged, so the `rev-list` checks are few and each is bounded by its branch's length (at most 64
are checked).

Both lists are verified with the first-parent check, so a hint always means "this is one line".
(Whether rule B strictly needs it is the question in `docs/learn/07-straight-lanes.md`.)
