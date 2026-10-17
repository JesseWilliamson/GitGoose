# 004: Undo and the conflict wizard

**Status:** shipped

## Undo

- Ctrl/Cmd+Z (outside text fields), the toolbar Undo button (its tooltip names the operation),
  the Undo button on success toasts, or the palette.
- Undo refuses, with an explanation, if HEAD moved since the operation (another tool changed the
  repository).
- See ADR-005 for each operation's inverse.

## Conflicts

- When a merge, rebase, cherry-pick, revert or pull stops on conflicts, the centre switches to the
  conflict wizard (also reachable from the banner in the right panel).
- Left: conflicted files, then resolved ones. Right: the selected file's conflict blocks, each
  with Ours and Theirs side by side; pick Use ours / Use theirs / Use both / Use original (diff3).
  Save resolution writes the file and stages it. Take ours / Take theirs resolve the whole file
  (also delete/modify conflicts). Open launches the default editor; Mark resolved stages a file
  edited elsewhere.
- Text files open in the three-pane view by default (setting *Conflict view*; a Three panes /
  Blocks toggle per file): yours, the editable result, theirs, each side diffed against the base
  (`merge3`). Side changes have apply (» «) and ignore (×) buttons; Apply non-conflicting;
  previous/next conflict; *Start from* non-conflicting applied, the ancestor, or git's merge with
  markers. A conflict is resolved when either side is applied, both are ignored, or it was
  edited. Save needs every conflict resolved and no markers left. Undo (Ctrl+Z) reverts statuses
  with the text. Panes scroll together, aligned on blocks.
- Continue (enabled when nothing is unmerged) and Abort.

## Git commands

`cat-file --batch` for `:1:path`, `:2:path`, `:3:path`; `checkout --ours|--theirs --`; `add --`;
`rm --` (delete side); `commit --no-edit` / `rebase --continue` / `cherry-pick --continue` /
`revert --continue`; the matching `--abort`. Operation state from `.git/MERGE_HEAD`,
`rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`.

## Acceptance tests

`repo.test.ts` "conflicts", "commits and undo" and others; `e2e/power.spec.ts`.
