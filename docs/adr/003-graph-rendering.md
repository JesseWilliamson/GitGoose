# ADR-003: Graph layout and rendering

**Status:** accepted

## Decision

- Layout (`packages/graph`) is a pure, incremental lane assignment over commits in topological
  order, with lane 0 kept for the main line (see "Lane 0 is the trunk" below; it used to be HEAD's). Output per row: node lane, colour, and edges split
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
