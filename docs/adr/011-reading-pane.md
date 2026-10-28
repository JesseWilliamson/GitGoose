# ADR-011: The reading pane, and one graph density

**Status:** accepted (the workspace redesign, option A). Amends ADR-010.

## Context

Jesse's complaint, October 2026: you cannot see the commit details, the diff, the graph, the AI
chat and the branches at once, and the way the app switches between them is bad. The compact
graph is a copy of GitKraken's, the comfy one is too sparse, and having two is bad in itself.

Two rules of ADR-010 caused the first part. A file's diff opened *in* the centre, so the graph
went away while you read it; and Details and the AI pane were tabs in one slot, so one hid the
other. Every task showed at most three of the five things, and the user moved between them by
navigating instead of looking.

The redesign brief proposed three layouts. Jesse chose option A, the reading pane: the mail
client's model, where the graph is the inbox and a commit opens beside it as one document.

## Decision

**Four columns.** Branches, the graph (the centre), Details (the commit over its file), the AI.

- A fourth slot, `farRight`, outside `right`. The default layout is `left [branches]`,
  `right [details]` at 480 px, `farRight [ai]` at 320 px, `bottom []`. The slot rules of ADR-010
  are unchanged; `farRight` is one more slot like the others (tabs, drag, Move to, collapse).
  The window's right edge drop zone now means `farRight`, the outermost column; `right` takes a
  drop on its tab strip or through Move to right.
- **A narrow window folds the AI column.** Below `FOLD_BELOW` (1360 px) the four columns do not
  fit at a usable size, so when the window crosses below it, `fold` collapses `farRight` and marks
  it `folded`; whenever the window is wide again, `unfold` opens it. The mark is data in the layout
  (it survives a restart) and `setCollapsed`, `showPane` and `movePane` clear it, so the window
  never reopens something the user closed. Only the crossing folds: Mod+Shift+A opens the AI in a
  narrow window and it stays open until the window next becomes narrow. At 1024 px this gives
  branches 224, the graph 320, Details 480: the same Details width as before this ADR.
- **The columns' widths are applied as one row** (`useColumnWidths`, the group's `setLayout`):
  each column at its stored width or 0, the graph the rest. Collapsing one panel at a time let the
  panel library give the freed width to its next neighbour, which with `farRight` is often
  another column (even a folded one) rather than the graph.
- **Workbenches get the width.** While the centre holds recompose or the conflict wizard, Details
  is shown collapsed (view state only, never saved): both were designed for far more than the
  graph's width, and neither uses Details. Review, walkthrough and impact keep Details, because
  their findings open files in it.
- `normalizeLayout` upgrades a stored layout from before `farRight` that still has the AI beside
  Details in `right` (the old default): the AI moves out to `farRight` and `right` widens to at
  least 480 px. An AI pane the user had put elsewhere stays there, and once `farRight` is stored
  the upgrade never runs again, so putting the AI back beside Details is a choice that sticks.

**The diff is part of Details, not a centre view.** ADR-010's "the centre does not move" stays;
what changes is what the centre holds: the graph, or a *task* that takes it over (conflicts,
review, walkthrough, impact, recompose, reflog, command log). A file is not a task.

- `CenterView` loses its `file` kind. `RepoView.file` holds the file opened in Details (target and
  mode: diff, history or blame), and back/forward record it (`NavLocation.file`).
- **A file belongs to a selection** (`lib/openFile.ts`): a commit's file to that commit (or to a
  multi-selection that includes it), a working-copy file to the working copy, a range to its
  comparison. Details shows the open file only while it belongs to the selection; otherwise it
  shows the selection's first file. This replaces "close the diff when the selection changes":
  nothing has to remember to close it, and returning to a commit finds the file you were reading.
- `openFile` (lib/actions.ts) is the one way to open a file, from a file list, a review finding,
  a walkthrough, the omni search or a file's history. It selects what the file belongs to when
  that is something else, shows Details, and leaves the centre alone, so a review you clicked a
  finding in stays on screen.
- Details is split: the selection's details take what they need up to half the pane and scroll
  inside it; the file takes the rest. The first file waits until the selection has been still for
  120 ms, so holding an arrow key in the graph does not start a diff for every commit it passes
  (the performance rule: cost follows what is on screen). A file the user opened shows at once.
- The file view has no close button and Esc no longer closes it: there is nothing behind it to
  go back to. In a narrow Details its controls wrap onto a second line instead of hiding the name.
- A working-copy diff has a footer for the line selection, present whether or not lines are
  selected (a hint, or the selection's Stage / Discard). It used to be a bar that appeared above
  the lines on the first click, which moved every line down before the second click of a double
  click; in Details' shorter diff that opened the wrong line in the editor.

**One graph density.** The `graphStyle` setting is gone, with the compact layout
(`lib/graphColumns.ts`, avatar nodes, lane bands, the fixed branch / tag column) and the comfy
two-line row. A row is 28 px (`h-row-lg`), one line: lanes with ring nodes (comfy's geometry,
unchanged), then the branch and tag pills, then the subject (muted for a merge), the SHA on the
selected row only, and narrow author and date columns on the right. The graph pane is a CSS
container: the author's name shows from 600 px, the date from 360 px, so the four-column
layout's narrower graph keeps the message rather than squeezing it. A stored `graphStyle` is a
key the settings no longer have and is dropped on read.

## Consequences

- At 1440 px everything is on screen at a usable size: the graph about 410 px, Details 480 px.
  Below 1360 px the AI column folds away (see above) and comes back on demand.
- The diff gets Details' width, about 470 px by default: fine for unified diffs, too narrow for
  split. Widening Details or hiding the AI pane is the way to a split diff.
- Every graph change is now designed and tested once. The bench budgets do not change: they
  measure the log, the layout and painting, not the row's height.
- Anything that opened a file through `center` now calls `openFile`. A new place that opens a
  file must too; the compiler enforces it, since `center: { kind: 'file' }` no longer type-checks.

## Later: room for big diffs

Living with the layouts showed every one of them squeezing the diff: half of Details' height, or
one column's width. Two additions give it an editor's main pane:

- **A Diff pane.** `diff` is a pane id: the file Details shows, in a column of its own at full
  height. While it is in no slot (the default) Details shows the file under the commit as before;
  while it is on screen, Details is the details only. The selection's first file is shared through
  `lib/shownFile.ts`, so Details and the Diff pane always show the same file. The Review layout uses
  it: a narrow graph, the commit's files, and the diff as the widest column.
- **Reading wide** (`Mod+Shift+Enter`, or the button at the end of the file's header): the file
  takes the centre at full height, Details stays beside it for its file list, and every other
  column steps aside on screen only (like a workbench). Esc puts everything back as it was.

The graph's rows also lost the author's name: the picture says who at a glance, the name is on
hover, and the message keeps the width.
