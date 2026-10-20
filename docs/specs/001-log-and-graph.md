# 001: Log and graph

**Status:** shipped

## Behaviour

- Opening a repository shows the graph, Tower-style: hollow nodes on coloured lanes, and beside
  them two-line rows (the **Comfy** layout) (avatar; author, branch/tag pills and date; short SHA and subject). A row's
  text starts just past the lanes open at that point in history, so busy stretches indent, up to
  twelve lanes; a node in a lane past that is left out rather than pinned on another branch's
  line. Every row is the same height: there are no month headings (they made rows uneven and
  broke up the lines; the date is on every row).
- Settings → Appearance → Graph layout also offers **Compact**: the same graph and nodes,
  each commit on one 28px line (avatar, short SHA, subject, author, date), with the branch and
  tag pills moved to a 160px column on the left of the graph and joined to their node by a line
  in the lane colour. Author and date are fixed-width, right-aligned columns, so they line up
  from row to row whatever the date reads. The View menu and the command palette switch between
  the two layouts. (Comfy was called "comfortable"; a saved old value reads as comfy.)
- A detached HEAD gets a **HEAD** pill on its commit, in the checked-out branch's colours: with no
  branch checked out, nothing else says "you are here".
- A commit with `Co-authored-by:` trailers shows one avatar per person, stacked as on GitHub, and
  names them beside the author ("Ada Lovelace and Grace Hopper"; more than two are counted).
- The main line (the remote's default branch from origin/HEAD and its local namesake, else main or
  master) is always the leftmost lane, whatever is checked out, so a checkout does not reshuffle
  the graph. HEAD sits on it when HEAD is a trunk tip, otherwise in the lane next to it.
  Uncommitted changes appear as a dashed node at the top in HEAD's lane, joined to HEAD by a
  dashed line. A merge of HEAD (a branch that merged the checked-out main) joins that lane, and
  from there down the line is solid: it is a parent line now, shown with or without changes.
- A merge of the main line's tip (a branch that merged main in) goes straight into the leftmost
  lane where main will arrive, not out to a new lane on the right and back across the branch.
- A branch sitting on top of the main line (or of HEAD) goes straight up from it, as in Tower,
  instead of opening a lane to the right and curving back in. With `topic: X-Y-Z` on `main`'s tip
  B, Z, Y, X and B are one line in the leftmost lane. Checked out, topic shares that lane with
  the main line from the top. When main is checked out and there are uncommitted changes, the
  dashed line from the WIP node steps one lane right under Z, runs beside the branch and curves
  into B. Only one branch can continue a line; a second one on top of main curves in as before.
  "On top" means the branch's own line (first parents) runs down to the tip: a branch that merged
  main contains it but does not count. Needs git 2.41 or newer; older git draws as before.
- History loads as you scroll; the status bar shows "N+ commits" until it is complete.
- Settings → Graph → Commit order: date (default; newest first, branches interleaved by time) or
  topological (each branch's commits kept together; dates run out of order). Also in View →
  Commit Order and the command palette. Switching reloads the graph in place, without a blank
  frame; the layout rules are the same in both.
- Click or J/K/arrows select commits; the right panel shows details and changed files.
- Double-click a commit row to check out what is there: the local branch that points at it, or
  a menu at the pointer ("Check out main / Check out release") when several do, or the commit
  itself, detached, when none does. HEAD's own row, stash rows and the WIP row ignore it. A
  branch pill's double-click checks out that pill's branch and does not reach the row. Every path
  is undoable, and the double-click leaves exactly that commit selected (its second click never
  toggles or extends a selection).
- Search (Ctrl/Cmd+F) by message, author, file path, code (pickaxe) or SHA; Enter/Shift+Enter
  step through matches, non-matches are dimmed.

## Git commands

- `git log --date-order --format=%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00<co-authors>%x00%s%x1e --branches --remotes --tags HEAD --`
  streamed by `LogStream` (ADR-004), where `<co-authors>` is
  `%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x1f)`. With Settings → Graph →
  Commit order set to topological, `--topo-order` replaces `--date-order` (here and in search).
- `git for-each-ref` with NUL-separated fields for refs; `status --porcelain=v2 -z --branch`.
- Branches on top of the trunk or HEAD, when the refs change: `git version` (once per repository),
  `git for-each-ref --format=%(refname)%00%(objectname)%00%(ahead-behind:<trunk>)%00%(ahead-behind:<HEAD>) refs/heads refs/remotes`,
  then for each ref not behind and ahead (at most 64) `git rev-list --first-parent -n <ahead+1> <tip> --`.
- `git commit-graph write --reachable --split` in the background when missing.
- Search: `log --grep -F -i`, `--author -F -i`, pathspec `:(glob,icase)`, `-S`, `rev-parse --verify`.

## Edge cases

Empty repo (WIP row only), detached HEAD (seeded in lane 0 anyway), orphan branches, octopus
merges, criss-cross merges, 100k+ commits, refs changing while a page loads (generation check).
Straight branches: main and origin/main at different commits (the newer one is the base; if they
have diverged, no branch counts as on top of the trunk), a branch on top of a branch on top of
main, a branch that merged main (not straight), HEAD detached or unborn.

## Acceptance tests

- `packages/graph/src/layout.test.ts`: invariants on every fixture shape, paging equivalence, 100k timing.
- `packages/git/src/parsers.test.ts`, `repo.test.ts` "snapshot and log", "reading", "straight tips".
- `apps/desktop/e2e/graph.spec.ts`; `tools/bench` budgets.
