# 007: Search, multi-select and recompose

Jesse's GitKraken requests after PLAN-2. Code: `packages/git/src/search.ts`, `recompose.ts`,
`Repo.cherryPickMany / commitsText / recomposeInfo / recompose`, renderer `OmniSearch.tsx`,
`RecomposeDialog.tsx`, `selectCommit` in `lib/store.ts`. Tests: `search.test.ts`, `multi.test.ts`,
`recompose.test.ts`, `e2e/graph.spec.ts`, `multiselect.spec.ts`, `recompose.spec.ts`.

## Search

Ctrl/Cmd+K or Ctrl/Cmd+F (or the box in the middle of the toolbar) opens the omni search. The
Commits group matches message, author name and email, SHA prefix, and branch and tag names
(`Repo.searchCommits`); choosing a commit selects it in the graph, paging the log until it is
loaded. There is no second search bar over the graph: one place to search, one set of results.
(The main process still has `Repo.search`, the grey-out search over the whole log, for a later
"filter the graph" view.)

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
   the last commit and reported) and shown for review: commits on the left, the selected one's
   hunks on the right. Drag a commit to reorder it (the list makes room live, the slot it left
   stays empty until it lands); drag a hunk onto a commit to move it there, or into the open
   space below the commits to start a new one — while a hunk is in the air the hunks column dims
   so the commits are the only target. Shift/Ctrl-click several commits and right-click to
   squash them (messages kept, oldest first). Edit messages, preview a unit. Every edit is one
   undo step (Ctrl+Z / Ctrl+Shift+Z inside the dialog; typing in a message or one drag counts
   once), and "Reset to proposal" is itself undoable. Esc ends what is in progress (leaves the message
   field, cancels a drag) and only closes the dialog from rest. Nothing has changed yet. A warning names remote branches that already have the commits.
   The same right-click squash works on a selection in the main graph (`squashOnto`: the newer
   commits fold into the oldest).
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
- Hunks are dragged with pointer events and a floating clone rather than HTML5 drag-and-drop.
  What does that buy (the empty slot, live reorder, the settle animation), and what does it
  cost (keyboard users, dragging out of the window)?
