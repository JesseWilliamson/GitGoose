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
| [008](008-code-context.md) | what the AI is told besides the diff: intent (commit messages) and the code graph's context, budgeted |

## Window chrome

The tab bar row is the title bar on every platform: 36 px tall, a drag region (`.drag`) whose
tabs and buttons are `.no-drag`. Double-clicking its empty part maximises or restores (macOS does
this itself). The window is frameless (`titleBarStyle: 'hidden'`, `hiddenInset` on macOS).

- macOS: the traffic lights sit in an inset at the left; the system menu bar is unchanged.
- Windows: the OS draws the caption buttons (`titleBarOverlay`, so Snap Layouts work); their
  colours follow the theme (`windowSetOverlay`) and the bar reserves their 138 px.
- Linux: the page draws minimise, maximise/restore and close (`windowMinimize`,
  `windowToggleMaximize`, `windowClose`; `window-state` events keep the icon current).
- Windows and Linux hide the menu bar (Alt still shows it); the menu button (☰) at the left of the
  bar pops the same application menu at the pointer (`menuPopup`).
