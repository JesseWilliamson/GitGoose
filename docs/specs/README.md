# Feature specs

One file per feature slice. A spec is written (or approved) by Jesse before an agent builds the
slice, and updated by the agent when reality disagrees. Start from `TEMPLATE.md`.

The specs below describe what shipped in the first build and are the baseline for changes.

| spec | covers |
|---|---|
| [001](001-log-and-graph.md) | log streaming, lane layout, graph rendering, search |
| [002](002-working-tree.md) | status, diffs, staging files/hunks/lines, commit, amend |
| [003](003-branches-and-remotes.md) | checkout, branches, tags, merge/rebase/reset, cherry-pick, revert, drag and drop, fetch/pull/push, credentials |
| [004](004-undo-and-conflicts.md) | undo journal, conflict wizard |
