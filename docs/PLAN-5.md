# Plan 5: panes, an AI chat pane, honest menus, and a cleaner UI

Jesse's brief, October 2026:

> Add a full pane/window system, and an AI chat pane where all AI interactions live, so that they
> aren't lost: chat there, with the selected commits or branches (and more) as context, drag things
> in, and run the AI actions (rebase, recompose, …) from it. When an action cannot be done (no
> recompose over merge commits), grey it out in the context menu with a tooltip saying why. Fix the
> indent in the line view (Ctrl+L). Cache model loads. Use shadcn components (the dropdowns are
> bad) and shadcn's sonner for toasts. Audit the UI: clean it up, redesign what does not work,
> design fundamentals, keep it clean, reasonable, functional, beautiful.

This document is the plan: what each piece is, the idea behind it, and how the work is split into
pull requests so that several can be built at once. Read `CLAUDE.md` first; its rules (git only
through `GitRunner`, the two performance rules, the definition of done) apply to every PR here.

## The pieces

| # | PR | wave | depends on |
|---|---|---|---|
| 1 | UI foundation: shadcn-style primitives, sonner toasts, Select everywhere | 1 | – |
| 2 | Line view draws its line in the first lane | 1 | – |
| 3 | Model lists are cached, loaded once | 1 | – |
| 4 | Context menus: grey out with a reason instead of hiding | 2 | 1 |
| 5 | Pane system (ADR-010): slots, tabs, moving, the AI pane docked | 2 | 1 |
| 6 | AI pane: context chips, drag in, actions from the pane | 2 | 1 |
| 7 | UI audit and redesign (two PRs: audit 1, then audit 2) | 3 | 4, 5, 6, 8 |
| 8 | Settings page: one grid | 2 | 1 |
| 9 | Custom title bar on every platform | 1 | – |

Wave 1 PRs touch disjoint files and merge in any order. Wave 2 starts from main after wave 1.
Wave 3 is the polish pass over everything and comes last so it does not fight the others.

---

## 1. UI foundation (shadcn primitives, sonner)

**Why.** `components/ui.tsx` wraps Radix with one look, but the native `<select>` elements
(ModelPicker, Settings, dialogs, MergePanes) look foreign and cannot be styled, the toasts are
hand-rolled, and there is no tooltip primitive at all (titles only). shadcn/ui is the standard
answer: small components you own, built on Radix and Tailwind, styled through CSS variables.

**What.**

- shadcn itself (Jesse: "I meant literally use shadcn"): `shadcn init` (Tailwind v4, CSS
  variables, `components.json`, an `@/` alias for the renderer) and `shadcn add` for each
  component, the files kept as generated so a later `add` can overwrite them. The CLI brings
  its own dependencies (`class-variance-authority`, `tailwind-merge`, `sonner`, Radix).
- `components/ui/`: `button`, `select`, `dropdown-menu`, `context-menu`, `tooltip`, `dialog`,
  `input`, `textarea`, `switch`, `checkbox`, `tabs`, `separator`, `badge`, `kbd`, `toggle`,
  `popover`, `scroll-area`, `sonner`, all generated. shadcn's CSS variables (`--background`,
  `--primary`, `--border`, …) are defined in `styles.css` for both themes from the app's
  existing palette, so the components look native; the rest of the app keeps its token
  utilities (`bg-panel`, `text-muted`, …) until the audit pass. Anything of ours (the `reason`
  prop, `OptionSelect`) wraps a generated component rather than editing it.
- `components/ui.tsx` keeps exporting the same names (`Button`, `ToolbarButton`, `Kbd`,
  `Spinner`, `SectionHeader`, `CM`, `DM`, `Modal`, `TextField`) but implemented over the new
  primitives, so no other file must change in this PR. `CM.Item` and `DM.Item` gain
  `reason?: string`: with a reason the item is disabled and a tooltip (and `aria-description`)
  says why. PR 4 uses it.
- Every native `<select>` becomes the shadcn `Select` (ModelPicker, SettingsPage, Dialogs,
  MergePanes). Tests that pick options by `selectOption` move to clicking the trigger and the
  option (`getByRole('combobox')`, `getByRole('option')`).
