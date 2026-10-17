# 007: Search, multi-select and recompose

Jesse's GitKraken requests after PLAN-2. Code: `packages/git/src/search.ts`, `recompose.ts`,
`Repo.cherryPickMany / commitsText / recomposeInfo / recompose`, renderer `SearchBar.tsx`,
`RecomposeDialog.tsx`, `selectCommit` in `lib/store.ts`. Tests: `search.test.ts`, `multi.test.ts`,
`recompose.test.ts`, `e2e/graph.spec.ts`, `multiselect.spec.ts`, `recompose.spec.ts`.

## Search

Ctrl/Cmd+F (or Search in the toolbar) opens a bar over the graph. One query matches message,
author name and email, SHA prefix, and branch and tag names; non-matches grey out in place;
"N of M", Enter / Shift+Enter, Esc closes. Files and Code are separate, slower scopes. Main walks
the log once in graph order (same revs and `--topo-order` as LogStream) and tests each commit in
JS; a newer search cancels the running one; the renderer drops stale answers.

## Several commits

Shift-click: range in graph order from the anchor. Ctrl/Cmd-click: add or remove one.
Shift+arrows: grow the range. The details panel and the right-click menu then offer:
cherry-pick all (oldest first, commits already on the branch skipped, one undo entry), copy as
diff (a chain is one `diff oldest^ newest`), copy as patch (a chain is a numbered
`format-patch` series), copy SHAs, Recompose with AI.

## Recompose with AI

For a run of non-merge commits on the current branch with only non-merge commits after it
(one commit works too: "Split with AI…").

1. `git diff --no-renames --binary base newest` is cut into units: text hunks, or whole files
   without hunks (binary, mode change). The AI gets the original messages and the numbered
   units and answers with JSON: commits, oldest first, each with a message and unit ids.
2. The answer is repaired (unknown ids dropped, duplicates kept once, forgotten units added to
   the last commit and reported) and shown for review: reorder, squash into next, edit
   messages, reset, preview a unit. Nothing has changed yet. A warning names remote branches
   that already have the commits.
3. Create commits: in a throwaway index (`GIT_INDEX_FILE`), each commit's units are applied with
   `git apply --cached`, then `write-tree` and `commit-tree`. **The last tree must equal the
   newest original's tree** or nothing changes. So the commits after the range keep their trees
   exactly and are re-created with new parents (same message, author and date). One
   `update-ref` with the old value moves the branch; one undo entry moves it back. The working
   tree and the real index are never touched.

Authors: one original author keeps authorship; several make you the author with a
`Co-authored-by` trailer for each.

## Questions worth thinking about

- Why can the commits after the range never conflict, when a normal rebase could?
- A unit moved to an earlier commit than its neighbour in the same file: why does `git apply`
  still find where it goes? When would it not?
- What would it take to let the user drag a single unit from one proposed commit to another?
