# ADR-012: Scenes, and the reader

**Status:** accepted. Supersedes ADR-010 (movable panes) and amends ADR-011 (the reading pane
stays as the Browse scene).

## Context

Jesse, October 2026, after living with ADR-011 and eight layout presets: "One big problem is the
diffs being hard to read when all squished up. That's why GitKraken and GitHub Desktop and Sublime
Merge all give them a big chunk of the screen. Panes don't need to be movable, and maybe a better
approach is to have different views/screens/scenes so sometimes diffs can take up a whole screen."

A design lab (three rounds, fourteen concepts, six critiques; the report is the artifact "GitGoose
Layout Lab") walked six workflows through every concept and measured them. Concepts that put
every pane on one screen squeezed the diff below 700 px or broke under stress; concepts with a
screen per job and a full-width reader held up. Round 3 converged on one design, built here.

## Decision

**Four scenes, fixed, one key each.** `RepoView.scene`:

| key | scene | what it is for |
|---|---|---|
| 1 | Browse | the graph, Details and the branches (ADR-011's columns, no longer movable) |
| 2 | Read | the selection's diff taking the screen: a 320 px left column and the reader |
| 3 | Changes | the working copy: its lists and the commit box on the left, every changed file in the reader |
| 4 | Resolve | the conflict wizard, only while an operation is stopped on conflicts |

- Digits switch scenes when no text field has focus (Mod+digits still switch repository tabs).
  Space or Enter on the graph reads the selection; Esc goes back (first closing what is open
  inside the scene: a line selection, the AI face).
- **Every scene keeps its place.** The selection is shared and anchored by hash; Read remembers
  where each stream was left (`read.anchors`, by the stream's blocks), so going back lands on the
  same line. Hidden scenes are unmounted; their state is data, not DOM.
- **The reading scenes' left column changes face, never width**: Around (the narrow graph and the
  current block's files with viewed marks) or AI (the conversation). The AI never covers code and
  never answers unasked. `\` folds the column to a 44 px rail for a 1,380 px reader.
- **Resolve opens by itself** when an operation stops on conflicts, as the conflict view did.
  (The lab's guard, "only for an operation started in the app and only if the user has not moved
  since", needs the operation's origin in the snapshot; it is the next step, not this one.)

**The reader** (`components/DiffStream.tsx`, `lib/stream.ts`) shows every file of every block (a
commit, a run of commits oldest first, a comparison, the unstaged and staged changes) in one
scrolling list.

- **One virtualizer over fixed-height rows**: block header, file header, hunk header, line, and a
  pair of lines (old beside new in Split, left column beside right column in Flow). A line that
  does not fit wraps, and since the font is monospace the number of screen lines it takes is known
  from its display columns. So the list never measures, like the graph (ADR-003), and jumping to a
  file lands exactly. This is what keeps rule 2 (cost proportional to what is on screen) for a
  3,000-line file.
- **The layout is chosen per file from its content** (`packages/shared/src/reader.ts`): Flow (two
  newspaper columns) for an added-only or deleted-only file at most two screens long whose every
  line fits a column; Split for a modified file whose longest line fits a side; Unified otherwise.
  Widths are display columns (tabs expanded, wide glyphs two cells) with two to spare, and the
  room is measured from the code font and the file's own line-number width. The header's chip
  says which and why ("Flow · longest 64 ≤ 68"), and clicking it overrides. The working copy stays
  Unified, where line staging works (ADR-006).
- **Loading follows the screen.** `diffStream` (IPC) returns a block's files with their numbers
  and the diffs of the first files up to a line budget, from one `git diff`; the rest arrive by
  path as their rows come into view, and the rows hold their place until they do. Generated files,
  unchanged renames and files over 400 lines start collapsed, with the reason.
- **One reading cursor**: J/K next or previous commit (past the end of the stream, the next commit
  in the graph), n/p file, Space and Shift+Space a screen, v viewed. Viewed marks are keyed by the
  file's blob pair, so they survive a rebase that did not change the file.
- **Lines selected in a commit can be taken back out of the working copy** (Shift+R,
  `revertLines`), undoably: the "fix one thing while reviewing" step of the review workflow.

**The graph's lane spacing is a prop** (`LaneGeom`): the Browse graph at 24/16 px per lane, the
narrow graph in the left column at 12/8, the same shape at half the pitch. The lane cap itself is
left to PLAN-6 (its tilde marker), not changed here.

## Consequences

- ADR-010's dragging, tab strips and the bottom slot go; the `layout` setting keeps column widths
  and collapsed flags only. `normalizeLayout` still reads older layouts.
- The diff in Details stays, as a glance at the selection's first file; reading happens in Read.
- The five questions the lab left for Jesse were answered with the critics' recommendation, each
  easy to revisit: the working copy is its own scene (Changes), the AI is the left column's face,
  modified files Split when they fit, branch housekeeping stays beside the graph, and Resolve
  opens by itself.
