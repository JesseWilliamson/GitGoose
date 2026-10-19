# 001: Log and graph

**Status:** shipped

## Behaviour

- Opening a repository shows the graph, Tower-style: hollow nodes on coloured lanes, and beside
  them two-line rows (avatar; author, branch/tag pills and date; short SHA and subject). A row's
  text starts just past the lanes open at that point in history, so busy stretches indent, up to
  twelve lanes; a node in a lane past that is left out rather than pinned on another branch's
  line. Every row is the same height: there are no month headings (they made rows uneven and
  broke up the lines; the date is on every row).
- Settings → Appearance → Graph layout also offers one-line rows: the same graph and nodes,
  each commit on one 28px line (avatar, short SHA, subject, author, date), with the branch and
  tag pills moved to a 160px column on the left of the graph and joined to their node by a line
  in the lane colour. The View menu and the command palette switch between
  the two layouts.
- A commit with `Co-authored-by:` trailers shows one avatar per person, stacked as on GitHub, and
  names them beside the author ("Ada Lovelace and Grace Hopper"; more than two are counted).
- The main line (the remote's default branch from origin/HEAD and its local namesake, else main or
  master) is always the leftmost lane, whatever is checked out, so a checkout does not reshuffle
  the graph. HEAD sits on it when HEAD is a trunk tip, otherwise in the lane next to it.
  Uncommitted changes appear as a dashed node at the top in HEAD's lane, joined to HEAD by a
  dashed line.
- History loads as you scroll; the status bar shows "N+ commits" until it is complete.
- Click or J/K/arrows select commits; the right panel shows details and changed files.
- Search (Ctrl/Cmd+F) by message, author, file path, code (pickaxe) or SHA; Enter/Shift+Enter
  step through matches, non-matches are dimmed.

## Git commands

- `git log --date-order --format=%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00<co-authors>%x00%s%x1e --branches --remotes --tags HEAD --`
  streamed by `LogStream` (ADR-004), where `<co-authors>` is
  `%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x1f)`.
- `git for-each-ref` with NUL-separated fields for refs; `status --porcelain=v2 -z --branch`.
- `git commit-graph write --reachable --split` in the background when missing.
- Search: `log --grep -F -i`, `--author -F -i`, pathspec `:(glob,icase)`, `-S`, `rev-parse --verify`.

## Edge cases

Empty repo (WIP row only), detached HEAD (seeded in lane 0 anyway), orphan branches, octopus
merges, criss-cross merges, 100k+ commits, refs changing while a page loads (generation check).

## Acceptance tests

- `packages/graph/src/layout.test.ts`: invariants on every fixture shape, paging equivalence, 100k timing.
- `packages/git/src/parsers.test.ts`, `repo.test.ts` "snapshot and log", "reading".
- `apps/desktop/e2e/graph.spec.ts`; `tools/bench` budgets.
