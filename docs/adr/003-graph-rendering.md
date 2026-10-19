# ADR-003: Graph layout and rendering

**Status:** accepted

## Decision

- Layout (`packages/graph`) is a pure, incremental lane assignment over commits in topological
  order (date or topological, see "Commit order" below), with lane 0 kept for the main line (see "Lane 0 is the trunk" below; it used to be HEAD's). Output per row: node lane, colour, and edges split
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
