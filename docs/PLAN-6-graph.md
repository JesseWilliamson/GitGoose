# Plan 6: the commit graph, rewritten and redesigned

Jesse's brief, October 2026: rewrite and redesign the graph in GitGoose, informed by the report *Git
Tree Views: How Commit Graphs Handle Many Branches* (the comparison of GitKraken, Sublime Merge,
Fork, Sourcetree, Git Extensions, gitk, VS Code Git Graph, git-graph and jj). The report's recipe:

1. Sort rows with a temporal topological sort.
2. Assign lanes straight: finished lanes become empty slots, new branches reuse a slot or append,
   and a merge parent skips columns its edge would cross.
3. Pin main to column 0 with a fixed colour; order the other lanes by role, then lifespan.
4. Fold merged branches by default, expandable by clicking the merge dot.
5. Cap visible lanes and show a marker (git's `~`) for anything cut.
6. Render only visible rows and edges.

This document is the plan: where the graph is today, the model the redesign is built on, and the
work split into pull requests so that several can be built at once. Read `CLAUDE.md` first; its
rules (git only through `GitRunner`, the two performance rules, the definition of done) apply to
every PR here. ADR-003 holds the decisions already made about the graph; this plan amends it where
it says so and nowhere else.

dsviz's example *Ways to draw a commit graph* (the examples page of
https://jessewilliamson.github.io/DiagramBuilder/, code editable in place) draws the main ideas
below on one history with the controls live. A fuller set of figures (the walk stepped row by row
with its slot array, the three row orders, pinning, a branch on top of main, folding and capping,
the viewport) is parked on the `claude/website` branch as a website for GitGoose, for when one is
wanted. Read them beside this plan: a figure there is the picture a PR here has to produce.

## Where the graph is today

What exists, so the plan builds on it rather than beside it:

- **Rows** come from git in `--date-order` (the default) or `--topo-order`. Both are topological
  sorts; `--date-order` breaks ties by date, which is the report's step 1 done by git. Nothing to do.
- **Lanes** (`packages/graph`): one pass carrying `lanes[]`, lane 0 held for the trunk, HEAD's lane
  seeded for the dashed WIP line, straight slots (free ones are reused, trailing ones dropped), the
  straight-tip hint from git (ADR-003). Colour is the column's (`column % 8`). A merge parent takes
  the leftmost free slot, crossing whatever lies between.
- **Rendering** (`GraphCell.tsx`): a virtualized list, one small SVG per row, edges split at the
  node into `pass`, `top` and `bottom`. Rounded corners (`edgePath`). Comfy rows (Tower) and compact
  rows (GitKraken, avatar nodes). Past eight lanes the column clips, with a "›" in the header.
- **Hiding**: hide and solo per branch (`snapshot.filter`), the line view (one line of history,
  spec 007). No folding, no focus mode.
- **Pins** exist for the sidebar: `gitgoose.pin` in git config, a Pinned section (spec 003). They do
  not touch the graph.
- **Budgets** (`tools/bench --check`): first log page, layout of 100k commits (~90 ms), first paint
  (~520 ms), scroll at 60 fps.

Against the recipe: step 1 done, step 2 without the crossing rule, step 3 for main only, step 4
missing, step 5 a clip without a marker, step 6 done.

## The model

Every picture of a commit graph is two choices, and the vocabulary below is used in the code, the
specs and the figures, so one word means one thing everywhere:

| word | meaning |
|---|---|
| **row** | one commit, in the order git prints them (children above parents) |
| **slot** | an entry in the walk's array: the hash the column is travelling down to meet, or free |
| **column** | the x position of a slot, `lane` in the code |
| **line** | a run of first-parent history; it owns its colour, and stays in one column (straight lanes) |
| **pin** | a tip whose line owns a column from the top of the graph: the trunk today, any branch after PR 3 |
| **fold** | a merge whose side branch is not listed; drawn hollow with a plus, click to unfold |
| **cap** | the number of columns drawn; past it, a `~` on every row a hidden column crosses |

Two decisions from ADR-003 stand: lanes are straight (a line never moves sideways; the report's
"compact" style is in dsviz for comparison only), and the layout is a single streaming pass
whose state is the slot array, so pushing page 2 never changes page 1. Every piece below keeps
both, and the paging-equivalence test in `layout.test.ts` is the guard.

## The pieces

| # | PR | wave | depends on |
|---|---|---|---|
| 1 | Layout v2: colour per line, nearest free slot, a pin list | 1 | – |
| 2 | Lane cap with git's marker | 1 | – |
| 3 | Pin any branch to the left (sidebar pins drive the graph) | 2 | 1 |
| 4 | Fold merged branches, unfold with a click | 2 | 1 |
| 5 | Focus mode: your branch, its upstream, its target | 2 | – |
| 6 | One SVG per viewport (an experiment, measured) | 2 | 1 |
| 7 | Visual redesign: nodes, pills, density | 3 | 1, 2, 4, 6 |
| 8 | dsviz as the playground, and the learning exercises | every wave | – |

Wave 1 PRs touch disjoint files and merge in any order. Wave 2 starts from main after wave 1.
Wave 3 is the look, and comes last so it does not fight the mechanics.

---

## 1. Layout v2: colour per line, nearest free slot, a pin list

**Why.** Three small things in `packages/graph` that every later piece needs. Colour by column
means a line that curves into another column changes colour at the bend, which reads as two
branches. A merge parent that takes the leftmost free slot draws its edge across every column in
between; the dsviz example with everything shown has the crossings. And the trunk reservation
is a special case of a general rule, pinning, that PR 3 and PR 4 both want.

**Design.**

- A `Lane` gets a `color` when it opens: the smallest colour no open lane is using. With straight
  lanes that is the column, so today's pictures are unchanged; it only matters once a lane is
  re-coloured by a pin or a line continues through a bend. `Row.color` and `Edge.color` come from
  the lane, not the column. (dsviz's `gitLanes` does exactly this; port it.)
- `freeSlot(from)` for a merge parent prefers the free slot **nearest the node**, either side,
  ties to the left, instead of the leftmost. It cuts the crossings a streaming walk can see (those
  in the merge's own row); the crossings it cannot see (the parent landing elsewhere) stay, and
  the report's full forbidden-column check is out of reach without the whole list. Say so in the
  ADR amendment.
- `LayoutOptions.trunk` becomes `pins: readonly string[][]`: a list of columns, each holding the
  tips that may claim it (today: `[trunkTips]`). Column *k* is held until the first of its tips
  arrives; a tip in `straight.overTrunk` continues column 0 as before (rule A), generalised to
  "continues the column its base is pinned to". HEAD's lane sits after the pinned columns, unless
  HEAD is on a pinned line.

**The interesting idea.** The colour rule shows what a "line" is: not a column and not a branch
name, but the thing a slot carries while it is open. Once colour belongs to the slot, pinning and
folding stop being special cases: they only decide which slot a commit lands in.

**Tests.** `layout.test.ts`: colours stay with lines through a bend; the nearest-slot rule on the
report's four-feature history (count crossings per row, assert fewer than before); pins in two
columns; paging equivalence and `checkInvariants` unchanged. `pnpm bench --check` (the layout
budget).

**Jesse's part.** The nearest-free-slot rule and its crossing count, as exercise 9 (see PR 8).

## 2. Lane cap with git's marker

**Why.** Clipping past eight lanes hides commits silently: a node past the cap is simply not
drawn, and only a "›" in the compact header hints at it. git's `--graph-lane-limit` (2026) sets the
convention: cut lanes are marked with `~` on every row they cross. Users read `~` as "more here".

**Design.**

- The cap is a setting, Settings → Graph → Lanes shown (default 8, as today); the compact header's
  "›" goes.
- `Row` gains nothing: the renderer knows the cap. `GraphCell` draws, in the column just past the
  cap, a small tilde on every row where `row.width > cap` (a node or an edge past it), in the
  muted colour. An edge heading past the cap ends in the tilde column; one coming back from it
  starts there, so nothing dangles (dsviz's `maxLanes` does this; copy its clipping of the course).
- A commit whose own lane is past the cap keeps its row and its text; its node is the tilde. Its
  pills and menu work as before.
- Comfy rows, which indent by the lanes open, indent to the cap at most, as now.

**Tests.** `GraphCell` unit test (happy-dom) for the three cases: node past the cap, edge passing,
edge leaving; e2e on the `many-branches` fixture (add it: ten branches open at once) checking a
`~` is present and the row's subject still is. `bench --check` for scroll fps.

## 3. Pin any branch to the left

**Why.** The report: "main on the left with a stable colour is the near-universal wish", and
GitKraken 11.10 lets you pin any branch to the left edge. GitGoose already has pins, in the
sidebar; they should mean the same thing in the graph. One concept, two places.

**Design.**

- The snapshot's `trunkRefs` becomes the first entry of `graph.pins`: `[trunk, ...pinnedBranches]`
  in pin order, each entry the ref's tips (local and remote with the same name share a column, as
  they share a pill). PR 1's layout takes it as `pins`.
- Pinning from the graph: Pin / Unpin on a branch pill's menu (the sidebar's action, reused), and
  drag a pill onto the graph header to pin it (the drop matrix in spec 003 gains one row).
- A pinned column is held from the top. The cost (ADR-003, "a branch on top of a reserved line")
  applies per pinned column, and the straight-tip hint is computed per pinned tip:
  `Repo.straightTips` runs `%(ahead-behind:<tip>)` once per pinned tip in the same
  `for-each-ref` call (git lets a format repeat the atom), so one walk still covers all pins.
- The HEAD lane rule stays: HEAD on a pinned line shares its column; otherwise the next column.

**The interesting idea.** The "line" in the sidebar (a pinned branch) and the "line" in the graph
(a held column) become one object with one storage (`gitgoose.pin`). Undo already covers pin and
unpin (ADR-005).

**Tests.** `repo.test.ts`: `straightTips` with two pins; snapshot `graph.pins` order follows pin
order; layout tests from PR 1; e2e: pin from the menu, see the column change, undo.

## 4. Fold merged branches, unfold with a click

**Why.** The report's step 4 and its most-loved feature: Fork users name collapse-all-merges as a
top reason to prefer it; Sublime Merge folds by default and calls the result "a clean, drillable
line". Nothing in GitGoose hides a merged branch today except hiding its (usually deleted) ref.

**Design.** Two parts, git and layout, and the layout part is the one to get right.

- **Git.** A folded merge hides the commits reachable from its other parents but not from its
  first parent: `rev-list <p2> ^<p1>`, bounded (`-n 2000`; a bigger side branch is shown unfolded
  with a note). "Fold all" is cheaper and exact: `git log --first-parent --all` walks main's line
  and every unmerged tip and never visits a merged branch's inside. So the default view is a
  `--first-parent` walk, and unfolding one merge adds its side branch.
- **Layout.** The side branch's commits must appear between the merge and its fork point, which
  are rows already on screen. Inserting rows breaks "pushing page 2 never changes page 1" for the
  rows below the merge. That is acceptable here, because the user asked for it, but it must stay
  bounded: the layout keeps a **checkpoint** (a copy of the slot array and the colour set) every
  256 rows. Unfolding merge *m* restores the checkpoint before *m*, replays from there with the
  side commits spliced in (in git's own order: `rev-list --date-order <p2> ^<p1>` is already
  topological against the merge), and re-emits the rows from the checkpoint down. Everything above
  the checkpoint is untouched. Folding again is the same replay without the splice.
- **Where the side commits go.** Spliced in right below the merge as one block, newest first, as
  Fork does. Interleaving by date across the first-parent rows would be nicer to read and far
  harder to keep stable; try it in dsviz first (PR 8) before deciding.
- **Renderer.** A folded merge is a hollow ring with a plus (dsviz's `git-fold`), click or Space
  to unfold, a count in its tooltip ("12 commits"). The log keeps a `folded: Set<hash>`; the store's
  `rows` array is rebuilt from the checkpoint down, and the virtualizer measures nothing because
  every row is still the same height. Scroll position is kept on the merge row (the trick
  `LineBar` uses).
- **Interplay.** The line view (spec 007) is fold-all for one line; keep it, it is the keyboard's
  way. Search dims non-matches; a match inside a folded branch unfolds it. Bisect ignores folds.

**The interesting idea.** The checkpoint turns an append-only walk into one that can be re-run
from the middle at a cost proportional to the distance from the last checkpoint, not to the
history. It is the same move as git's commit-graph generation numbers: store a little state
periodically so you never have to start from the top.

**Tests.** `layout.test.ts`: replay from a checkpoint equals a fresh layout (the new paging
equivalence); fold then unfold restores the original rows byte for byte. `repo.test.ts`: the
first-parent walk and `sideCommits(merge)` on the `merges` fixture. e2e: click a merge, see its
branch, scroll position unchanged. `bench --check`: the first-parent walk is faster than the full
one; add a budget for unfolding a 500-commit branch (< 50 ms layout).

**Jesse's part.** The checkpoint and replay in `GraphLayout` (exercise 10).

## 5. Focus mode

**Why.** GitKraken's Smart Branch Visibility: show the current branch, its upstream, its merge
target (the trunk) and their upstreams, nothing else. The report lists it as the tool-decided
answer to "too many branches", beside the user-decided solo and the number-decided cap.

**Design.** A filter preset, not a new mechanism: `snapshot.filter.solo` already exists. View →
Focus (and the palette) sets solo to `[HEAD's branch, its upstream, trunk, trunk's upstream]` and
keeps it in step as HEAD moves (the preset is stored as a flag, the list recomputed per snapshot).
The filter bar says "Focus: main, feature, origin/feature · Show all". Hide and solo compose with
it as they do today.

**Tests.** `graphFilter.test.ts` for the recomputed list across a checkout; e2e: Focus, check out
another branch, the bar follows.

## 6. One SVG per viewport (an experiment)

**Why.** Per-row SVGs force edges to be split at row boundaries, so a curve across several rows is
drawn as a straight pass segment per row with corners only at the nodes. GitKraken's long, gentle
curves, and the report's step 6 as Vigier does it (edges crossing the viewport found with an
interval tree, 106 ms to under 1 ms), both want one drawing surface for the visible window. One
`<svg>` the height of the viewport, translated with the scroll, drawing the edges that intersect
the visible rows as whole paths, could also halve the DOM: one path per visible edge instead of
one per row per lane.

ADR-003 said: switch away from per-row SVG only if measurement says so. Nothing has, so this PR is
an **experiment with a budget**, not a decision.

**Design.**

- `packages/graph` keeps per-row edges (every other piece relies on them) and adds an **edge index**:
  for each line, the row it opens and the row it closes, in a sorted array (an interval tree is
  overkill for sorted, append-only intervals: a binary search on the start plus a sweep on open
  lines is enough). `edgesCrossing(firstRow, lastRow)` returns the lines to draw.
- A `GraphCanvas` component renders behind the virtualized rows: absolutely positioned, height of
  the scroll viewport, `transform` from the virtualizer's scroll offset, one `<path>` per line in
  view with its bends drawn as `edgePath` does today, plus the nodes. Rows draw text only.
- Measure on the bench: scroll fps, first paint, DOM node count, on 100k commits and on the
  Express history (40 open lanes). Keep it only if scroll fps holds at 60 and first paint does not
  regress; else keep the index (it is small and useful for the cap) and drop the canvas, recording
  the numbers in ADR-003.

**Tests.** `edgesCrossing` against a brute-force scan on every fixture; the bench's budgets.

## 7. Visual redesign

**Why.** The mechanics above change what a row can show (fold rings, tildes, pinned columns,
whole-edge curves); the look should be decided once over all of it, with the report's findings as
the brief: straight lanes, main left with a fixed colour, colour per line, no idle lines, hiding
one click away, curves or corners as a setting.

**Design.** A spec first (`docs/specs/009-graph-v2.md`, from `TEMPLATE.md`), with figures drawn
with dsviz as its pictures, then one PR per layout (comfy, compact). Points to settle in the spec:

- Nodes: ring (comfy) and avatar (compact) stay; a folded merge is a ring with a plus in both; the
  tilde is the cut mark in both; HEAD's outer ring stays.
- Colour: per line (PR 1), the trunk always colour 0; pinned branches keep their colour across
  sessions (store the colour index with the pin? decide in the spec).
- Bends: a setting, Curves (S-curves across rows, needs PR 6) or Corners (today). If PR 6 is
  dropped, Corners only, and the setting goes.
- Pills: the branch/tag column (compact) and inline pills (comfy) stay; a pinned branch's pill gets
  a pin glyph; the "+N" overflow opens the list on click, not only on hover.
- Density: the comfy row's tight lanes past four and the compact column's fixed width stay; the cap
  (PR 2) replaces the clip in both.
- The dashed WIP line stays straight (ADR-003, "The dashed line to HEAD is straight").

**Tests.** The UI audit routine from Plan 5 (`docs/ui-audit.md`): a screenshot per state per
layout, light and dark, in the e2e suite.

## 8. dsviz as the playground, and the learning exercises

**Why.** Every layout change here is a change to a 250-line pure function, and the hard part is
knowing what picture is right before writing it. `@dsviz/git` runs the same walk with the report's
layouts as options (`lanes`, `pin`, `fold`, `maxLanes`, `bend`), on a history small enough to read,
with the before/after animated because commits are keyed by hash. dsviz's examples page is that
playground published, and its editor runs changed code in place.

**Design.**

- A layout change is tried as a figure in dsviz first (in the examples page's editor, or as a new
  registry example; a new option in `@dsviz/git` if needed), then ported to `packages/graph` with
  the same history as a test fixture. `tools/fixtures` gains a `fromHistory(commits)` helper that
  builds a real repository from the figure's commit list, so the picture and the e2e test see the
  same history.
- Exercises in `docs/learn/`, in the series' format (file, tests, the idea in one paragraph, do it,
  questions, extensions): 09 nearest free slot and crossing counts (PR 1); 10 checkpoints and
  replay (PR 4); 11 the edge index (PR 6). Each is written when its PR lands, from the PR's tests.

## Not doing, and why

- **Compact (curved) lanes.** The report's enthusiasts and ADR-003 agree on straight lanes. dsviz
  draws compact lanes so the choice is visible, not because the app will offer it.
- **A temporal topological sort in the app.** git's `--date-order` is one, and with a commit-graph
  file its first page costs 10 ms (ADR-004). Sorting in the app would mean waiting for the whole
  log.
- **Retroactive lane renaming** for a branch on top of main: rejected in ADR-003 for breaking page
  stability; the straight-tip hint from git does the job and PR 3 extends it to every pin.
- **Branch roles by regex** (git-graph). Pins cover the cases people ask for (main, develop, a
  release branch) without a configuration language. Revisit if pinning proves not enough.
- **Interleaving unfolded commits by date.** Maybe later; try it in dsviz first (PR 4).

## Open questions for Jesse

1. Fold by default (Sublime Merge) or show everything by default with Fold All one key away
   (Fork)? Default folded is the report's recipe and the faster first paint; it also hides the
   shape of history until asked, which is the thing GitGoose is for. Suggested: everything shown
   by default, Fold All as a remembered toggle, and a first-run hint.
2. Should a pinned branch keep a fixed colour across sessions (GitKraken), or take the colour its
   column gives it?
3. PR 6 is the only piece that can fail its budget. Do it second in wave 2, so if it is dropped the
   visual spec knows before it is written.
