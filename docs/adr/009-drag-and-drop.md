# ADR-009: Drag and drop: the target and the modifier decide, not a chooser

**Status:** accepted (PLAN-4 phase 4)

## Context

GitGoose had GitKraken's drag and drop: drop a branch on another and a menu appears at the
pointer listing what the pair could mean (merge, fast-forward, squash, rebase, reset, check out
and merge…), chosen by which side is checked out. Only branches and commits could be dragged,
and only onto graph rows and pills.

Tower does it differently, across many more pairs (branches, remote branches, tags, commits,
stashes and files, onto sidebar sections, folders, remotes, the working copy and the graph): **the
target and the modifier key decide what a drop does; there is no chooser.** Tower opens the
operation's dialog on a plain drop, and Alt runs the alternative (rebase instead of merge, revert
instead of cherry-pick, fixup instead of squash).

## Decision

- A drop does exactly one thing, decided by (source, target, Alt). `lib/dnd.ts`'s
  `dropPlan(context, source, target, { alt })` returns `{ label, op, confirm? }` or null; the
  matrix in spec 003 is its specification and `dnd.test.ts` its test list.
- GitGoose's house rule is undo instead of dialogs (ADR-005), so where Tower opens a dialog a plain
  drop **runs straight away** and offers Undo. Only drops that change a remote (push, publish,
  force push, push a tag) ask first, as everywhere else in the app. Drops that need a name
  (create a branch or tag) open the name dialog, as the menu items do.
- While dragging, a **badge follows the pointer** saying what the drop will do ("Merge topic into
  main"), and on a second line what Alt would do instead. Pairs not in the matrix are not targets:
  no badge, no highlight, the pointer says no.
- The operation comes back as data (`{ op: 'merge', ref }`), and `performDrop` in
  `lib/actions.ts` runs it through the same actions the menus use. Drops therefore get the same
  undo entries, conflict handling and error reporting, and the matrix can be tested without the
  API.
- One document-level controller (`components/DragBadge.tsx`) handles every drag. Targets only
  declare themselves (`data-drop-target`, the target as JSON; graph rows add
  `data-drop-zones="thirds"` for above / onto / below). The badge and the target's highlight are
  updated by writing to the DOM, not through React state: `dragover` fires many times a second.
  The drag's source is kept in a module variable from `dragstart` to `dragend`, because browsers
  hide a DataTransfer's data until the drop.

## Why not GitKraken's chooser

- **A menu is a second decision after the first.** The user already said what they wanted by
  choosing where to drop. Asking again turns a gesture into a dialog, and most drops have one
  obvious meaning.
- **The menu's options depended on which side was checked out**, which made the same gesture mean
  different things in a way you only learned by reading menus. With a matrix, "branch onto HEAD
  merges it in" is always true.
- **Undo makes committing to one meaning safe.** A wrong drop costs one click on Undo, as a wrong
  menu choice did, without the menu every time.
- The chooser's options are not lost: every one of them is in the branch and commit context
  menus (merge options, rebase, fast-forward, reset).

## The badge is the discoverability

A modifier key is invisible: nobody guesses that Alt turns a merge into a rebase. Tower shows the
operation by the pointer; so does GitGoose, with the Alt alternative spelled out underneath, so
the first drag already teaches the second. The badge's text is the plan's label, the same string
the tests assert, so what the user reads is what the code was tested to do.

## Consequences

- Drops that GitKraken offered but Tower's matrix does not (a branch onto any commit row: reset,
  "check out and rebase") are menu-only now.
- Cherry-picking onto a branch that is not checked out needed a new operation
  (`Repo.cherryPickOnto`, `merge-tree --write-tree --merge-base`, git 2.40+), because `git
  cherry-pick` only works on HEAD. A temporary checkout would touch the working tree and the index
  and could stop half-way on a conflict in a branch the user is not looking at; merge-tree works in
  the object database alone and refuses cleanly instead.
- Chromium scrolls a scrollable list when a drag nears its edge. That is helpful for people and a
  trap for tests: e2e drags keep their targets away from the edges (see `dnd.spec.ts`).
