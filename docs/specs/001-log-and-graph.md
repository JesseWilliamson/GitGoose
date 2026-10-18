# 001: Log and graph

**Status:** shipped

## Behaviour

- Opening a repository shows the graph: branch/tag pills, lanes, message, author, date, SHA
  (author/date/SHA columns appear as the pane widens).
- The main line (the remote's default branch from origin/HEAD and its local namesake, else main or
  master) is always the leftmost lane, whatever is checked out, so a checkout does not reshuffle
  the graph. No other commit moves on checkout either: commits sit where they would with nothing
  checked out. HEAD's row has a lit-up lane band; a detached HEAD gets a "HEAD" pill. Uncommitted
  changes appear as a dashed node at the top (in lane 0 when HEAD is a trunk tip, else lane 1),
  joined to HEAD by a dashed line that steps aside for real lines. Double-clicking a commit checks
  out its local branch, or the commit itself (detached) when no branch points at it.
- History loads as you scroll; the status bar shows "N+ commits" until it is complete.
- Click or J/K/arrows select commits; the right panel shows details and changed files.
- Search (Ctrl/Cmd+F) by message, author, file path, code (pickaxe) or SHA; Enter/Shift+Enter
  step through matches, non-matches are dimmed.

## Git commands

- `git log --topo-order --format=%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s%x1e --branches --remotes --tags HEAD --`
  streamed by `LogStream` (ADR-004).
- `git for-each-ref` with NUL-separated fields for refs; `status --porcelain=v2 -z --branch`.
- `git commit-graph write --reachable --split` in the background when missing.
- Search: `log --grep -F -i`, `--author -F -i`, pathspec `:(glob,icase)`, `-S`, `rev-parse --verify`.

## Edge cases

Empty repo (WIP row only), detached HEAD ("HEAD" pill; seeded like any other HEAD), orphan branches, octopus
merges, criss-cross merges, 100k+ commits, refs changing while a page loads (generation check).

## Acceptance tests

- `packages/graph/src/layout.test.ts`: invariants on every fixture shape, paging equivalence, 100k timing.
- `packages/git/src/parsers.test.ts`, `repo.test.ts` "snapshot and log", "reading".
- `apps/desktop/e2e/graph.spec.ts`; `tools/bench` budgets.
