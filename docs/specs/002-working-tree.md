# 002: Working tree, staging and commits

**Status:** shipped

## Behaviour

- Selecting the uncommitted-changes row shows Unstaged and Staged lists and the commit box.
- Hover a file for Stage / Unstage / Discard. Stage all / Unstage all / Discard all.
- Clicking a file opens its diff in Details, under the file lists (ADR-011), with Stage / Unstage / Discard for the whole file
  in the file's own header, beside the layout and view controls.
- Hovering a changed line shows a + (or a - in the staged diff) in its gutter: one press stages
  or unstages that line. Stage or discard a hunk with its buttons; for several lines at once,
  click lines (shift-click for a range) and use Stage lines / Unstage lines / Discard lines.
- Diff, History and Blame tabs for the open file. Esc returns to the graph. Blame is a heatmap:
  each commit's lines get one colour, from hot (the newest change still in the file) to cool
  (the oldest), ranked so the colours spread evenly; each block starts with the author's avatar.
- In the Unstaged and Staged lists, Shift-click selects the run of files from the last one
  clicked, Ctrl/Cmd-click adds or removes one. On a selected file, the hover buttons, the
  right-click menu and dragging act on the whole selection ("Stage 4 files").
- Commit with summary + description (Ctrl/Cmd+Enter). Amend prefills the last message.
- Changes made by other tools appear within ~100 ms (file watcher), and on window focus.

## Git commands

`add -A`, `reset -q HEAD --` (or `rm --cached` on an unborn branch), `checkout --`,
`diff --no-ext-diff --src-prefix=a/ --dst-prefix=b/ -U3`, `apply --cached [--reverse]`,
`add -N`, `commit -F - [--amend]`, `hash-object -w` (discard backup).

## Edge cases

Untracked files (synthesized diff; intent-to-add for line staging), binary files, files without a
trailing newline, CRLF, renames (staged diff includes both paths), paths with spaces.

## Undo

Commit/amend: `reset --soft` back. Discard: restore saved blobs. Stage/unstage: none needed
(nothing is lost).

## Acceptance tests

`repo.test.ts` "line staging", "whole-file operations", "commits and undo";
`e2e/workingtree.spec.ts`.
