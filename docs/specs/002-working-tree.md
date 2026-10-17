# 002: Working tree, staging and commits

**Status:** shipped

## Behaviour

- Selecting the uncommitted-changes row shows Unstaged and Staged lists and the commit box.
- Hover a file for Stage / Unstage / Discard. Stage all / Unstage all / Discard all.
- Clicking a file opens its diff in the centre. Stage or discard a hunk with its buttons; click
  lines (shift-click for a range) and use Stage lines / Unstage lines / Discard lines.
- Diff, History and Blame tabs for the open file. Esc returns to the graph.
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