- Toasts: `sonner`'s `<Toaster>` at the app root, themed; `toast()` and `dismissToast()` in
  `lib/store.ts` keep their signatures and call sonner; `components/Dialogs.tsx`'s `Toasts` goes.
  The e2e tests find toasts by `data-testid="toasts"` and `toast-action`: keep those ids on
  sonner's container and action button (sonner lets a toast render custom JSX).
- `TooltipProvider` at the root; `ToolbarButton` shows a real tooltip instead of `title`.

**The idea to notice.** Components you own, not a component library: shadcn is a pattern, not a
dependency. We keep the Radix behaviour we already trust and change only what things look like.

**Tests.** The existing e2e suite is the test: everything still passes with the selects and
toasts replaced. One new unit test for `cn()` is enough; the primitives are presentational.

---

## 2. Line view: the line in the first lane

**Why.** Ctrl+L shows only one line of history, but each node keeps the lane it had in the full
graph, so a feature branch's line sits indented in lane 4 with nothing to its left. That was a
deliberate choice (the line "stays where it was drawn") that reads as a bug.

**What.** While the line view is on, every row of the line is drawn in lane 0 (`lineEdges`
in `lib/lineView.ts` and the node position in `GraphCell.tsx`); the graph column is as narrow as
one lane. The lane *colour* is kept, so the line still looks like the branch it is. Turning the
line view off puts everything back.

**Tests.** `lineView.test.ts`: `lineEdges` returns edges from lane 0 to lane 0 whatever the row's
lane. `e2e/lineview.spec.ts`: a node in the line view has the same `cx` as a lane-0 node.

---

## 3. Model lists are cached

**Why.** "Load models…" starts an agent (or hits the API) every time the list is not at hand; the
API's list lives only in the renderer's memory and is gone after a restart; several pickers on
screen can load the same list at once.

**What.** Read `components/ModelPicker.tsx` and `main/ai/service.ts` (`aiModels`,
`aiLoadModels`) first and fix exactly the gaps found:

- The API's list is kept in settings (`aiApiModels: { models, at }`) like the agents' lists, so
  it survives a restart; a list older than 24 hours is shown but marked stale.
- One in-flight load per target key, shared by every picker (a module-level map of promises).
- A *Refresh* entry in the model select, in place of the one-shot *Load models…*, when a list is
  already known.
- Settings → AI → *Test* updates the agent's cached list as a side effect, since it starts the
  agent anyway.

**Tests.** `main/ai/service.test.ts` (or the nearest existing test file): a second `aiModels`
for the API serves the saved list without a request; the fake API counts its calls.

---

## 4. Context menus: disabled with a reason

**Why.** Today an action that cannot run is simply absent, so the user cannot tell "this is
impossible right now" from "this does not exist". A greyed item with a reason teaches the rule.

**What.** A pure module `lib/menuRules.ts`: for each conditional action, a function that returns
`undefined` (allowed) or the reason as a short sentence, e.g.

- recompose / split: "Recompose works on non-merge commits on the current branch that are not
  under a merge" (one reason per failing condition: merge commit, another branch, a merge above
  it, the working tree is dirty if the operation needs it clean).
- squash into the commit below: "This is the oldest editable commit".
- fast-forward: "Already up to date" / "Has commits of its own".
- push: "No upstream: publish the branch first"; force push: same.
- cherry-pick / check out this commit: "This is HEAD".
- AI items when AI is off: "Turn on AI features in Settings".
- merge/rebase onto the current branch: "This is the current branch".
- delete branch: "The current branch cannot be deleted".

`menus.tsx` uses `reason={...}` on those items instead of `&&`-hiding them. Items that are pure
alternates (Pin / Unpin, Show / Hide in the graph) stay as toggles.

**Tests.** `menuRules.test.ts` covers each rule; one e2e asserts a disabled item with its tooltip
text (`aria-disabled` and the tooltip content).

---

## 5. Pane system (ADR-010)

**Why.** The window has three fixed places. Plan 2 §7 designed movable panes and Jesse later
removed moving; this brings a pane system back on purpose, because the AI pane needs a home the
user chooses (right of the graph for a wide screen, below it for a laptop), and the same
mechanism gives Details, Branches and future panes the same freedom. Write it down as
`docs/adr/010-panes.md`.

