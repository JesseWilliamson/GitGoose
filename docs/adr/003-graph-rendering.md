# ADR-003: Graph layout and rendering

**Status:** accepted

## Decision

- Layout (`packages/graph`) is a pure, incremental lane assignment over commits in topological
  order, with HEAD's lane reserved as lane 0. Output per row: node lane, colour, and edges split
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
