# 007: Search, multi-select and recompose

Jesse's GitKraken requests after PLAN-2. Code: `packages/git/src/search.ts`, `recompose.ts`,
`Repo.cherryPickMany / commitsText / recomposeInfo / recompose`, renderer `OmniSearch.tsx`,
`RecomposeDialog.tsx`, `selectCommit` in `lib/store.ts`. Tests: `search.test.ts`, `multi.test.ts`,
`recompose.test.ts`, `e2e/graph.spec.ts`, `multiselect.spec.ts`, `recompose.spec.ts`.

## Search

Ctrl/Cmd+K or Ctrl/Cmd+F (or the box in the middle of the toolbar) opens the omni search. The
Commits group matches message, author name and email, any part of the SHA (two characters
match a prefix; four or more anywhere in the hash, up to all of it), and branch and tag names
(`Repo.searchCommits`); choosing a commit selects it in the graph, paging the log until it is
loaded. There is no second search bar over the graph: one place to search, one set of results.
(The main process still has `Repo.search`, the grey-out search over the whole log, for a later
"filter the graph" view.)

## Several commits

Shift-click: range in graph order from the anchor, keeping only commits on the anchor's lane
(the same line of history; a range across a merge leaves the other branch out). Ctrl/Cmd-click: add or remove one.
Shift+arrows: grow the range. The details panel and the right-click menu then offer:
cherry-pick all (oldest first, commits already on the branch skipped, one undo entry), copy as
diff (a chain is one `diff oldest^ newest`), copy as patch (a chain is a numbered
`format-patch` series), copy SHAs, Recompose with AI.

## Line view

View → Line View (Mod+L), or the command palette, with a commit selected: the graph shows only
the *line of history through the cursor commit* and hides everything else, until Mod+L again, Esc
in the graph or the bar's "Show all". (It used to come on while Shift was held; that made every
Shift-click and Shift+arrow flicker the graph, so it is a toggle only.)

- **What the line is** (`lib/lineView.ts`, `lineThrough`): down, the commit's first parent, its
  first parent, and so on while they are loaded; up, the child whose first parent it is *and* whose
  row is in the same lane (the one the layout handed its lane down to), and so on. Where no child
  continues the lane, the line came in from a fork and the walk stops. This is git's own
  definition of a branch's path (`--first-parent`), drawn the way the lane layout draws it.
- **How it shows**: `GraphList` maps list positions to log rows through a `Uint32Array`; no
  relayout, no array per frame. Rows draw only the line, in their colour, all in the first lane
  (a branch is a path; the lane is only where the full graph had room for it), and the graph
  column shrinks to match. Pages that load while it is on extend it downward (the walk
  runs again per page; near the end of the line the list keeps loading until the next first
  parent arrives). The uncommitted-changes row shows only when HEAD is on the line.
- **Nothing moves under the pointer**: the cursor row keeps its screen position when the graph
  collapses and when it expands (the list scrolls, and pads above a short line), so the eye does
  not have to find it again. The bar ("Showing the line through abc1234 · N commits hidden · Esc
  to show all") floats over the bottom of the graph for the same reason.
- **Inside it**: Shift-click and Shift+arrows select as always (along the anchor's lane);
  Ctrl/Cmd-click toggles. The line stays the one through the commit it was turned on at.
- A line whose commit disappears (amend, rebase) moves to the selection, else to HEAD.
  (Mod+Shift+L, as first planned, is Fetch.)

## Recompose with AI

For a run of non-merge commits on the current branch with only non-merge commits after it
(one commit works too: "Split with AI…").

1. `git diff --no-renames --binary base newest` is cut into units: text hunks, or whole files
   without hunks (binary, mode change). The AI gets the original messages and the numbered
   units and answers with JSON: commits, oldest first, each with a message and unit ids.
2. The answer is repaired (unknown ids dropped, duplicates kept once, forgotten units added to
   the last commit and reported) and shown for review: commits on the left, newest at the top
   and oldest at the bottom as in the graph (up moves a commit later), the selected one's
   hunks on the right. Drag a commit to reorder it (the list makes room live, the slot it left
   stays empty until it lands); drag a hunk onto a commit to move it there, or into the space
   above the newest commit to start a new one — while a hunk is in the air the hunks column dims
   so the commits are the only target. Shift/Ctrl-click several commits and right-click to
   squash them (messages kept, oldest first). Edit messages, preview a unit. Every edit is one
   undo step (Ctrl+Z / Ctrl+Shift+Z inside the dialog; typing in a message or one drag counts
   once), and "Reset to proposal" can itself be undone. Esc ends what is in progress (leaves the message
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

Chat: **Chat** beside the plan opens the conversation the proposal came from (spec 006,
threads): "put the tests in their own commit". A revised plan comes back as a `json:plan`
card, repaired exactly like the first proposal; **Apply** makes it the editor's plan as one
undo step, so Ctrl+Z returns to what you had.

## Ask about lines

Select lines in any diff and **Ask**: a thread with an `ask` anchor (the lines, at the commit
they were read at), docked under the diff. The first question goes with Ask's context (the
lines, the definition around them, definitions of what they use, their history and blame);
follow-ups go to the same agent session. Answered threads are saved per repository and listed
under their commit's details ("Questions"), which reopens them. The thread rules (sessions,
replay after a restart, permissions, artifacts) are spec 006's.

## Questions worth thinking about

- The line view walks *down* first parents with `log.index` but needs a separate child map to walk
  *up*. Why does git make one direction free and the other something you must build?

- Why can the commits after the range never conflict, when a normal rebase could?
- A unit moved to an earlier commit than its neighbour in the same file: why does `git apply`
  still find where it goes? When would it not?
- Hunks are dragged with pointer events and a floating clone rather than HTML5 drag-and-drop.
  What does that buy (the empty slot, live reorder, the settle animation), and what does it
  cost (keyboard users, dragging out of the window)?