**Layout as data** (`packages/shared/src/layout.ts`):

```ts
type Slot = 'left' | 'right' | 'bottom'
type PaneId = 'branches' | 'details' | 'ai'
interface SlotState { panes: PaneId[]; active: PaneId | null; size: number; collapsed: boolean }
type PaneLayout = Record<Slot, SlotState>
```

Default: left `[branches]`, right `[details, ai]` (details active), bottom `[]`. Pure reducers
with unit tests: `movePane(layout, pane, slot, index?)`, `showPane`, `hidePane`, `activate`,
`normalizeLayout` (repairs saved layouts: every pane appears at most once, a missing pane is
hidden, the old two-slot shape upgrades to this one).

**Rendering** (`components/Workspace.tsx`, new `components/Pane.tsx`): `react-resizable-panels`
as now, left | centre | right horizontally, with the bottom slot in a vertical group under the
centre. A slot with panes shows a tab strip (shadcn `Tabs` look): one tab per pane, the active
one's body below; a slot with one pane shows its title as the strip. Each tab is draggable
(native drag, like branch pills; MIME `application/x-gitgoose-pane`); while a tab is in the air,
drop zones appear on the left, right and bottom edges of the workspace and on each tab strip.
Each tab has a menu: *Move to left / right / bottom*, *Hide*. View menu: show/hide each pane,
*Reset layout*; `Mod+B` branches, `Mod+Shift+A` the AI pane (shows and focuses it, hides it if
focused), `Mod+J` the bottom slot. A hidden pane is the only way it disappears; collapsing a
slot keeps its panes.

**Keyboard and persistence.** Sizes persist per slot as now; the layout is one setting, so every
window agrees. A collapsed slot with the AI pane in it expands when a thread in it gets an answer.

**The AI pane in this PR.** `AiChatPanel` stops being an overlay and becomes the `ai` pane's body
(its header's close button goes; the pane chrome has it). The "Open" of an AI job and the toasts
that say an answer arrived show the pane instead of the overlay. Keep `AiChatPanel`'s inside as
it is: PR 6 rewrites it and should not conflict with this PR's chrome.

**Tests.** `layout.test.ts` for every reducer. `e2e/layout.spec.ts`: move Details to the left,
it renders left of the graph; drag the AI tab to the bottom, it renders under the graph; hide and
show; reset; sizes persist after restart (the existing test).

---

## 6. The AI pane: context, drag in, actions

**Why.** AI interactions today are spread over dialogs, rails and modals, and a free chat knows
only the repository's name. The pane should be the one place: everything AI shows up in its
history, and a message can carry what the user is looking at.

**What.**

- **Context chips.** Above the composer, the current selection is a chip: "commit a1b2c3",
  "3 commits", "branch feature/x", "uncommitted changes", "compare a..b". It is attached to the
  next message unless the user removes it (×). More chips come from drag and drop: commits,
  branches/tags, stashes and files dropped on the pane (decode with `lib/dnd.ts`'s `decodeDrag`).
  Chips are data: `AiContextRef = { kind: 'commits', hashes } | { kind: 'ref', name } |
  { kind: 'stash', ref } | { kind: 'files', rev, paths } | { kind: 'wip' } | { kind: 'compare', from, to }`
  in `packages/shared/src/ai.ts`.
- **Main renders the context.** `aiThreadSend(threadId, text, { context })` is an additive
  change to the IPC contract. Main turns each ref into text with git (`show --stat` and the
  message for commits, `log --oneline -20` and the diff stat since the merge base for a branch,
  the diff for files, `status` for the working tree), capped like the commit-message feature
  (60k chars, lockfiles excluded), and sends it under the user's words; the turn's `sent` keeps
  it so the thread shows what went out, as every other feature does.
- **Actions from the pane.** A row of buttons above the composer, enabled by the chips present:
  *Explain*, *Review*, *Walk through*, *Impact*, *Recompose* / *Split*, *Rebase onto…*,
  *Cherry-pick onto HEAD*. They call the existing starters (`startReview`, `startWalkthrough`,
  `showImpact`, `recomposeWithAi`, `explain`, the git actions); their threads appear in the
  pane's history at once. Disabled ones say why (the same `menuRules` as PR 4).
- **Nothing is lost.** Every kept thread of the repository is in the history list (it is already);
  the list groups by day and shows the anchor's kind and a one-line summary; a thread that is
  running shows a spinner; the current thread is marked. Error and conflict threads open here.
- The composer is the shadcn `Textarea`; Enter sends, Shift+Enter breaks a line (as now).

**The idea to notice.** Context is references, not text, until the last moment: the renderer never
reads git (performance rule 1), and main has the repository and the size limits.

**Tests.** `packages/shared` unit tests for the context rendering's pure parts (capping,
ordering); `e2e/thread.spec.ts` or a new `e2e/aipane.spec.ts` against the fake agent: select a
commit, send "what is this", the fake agent's echo shows the commit's hash in *Sent*; drag a
branch pill onto the pane, a chip appears; *Review* from the pane opens a review thread.

---

## 7. UI audit and redesign

**Why.** The app grew feature by feature; the brief says parts look bad. This pass goes back to
fundamentals: one spacing scale, one type scale, consistent headers, aligned controls, enough
contrast, and nothing decorative that does no work.

**How.** First the audit, as `docs/ui-audit.md`: screenshots of each surface (the e2e harness
can take them: Toolbar, Sidebar, Graph in both styles, Details for a commit and for the working
copy, a diff, Settings, the dialogs, the AI pane, Welcome), each with what is wrong in one line and
what to do. Then the fixes, by surface. **The audit is split into two PRs**, because one was too
big to review: *UI audit 1* does the foundations and the AI surfaces, *UI audit 2* does the rest.
`docs/ui-audit.md` says which finding is in which. Each item below is tagged.

UI audit 1 (the audit document; the scale and the single colour vocabulary; the AI pane redesign;
`AiTargetButton`, the one compact "who answers" control, replacing the two selects and the Prompt
button in Details, the commit box, the AI pane, the Review / Walkthrough / Impact rails and
Recompose; the pane tab strip with a right slot) and UI audit 2 (Sidebar, graph lanes and
compact columns, Toolbar, Welcome, omni search, dialogs, the diff header, the status bar, the
Details header, the working copy's split, section headers, and the contrast of hint text).

- **Scale** (audit 1). Type: 11 / 12 / 13 / 15 px only. Spacing: 4 px grid. Radii: 4 / 6 / 8.
  Heights: rows 24 / 28, inputs 28, toolbar 40, tab bar 36 (the title bar), strip 28, status bar
  24. Put them in `styles.css` as tokens and use them. Also one colour vocabulary (shadcn's names
  and meanings, app-wide; the mapping is in `docs/ui-audit.md`).
- **Hierarchy** (audit 1 for the AI surfaces and the tab strip; audit 2 for the rest). Section
  headers one style (the `SectionHeader`), dialog titles one style, one
  accent colour used only for the primary action and selection, muted for secondary text,
  faint for hints. No three shades of grey text in one row.
- **Toolbar** (audit 2). Fewer, clearer controls; the location on the left, actions grouped (sync, branch,
  stash), search in the middle, undo/redo and settings on the right; consistent icon size.
- **Sidebar** (audit 2). Rows align on one indent; counts and badges right-aligned in one column; section
  headers collapsible with a chevron on the left; hover and selection states consistent with
  the graph's.
- **Details** (audit 2; its Explain row is in audit 1). The commit header as one block (avatar, author, date, SHA with copy), the message
  as prose, the file list as a tree with the same row height as the sidebar.
- **Graph rows** (audit 2). Pills, date, author aligned to the same baselines; the compact style's lane
  strip not competing with the selection colour.
- **Dialogs** (audit 2). shadcn `Dialog` layout: title, body, actions right-aligned, primary last; one
  width per kind.
- **Empty states and hints** (audit 1 for the AI pane, audit 2 for the rest). One voice, one place (under the header), no paragraphs where a
  line will do.
- **Light theme** (both). Every change checked in both.

**Tests.** The e2e suite passes; `pnpm bench --check` passes (graph rows changed). Screenshots
before and after in the PR description.

---

## 8. Settings page: one grid

**Why.** Jesse: "the settings being all weird and unaligned is crap." Each control is right-aligned
at its own intrinsic width, so segmented controls, sliders, selects, inputs and switches make a
ragged right edge; descriptions under the labels make rows of uneven height; the AI section nests
a card with its own inner grid at a different indent. Nothing lines up because nothing shares an
edge.

**What** (`components/SettingsPage.tsx`, `packages/shared/src/settings.ts` only for labels):

- One grid for every row: a label column (label, then the description under it in muted 12 px)
  and a control column of one fixed width (360 px) at the right of a page column of fixed width
  (max 960 px, centred). Every control fills the control column: segmented controls, selects,
  text inputs, sliders (track plus value), buttons. The one exception is the switch, pinned to
  the right edge of the column. Each row has the same vertical padding (12 px) and a 1 px line
  below it; a section header has the same spacing above and below throughout.
- Segmented controls whose options are too long for the column wrap to a select.
- The AI section is rows like every other section: *AI features*, *Agent*, *Test* as a row with
  its button in the control column and the agent's reported name as the description; the
  *Prompts* editor is a full-width block under its own row (tabs on the left, editors on the
  right, the shadcn `Tabs` look), not a nested card.
- The sidebar nav highlights the section in view as the page scrolls, and the search box is the
  `Input` primitive at the same width as the nav.
- Keyboard section: the same grid (shortcut label left, the key chips right-aligned in the
  control column).
- Both themes checked.

**Tests.** `e2e/settings.spec.ts` passes unchanged (ids and labels stay); one new assertion:
every control in the Appearance section has the same left `x` and the same width (read bounding
boxes of the control column's children).

## 9. Custom title bar on every platform

**Why.** Jesse: "use a custom title bar." The window is frameless only on macOS
(`titleBarStyle: 'hiddenInset'`, the tab bar row is the title bar); Windows and Linux show the
native frame and the native menu bar above the app's own chrome, two title rows instead of one.

**What** (`main/index.ts`, `main/ipc.ts`, `packages/shared/src/api.ts`, `components/TabBar.tsx`,
`styles.css`):

- `titleBarStyle: 'hidden'` everywhere (`hiddenInset` stays on macOS so the traffic lights sit
  in the tab bar row). On Windows, `titleBarOverlay` with our colours (the native controls keep
  Snap Layouts); on Linux, controls drawn by the renderer (minimise, maximise/restore, close)
  through three IPC methods plus a `windowState` event for maximised/unmaximised. The overlay
  colours follow the theme (`win.setTitleBarOverlay` when the setting changes).
- The tab bar row is the drag region (`.drag`) with every control `.no-drag`; its height is the
  title bar height (36 px) on all platforms, with the macOS traffic-light inset on the left and
  the controls' width reserved on the right on Windows and Linux.
- The application menu: on macOS unchanged. On Windows and Linux the native menu bar is hidden
  (`autoHideMenuBar`, Alt still shows it) and a menu button (☰) at the left of the tab bar pops
  the same application menu (`Menu.popup`) at the pointer, so every command and shortcut stays
  reachable with the mouse.
- Double-clicking the empty tab bar maximises/restores (macOS follows the system preference).
- `e2e/window.spec.ts`: the tab bar reports the drag region, the controls minimise/maximise/close
  on Linux (xvfb), the menu button opens a menu with "File". The window-size memory test stays.

**The idea to notice.** Two kinds of frameless window: the OS still draws its controls
(`titleBarOverlay`) or the app draws them. The first keeps OS behaviours (Snap Layouts, the
window menu); the second works everywhere. Use the first where it exists.

## How the PRs are run

Each PR is built by an agent in its own worktree from `main` (wave 2 and 3 after the earlier
wave merged), on a `claude/plan5-<name>` branch, with `pnpm typecheck`, `pnpm test` and
`xvfb-run -a pnpm e2e` green before it is opened. The PR description explains the design
decision and the idea worth learning, in plain words. CI (ubuntu, macOS, Windows) must be green
and review comments answered before merge; merges go to `main` in the order above.
