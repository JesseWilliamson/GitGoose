# Plan 4: Tower's sidebar and drag-and-drop, a calmer graph, conversational AI, Change Stack, dsviz

Jesse's brief (October 2026), in his words, with what each item turns into:

| ask | what it becomes | phase |
|---|---|---|
| "show the branches on the left the same as gittower" | the sidebar re-done as Tower's: sections, folder tree for `a/b/c` names, badges, context menus, filter | 4 |
| "support the same drag and drop behaviours as gittower" | Tower's full source → target matrix, with the drop menu per pair | 4 |
| "hide nonsequential commits when you hold shift after selecting a commit" | *line view*: while Shift is held, the graph shows only the line of history through the selected commit | 3 |
| "when a branch is on top of another we can just show it as going straight up, not out to the right" | the layout lets a branch that sits on top of the trunk (or HEAD) continue that lane instead of opening one to the right | 2 |
| "make the selection box blue not the branch colour" | one-line change plus a test | 1 |
| "double clicking should checkout" | double-click a commit row (not only a pill or sidebar item) checks out the branch there, or the commit detached | 1 |
| "replicate the coderabbit features and ui here as closely as possible (change-stack)" | a Change Stack view: a stack of reviewable layers over a branch, each with its own review, summary, diagram and chat | 7 |
| "add an option for topological commit sort" | Settings → Graph → Commit order: date / topological | 1 |
| "remove the month headers from the tree" | delete them from the two-line layout too | 1 |
| "allow chatting with agents in the reviews and explanations and recompose and other ai features" | long-lived ACP sessions, a chat thread under every AI result, tool calls and permissions shown inline | 5 |
| "allow using copilot as an acp agent" | a GitHub Copilot preset (`copilot --acp`), with its auth and permission quirks handled | 5 |
| "use the diagrambuilder library, write a skill for using it, and extend it to meet the needs of gitgoose" | dsviz as a dependency, a `dsviz` skill in both repos, new families (git graph, DAG layout, diff) and a JSON spec the model can emit | 6 |

Rules that carry over from PLAN.md and the ADRs, and that every prompt repeats: the renderer never
blocks; cost follows what is on screen; every write goes through `exclusive()` and records undo when
it can; git is run through `GitRunner` with `-z`/NUL formats only; no network nobody asked for; AI
sends nothing without consent and every agent tool call needs permission; typecheck, test, e2e (and
bench when the graph or log changes) are green before every push; every change has a test that would
fail without it.

How to run this plan: `docs/PLAN-4-prompts.md` has one prompt per phase, in order. Each prompt is
self-contained (it names the files, the design, the tests and the definition of done) and is meant
for a fresh Opus session in the GitGoose checkout (phases 6a and 6b run in the DiagramBuilder
checkout). Run them in order; 1 → 2 → 3 are independent of 4; 5 before 7; 6 before 7.

---

## What already exists (audit, so nobody builds it twice)

Read before touching anything; several asks are partly shipped.

- **Double-click to check out** is shipped for branch pills in the graph and sidebar items
  (`RefPill.onDoubleClick`, `RefItem.onDoubleClick`; spec 003). It is *not* on commit rows.
- **Drag and drop** exists for branch → branch/commit (`dropOptions` in `lib/actions.ts`, the
  `DropMenu` in `menus.tsx`) and commits → commits on the editable part of the current branch
  (move / squash, spec 007). Nothing is droppable onto the sidebar, nothing drags stashes, tags,
  remotes or the working copy, and `dropOptions` is GitKraken's matrix, not Tower's.
- **Multi-select** (`selectCommit` in `lib/store.ts`): Shift-click ranges already keep only the
  anchor's *lane* ("the same line of history"). Phase 3 generalises that idea into a view.
- **The one-line layout** (`graphStyle: 'compact'`) already puts branch and tag pills in a 160px
  column left of the graph with a connector line to the node. Phase 4 is about the *sidebar*
  (Tower's left panel), not that column. Keep both layouts.
- **Month headers** exist only in the two-line layout (`useMonthStarts`, `HEADER_H`, `month-header`).
- **Selection tint**: `CommitRow` paints `color-mix(lane 22%, bg)`; the WIP row already uses `bg-select`.
- **Log order** is hard-coded to `--date-order` in `LogStream.start()` (`packages/git/src/log.ts`).
- **AI**: one-shot ACP sessions per request (spec 006, deliberately), text-only streaming, a modal
  permission queue, a pseudo-chat Ask panel that re-sends its transcript each turn, a JSON
  sequence diagram drawn by `lib/sequence.ts`. Presets: Claude, Codex, Gemini, custom
  (`AGENT_PRESETS` in `packages/shared/src/ai.ts`, duplicated as the `aiAgent` choice in
  `settings.ts`).
- **CodeRabbit-style features** from PLAN-3 Part B: review with verified findings, apply/fix,
  learnings, incremental re-review, walkthrough with effort and sequence diagram, reading order,
  ask-about-lines, impact, linters, secret scan, pre-push checks. Change Stack builds on all of
  them; it does not replace them.
- **dsviz** (`/home/user/DiagramBuilder`, npm `dsviz` 2.1.0): framework-free SVG scene library
  with a keyed tween renderer, `<Diagram>` for React, families `ds/plot/prob/geom/sched/mem/uml/sys`,
  `toSVG` for static output, injected styles, dark mode via `.dark`. No JSON spec, no auto-layout
  (class/state/architecture/graph need x/y), graph nodes are circles only, no git-graph family.

---

## Phase 1: graph polish (four small, independent changes)

### 1a. Selection is blue

`CommitRow`'s `row-tint` div: when selected, use the `bg-select` class (the same token the WIP row,
sidebar and palette use) instead of the lane `color-mix`. Delete the `lane` colour from the tint
path entirely; keep hover as is. e2e: in `graph.spec.ts`, select a row and assert the tint's
computed background equals the `--gs-select` value, in dark and light.

### 1b. No month headers

Remove `useMonthStarts`, `HEADER_H`, the `month` prop, `monthLabel`/`sameMonth` if unused, the
`offset` parameter of `GraphCell`, the `headers` flag in `GraphList` and every `header` arithmetic in
`CommitRow` (drop zones, tint top). `estimateSize` becomes a constant, which also lets the
virtualizer skip measurement. Update spec 001 and the `graphStyle` description in `settings.ts`.
Remove `month-header` assertions from e2e. Run `pnpm bench --check` (rows get cheaper; budgets must
still hold).

### 1c. Double-click a commit row checks out

In `rowProps`, `onDoubleClick`: if a *local* branch points at the commit and it is not HEAD, check
it out (`checkout(repoId, ref.name)`, which already handles "would be overwritten" with the stash
offer and is undoable). If several local branches point there, open the existing drop-style menu
at the pointer listing them ("Check out main / Check out release"). If none, check out detached
(`checkout(repoId, hash)` ⇒ `git checkout --detach`, undoable). Stash rows and the WIP row ignore
double-click. Guard: a double-click must not leave a two-commit selection behind (the first click
selected; the second click with no modifier re-selects the same commit, so nothing to do, but assert
it in the test). Pills inside the row keep their own handler (stopPropagation there).
e2e (`interaction.spec.ts`): double-click a row with a branch → HEAD moves, Undo returns; double-click
a bare commit → detached HEAD banner; double-click HEAD's row → nothing.

### 1d. Topological order

- Setting `commitOrder: choice('date', [date, topo])` in the Graph section, description: "Date: newest
  first, branches interleaved by time (GitKraken, Tower). Topological: each branch's commits kept
  together; dates run out of order."
- `LogStream` takes `order: 'date' | 'topo'` and passes `--date-order` or `--topo-order`
  (`--topo-order` also implies no parent before child; the layout needs nothing else). Plumb it
  through `Repo` (the log key must include it so a change restarts the stream) and the snapshot.
- Menu: View → Commit order; palette entries. The layout is unchanged. Bench: add a `topo` run to
  `tools/bench` and record first-page latency in ADR-003 with and without a commit-graph file:
  without one, `--topo-order` must walk all of history before printing the first commit; with
  generation numbers (git ≥ 2.21 and a commit-graph, which GitGoose writes in the background) git
  walks topologically in increments and the first page should arrive almost as fast as in date order.
- Tests: `log.test.ts` asserts the flag; `repo.test.ts` asserts the order of a fixture with two
  interleaved branches differs between the two modes; `layout.test.ts` runs the invariants on topo
  input too (it should already, since the fixtures are permuted).

The interesting idea for Jesse: a plain `git log` is a heap pop on commit date (git can print as it
goes), while `--topo-order` needs to know no unprinted commit is a child of the next one, which
without extra information means walking everything first. Generation numbers in the commit-graph
file give git that information cheaply.

*Corrected after measuring (phase 1):* `--date-order` is not the plain heap pop. In git it is a
topological sort with date tie-breaks, so it pays the same full walk as `--topo-order` without a
commit-graph (614 ms vs 566 ms for the first page of 100k commits) and the same few milliseconds
with one (9.9 ms vs 8.1 ms). Topological mode therefore costs nothing extra; the commit-graph
matters equally in both. Details in ADR-003.

---

## Phase 2: a branch on top of another goes straight up

### The problem, precisely

The layout holds lane 0 for the trunk and seeds HEAD's lane at the top (ADR-003). A branch whose
tip arrives *before* the commit those lanes wait for cannot use them, so it takes the next free
column and curves into the trunk or HEAD lane when they meet. With `topic` three commits on top of
`main`:

```
 today            wanted
 │ ╭─● Z          ● Z   topic
 │ │ ● Y          ● Y
 │ │ ● X          ● X
 ●─╯   B main     ● B   main
 ●     A          ● A
```

Tower draws the right-hand picture because it has no reserved lanes. We keep the reservations
(ADR-003's reasons stand: checkouts must not reshuffle the graph) and add one exception.

### Design

1. **Git tells us which tips are "straight over" a reserved line.** In `Repo.snapshot()`, with the
   trunk tip T and HEAD H known, compute for every branch ref whose hash ≠ T, H:
   `git for-each-ref --format='%(refname)%00%(objectname)%00%(ahead-behind:T)%00%(ahead-behind:H)'`
   (git ≥ 2.41; on older git skip the feature). A ref with `behind = 0` relative to T (or H) is a
   candidate. For each candidate, verify the first-parent chain actually lands on T:
   `git rev-list --first-parent -n <ahead+1> <tip>`, last hash must equal T. Candidates are few
   (branches you have not merged yet) and each check is bounded, so this is cheap. The result goes
   into the snapshot as `graph.straight: { overTrunk: string[]; overHead: string[] }` (tip hashes;
   a tip can be in both when HEAD is a trunk tip).
2. **The layout honours it** (`packages/graph`, `LayoutOptions.straight`):
   - A tip (no lane waiting for it) whose hash is in `overTrunk` arrives while lane 0 is still held:
     it takes lane 0 and the hold ends. Its first-parent chain now leads to T, which lands in lane 0
     as before. A second such tip later finds lane 0 taken and behaves as today (curves in at T).
   - A tip in `overHead` arrives while the pending HEAD lane (dashed WIP line) is still pending: the
     tip takes that column and the pending marker moves one column right (first free), with a
     `pass` edge from the old column to the new one on this row, `pending: true`. Below, the dashed
     line runs beside the branch and curves into H as it does today. When there are no uncommitted
     changes the pending edges are not drawn and the branch reads as a straight line.
   - When HEAD is a trunk tip, both rules apply to the same tip: lane 0 for the branch, the pending
     marker steps to lane 1.
3. **Why not infer it in the layout?** It streams: when Z arrives nobody knows whether its chain
   reaches B. A bounded retro-fix (rename lane k→0 on the rows since the tip when B arrives with one
   incoming lane and lane 0 still held) is possible and worth describing in the ADR amendment as
   the alternative, but it edits rows already on screen and spans pages. One extra `for-each-ref`
   field is simpler and deterministic.

### Files

`packages/graph/src/layout.ts` (+ tests: fixtures "branch on top of trunk", "branch on top of HEAD
with WIP", "two branches on top of trunk", "merge in the chain is not straight"), `packages/git/src/repo.ts`
(`straightTips()`, `trunkRefs` neighbour), `packages/shared/src/index.ts` (snapshot field),
`lib/store.ts` (passes it to `GraphLayout`), `GraphCell`/`edges.ts` (a diagonal `pass` edge for
the pending shift: check `edgePath` draws it), ADR-003 amendment, spec 001. e2e in `graph.spec.ts`
with the multiselect fixture (`main: A-B`, `topic: X-Y-Z` on B): the topic rows and B share
`data-lane`. Bench must hold.

### As built (where reality refined the plan)

- **HEAD itself on top of the trunk.** With `topic` checked out on top of `main`, Z is HEAD: a lane
  (HEAD's) already waits for it, so it is not a tip and rule A does not apply. The layout treats
  HEAD in `overTrunk` like a trunk tip: HEAD's lane is lane 0 from the top. `straightTips` checks
  every branch ref including HEAD's, so this needs no extra command.
- **First-parent check.** The base must be *among* the first `ahead + 1` first-parent commits, not
  necessarily the last. That is the same answer for a branch without merges, and also accepts a
  branch that merged another feature branch (its `ahead` counts the merged commits too) while
  still rejecting one that merged main.
- **Which trunk tip.** With main and origin/main at different commits, the base is the one that
  contains the other (one `%(ahead-behind)` atom per trunk tip in the same `for-each-ref`). If they
  have diverged there is no trunk line and `overTrunk` is empty.
- **Cost.** It runs only when refs, HEAD or the trunk change (it is a function of them, so it is in
  the refs key by construction), checks at most 64 candidates, and any failure gives empty lists.
- **e2e fixture.** The multiselect fixture branches topic from A, not B, so `graph.spec.ts` builds
  `main: A-B`, `topic: X-Y-Z` on B itself. The WIP case ("the dashed line runs beside topic and
  joins B") needs HEAD = B, so it runs with main checked out; with topic checked out the WIP line
  joins Z straight down lane 0, and that is the other e2e case.
- A detached HEAD that no branch points at is not itself classified against the trunk; the layout
  still draws it correctly (rule A gives a branch above it lane 0 and HEAD's dashed line joins it).

### Exercise for Jesse (docs/learn/07-straight-lanes.md)

Delete the two rules in `GraphLayout.next()` and rebuild them from the tests. Question to answer in
the write-up: why does the trunk rule need the *first-parent* check while the pending-lane rule
would still draw correctly without it?

---

## Phase 3: line view (hold Shift to hide non-sequential commits)

### Behaviour

With a commit (or a range) selected, press and hold Shift for 150 ms without clicking: the graph
collapses to the *line of history through the cursor commit*: its first-parent ancestors down the
loaded log, and up the log the chain of commits that inherit its lane (the child whose first parent
is the current commit and whose row lane equals it; the layout only moves a line at a fork, so this is
"the same branch seen from above"). Everything else is hidden. The cursor row stays at the same
screen position (adjust `scrollTop` when collapsing and expanding), so a Shift-click that follows
lands where the user aimed. Release Shift: everything comes back. A bar over the graph reads
"Showing the line through abc1234 · N commits hidden · release Shift to show all". Shift-click and
Shift+arrows keep their meaning inside the view (they already select along the lane, spec 007).
Alt is not involved; Ctrl/Cmd-click still toggles.

Also pinnable: View → "Line view" (Ctrl/Cmd+L; Shift+L is Fetch, see As built) keeps it on until toggled, for people who
want Tower's "show only this branch" feel; Esc releases it.

### Design

- `lib/lineView.ts` (pure, unit-tested): `lineThrough(log, hash): Uint32Array` of row indexes,
  walking parents via `log.index` and children via a lazily built first-parent child map kept in
  `LogData` (`firstChildren: Map<hash, hash[]>`, extended per page like `index`).
- `GraphList` gets `visible: Uint32Array | null`; the virtualizer counts `visible.length` and maps
  item → row through it. `GraphCell` for a collapsed view draws a single straight line in the
  commit's colour (edges replaced by one `pass` in its lane; nodes keep their lane x so the line
  stays where it was). No relayout, no new arrays per frame.
- Pages that load while collapsed extend the line (the ancestor walk continues as `index` grows).
- Keyboard handling in `GraphList.onKeyDown`/`onKeyUp` plus a window `blur` listener (a held Shift
  lost to another window must not leave the view collapsed).

### Tests

Unit: line through a commit on a merge-heavy fixture (criss-cross, octopus) picks exactly the
first-parent chain; the upward walk stops at a fork it did not come from. e2e (`lineview.spec.ts`):
with the multiselect fixture, select Y, hold Shift → rows A, X, Y, Z remain and B is hidden; release →
all rows; the selected row's `getBoundingClientRect().top` is unchanged across both transitions.

The interesting idea: a "branch" is not a git object, it is a path in the DAG; first-parent is how
git itself defines the path (`--first-parent`, `rebase`, `log` ordering), and the layout's
lane-inheritance rule is the same definition drawn.

### As built (where reality refined the plan)

- **Shortcut.** Mod+Shift+L has been Fetch since the first keymap, so Line View is **Mod+L**
  (rebindable in Settings like every command). Taking Fetch's key would have silently changed a
  shortcut people already use.
- **Edges.** One straight `pass` per row leaves a gap wherever the line changes lane (topic's X in
  lane 1, its parent A in lane 0). Rows draw a `top` edge from the line's row above (curving in
  when that lane differs, as the full graph does) and a straight `bottom` edge when the commit has
  a parent, so the line is continuous and ends cleanly at the top and bottom. HEAD's dashed
  pending edges are kept so the uncommitted-changes row still joins HEAD.
- **Keeping the row still.** Scrolling alone cannot keep the cursor row in place when the line has
  fewer rows above it than the screen shows (the e2e case: A is row 5 of all, row 2 of its line).
  The list adds space above the line (`paddingStart`) and a minimum height below for as long as
  it is collapsed. For the same reason the bar floats over the bottom of the graph instead of
  taking a row above it: inserting a bar would push every row down by its height.
- **Growing with pages.** `lineThrough` runs again per page (O(line length), once per page, never
  per frame) rather than keeping a walk cursor; the walk up never changes with new pages (children
  come before parents), so the result is the old line plus rows at the bottom, which the tests
  assert. Near the end of the line the list keeps loading pages until the next first parent
  arrives.
- **The line is frozen** at the commit Shift was first held on: a Shift-click inside the view moves
  the selection's cursor but must not re-walk the line under the pointer.
- **The test file** `lineView.test.ts` runs real git, so it is type-checked by `tsconfig.node.json`
  (the renderer's config has browser types only).

---

## Phase 4: Tower's sidebar and drag-and-drop

Source: Tower's help guides and release notes (git-tower.com/help, /release-notes). Where Tower's
docs are silent the choice is marked *(ours)*.

### 4a. Sidebar

Sections, top to bottom (collapsible, state remembered per repository in internal settings):

| section | items | notes |
|---|---|---|
| **Workspace** | Working Copy (⌘/Ctrl+1), History (⌘2), Stashes (⌘3, count badge), Pull Requests (⌘4, only with a GitHub remote), Reflog (⌘5) | Working Copy selects the WIP row and the changes panel; History shows the whole graph and clears any branch selection; Stashes expands the list; Reflog opens the existing view |
| **Pinned** | pinned local branches, auto-expanded | pin / unpin from the menu or by dragging a branch here; stored in git config (`gitgoose.pin`, multi-valued, `--add` / `--unset`), so worktrees share it and it survives reclones of settings |
| **Branches** | local branches as a folder tree on `/` | folders collapse and remember it; the filter box flattens the tree while non-empty and restores it when cleared; HEAD in bold with a check mark; ⌘0 scrolls to and selects HEAD's branch |
| **Remotes** | one node per remote, each a folder tree of its branches | the node's menu: Fetch, Prune, Edit URL…, Rename…, Remove (all existing actions) |
| **Tags** | newest first, folderised | View ▸ Tags ▸ show newest 50 / 100 / 250 / all (large repos) |
| **Submodules**, **Worktrees**, **Git LFS** | as today | a branch checked out in another worktree keeps its badge |

Badges after the name, in this order and giving way before the name does (current behaviour):
`↑n ↓n` (tracking counts; tooltip with the upstream and when it was last fetched), `gone`, `merged`,
`stale`, `worktree`, `#PR`, `local only` (tags). The filter box moves to the **bottom** of the
sidebar, above a footer with **+** (Create branch…, Create tag…, Add remote…, Add submodule…, Add
worktree…) and a **gear** menu (Group refs in folders, Show merged badge, Show stale badge, Show
reflog, Show stash count; all per-repository settings, the first global).

Selecting a branch (single click) shows **that branch's history** in the graph (Tower's per-ref
history): it solos the ref through the existing graph filter, the "Viewing" bar says so, and
⌘/Ctrl-click adds a second branch to the shown set. *History* in Workspace, Esc in the sidebar, or
"Show all" returns to everything. *Reveal in History* on any ref's menu does what a click does today
(jump to the commit without filtering). A gear option "Click a branch: show its history / reveal its
commit" keeps the old behaviour for people who prefer it. Keyboard: ↑↓ move through the tree,
←→ collapse/expand, Enter checks out, Space selects (shows history), Delete asks to delete (undoable).

Context menus are the current ones, reordered as Tower orders them and completed: local branch
(Check out; Check out in new worktree…; Create branch from…; Merge into HEAD / Rebase HEAD onto —
Alt swaps the two; Pull…; Push; Force push with lease…; Publish… (no upstream); Track ▸; Fast-forward
(when only behind); Compare with HEAD; Pin; Reveal in History; Rename…; Delete…; Copy name);
remote branch (Track…; Check out; Create branch from…; Pull into HEAD; Merge / Rebase; Compare; Reveal;
Delete on remote…; Copy); tag (Check out; Publish…; Create branch from…; Reveal; Delete…); stash
(Apply; Pop; Branch from…; Drop); remote (Fetch; Prune; Edit URL…; Rename…; Remove).

### 4b. Drag-and-drop matrix

Tower's rule: **the target and the modifier decide; there is no chooser menu.** Tower opens the
operation's dialog on a plain drop and runs the alternative (rebase instead of merge, revert instead
of cherry-pick, fixup instead of squash) with Alt. GitGoose's rule is undo instead of dialogs, so a
plain drop runs straight away with an Undo toast, Alt picks the alternative, and only drops that change
a remote confirm (CLAUDE.md). While dragging, a badge follows the pointer saying exactly what will
happen ("Merge topic into main", "Rebase main onto topic" when Alt is held): Tower shows one too, and
it is what makes modifier-driven drops discoverable. The current `DropMenu` chooser goes away; its
options live on in context menus.

| source → target | drop | Alt | confirm |
|---|---|---|---|
| local branch → HEAD branch, Working Copy item, WIP row, or HEAD's row | Merge into HEAD | Rebase HEAD onto it | – |
| local branch → other local branch (sidebar or pill) *(ours)* | Check out target, merge source into it | Check out target, rebase it onto source | – |
| local branch → remote node | Push (Publish with tracking when no upstream) | Force push with lease | yes (remote) |
| local branch → remote branch | Push onto that remote branch | Force push with lease | yes |
| local branch → Branches header | Create branch from it… (name dialog) | – | – |
| local branch → Tags header | Create tag at its tip… | – | – |
| local branch → a folder in Branches | Rename into that folder (`branch -m`, undoable) | – | – |
| local branch → Pinned header | Pin | – | – |
| local branch → Worktrees header | Add worktree on it | – | – |
| local branch → Pull Requests item | Create pull request… | – | network, existing dialog |
| remote branch → Branches header | Create local tracking branch and check it out | create without checking out | – |
| remote branch → HEAD branch / Working Copy | Pull into HEAD (merge) | Pull with rebase | – |
| remote branch → other local branch | Set as its upstream (track) | – | – |
| commit(s) → Working Copy / HEAD branch / WIP row | Cherry-pick (oldest first, as now) | Revert | – |
| commit → Branches / Tags header | Create branch / tag at the commit… | – | – |
| commit(s) → between two commits on the editable part of HEAD | Move (reorder; existing) | – | – |
| commit(s) → onto a commit (editable) | Squash into it (existing) | Fixup (keep the target's message) | – |
| commit → other local branch *(ours)* | Cherry-pick onto it without checkout: `merge-tree --write-tree --merge-base C^ <branch> C`, then `commit-tree` and `update-ref` with the old value; refuse (toast) when merge-tree reports conflicts | – | – |
| tag → remote node | Push the tag | – | yes |
| stash → Working Copy / WIP row | Apply | Pop | – |
| a file in a stash or commit's file list → Working Copy / WIP row | Apply that file's change to the working tree (`apply --3way` of the path-limited diff; undoable) | – | – |
| working-copy file(s) → Stashes item | Stash only those files (existing partial stash) | – | – |

Everything not in the table is not a drop target (no cursor change, no highlight).

### Design

- `lib/dnd.ts` (pure, unit-tested): `dragPayload` types per MIME (`REF_MIME`, `COMMITS_MIME`, new
  `STASH_MIME`, `FILE_MIME` with `{ rev | 'worktree', path }`), and `dropPlan(snapshot, source,
  target, { alt }): DropPlan | null` returning `{ label, run, confirm? }`. The table above *is*
  the test matrix: one `it` per row, including rows that must return null.
- `components/DragBadge.tsx`: a fixed element positioned from a document-level `dragover` listener
  (`clientX/Y`, `altKey`), text from `dropPlan` for the target under the pointer (targets set
  `data-drop-target` so the badge knows without React state churn). Hidden when there is no plan.
- Sidebar targets: section headers, folder rows, ref rows, the remote node, Workspace items. Graph
  targets: rows (existing), pills (existing), WIP row (new).
- New Repo methods (each `exclusive()` + undo entry): `cherryPickOnto(branch, hashes)`
  (`cherry-pick` is HEAD-bound, so use `merge-tree --write-tree --merge-base C^ <branch> C`, git ≥ 2.40,
  then `commit-tree`; refuse when `merge-tree` reports conflicts; older git: toast "needs git 2.40"),
  `applyFileFrom(rev, path)`,
  `renameBranchInto`, `pin/unpin`. Spec 003 gets the full table; ADR-009 "Drag and drop: target and
  modifier, not a chooser" records the decision and why it differs from GitKraken's chooser.
- `lib/refTree.ts` (pure): names → tree, collapsed set, filter flattening. Virtualize the sidebar
  list with `@tanstack/react-virtual` (repos with thousands of branches and tags: cost follows the
  screen).

### Tests

Unit: `dnd.test.ts` matrix, `refTree.test.ts`, `repo.test.ts` for the new write methods (conflict
refusal, undo). e2e `sidebar.spec.ts` (sections, folder tree, filter flattening, pin via drag, click
= history, Reveal, keyboard), `dnd.spec.ts` (Playwright `dragTo` per row with and without Alt; the
badge text; the remote-changing drops show a confirm; Undo after each).

Exercise for Jesse (docs/learn/08-drop-matrix.md): write `dropPlan` yourself from the table; the
tests are the spec. Question: why does "cherry-pick onto a branch that is not checked out" need
`merge-tree`, and what would go wrong with a plain `cherry-pick` after a temporary checkout?

### As built (where reality refined the plan)

- **Workspace shortcuts are Mod+Alt+1…5**, not Mod+1…5: Mod+1…9 have always switched tabs, and
  Mod+0 is Actual Size. Taking them would have silently changed keys people use. Inside the
  sidebar Mod+0 still goes to HEAD's branch (Tower's key, scoped to where it means that), and
  Mod+Alt+0 does it from anywhere; all are rebindable. `comboOf` now reads digits by key code,
  so Alt+1 is "1" on a Mac (where it types "¡").
- **`dropPlan` returns the operation as data** (`{ label, op, confirm? }`), not a `run` closure.
  The tests then say exactly what each drop does without mocking the API, and `performDrop` in
  `lib/actions.ts` runs it with the existing actions. Same split as `dropOptions` had, minus the
  closure.
- **No React state per drag move.** One document-level controller (`DragBadge.tsx`) handles every
  drop target; targets only declare `data-drop-target`. The browser hides a drag's data until the
  drop, so the source is kept in a module variable from dragstart to dragend.
- **Rows without an Alt alternative** do the same with Alt as without (an Alt held by accident
  should not make a drop silently fail). The badge's second line shows the alternative only when
  there is one.
- **Alt-dropping HEAD's own commit reverts it.** Picking HEAD onto itself is refused, but the e2e
  found the same check blocked the revert; the revert is now allowed.
- **"Pull into HEAD" really pulls** (`pull <remote> <branch>`, a fetch): that is what the label
  says, and the user asked for it by dropping. Its Alt is `--rebase`.
- **`applyFileFrom` tries a plain `git apply` first** and only falls back to `--3way`: `--3way`
  implies `--index` and refuses any file with unstaged edits, which is exactly the file a user is
  likely to drop a change onto. When --3way runs, the paths' index entries are saved for undo too
  (new undo action `index-entries`).
- **Pins follow renames** (a new undo action `config-value` adds or removes one value of the
  multi-valued `gitgoose.pin`), so "rename into folder" does not silently unpin.
- **Delete in the sidebar** runs the delete with Undo, and git's "not fully merged" question
  still appears; there is no extra "are you sure" (house rule: undo instead of confirmation).
- **Click a branch = show its history** persists through the graph filter (it is the existing
  filter), so it survives a restart like a solo from the menu does. The first click of a
  double-click has already soloed the branch, so the double-click puts the filter back before it
  checks out.
- **Both Merge and Rebase stay in the branch menu** instead of "Alt swaps the two": both are
  visible, which a context menu needs more than a hidden variant (Alt is the drag modifier).
- **Tags default to the newest 250** in the sidebar (View ▸ Tags), with an "N older tags · Show
  all" row; the filter box always searches every tag.
- **Profile** (`pnpm bench`, layer 4): the 3,000-commit dev repository plus 2,000 generated
  branches (in 25 folders) and tags, every section open: ~2,100 rows, 39 in the DOM, 58 fps
  scrolling against a 60 fps idle ceiling, first sidebar rows 1.2 s after launch.

---

## Phase 5: conversational AI, tool calls on screen, and GitHub Copilot

### 5a. Threads over long-lived sessions

Spec 006 made every request a fresh session on purpose: independence and no stale diffs. That rule
stays *between* threads and changes *within* one: a **thread** owns one ACP session for as long as
its view is open (plus a 10-minute idle grace), and every AI feature produces a thread.

- **Main** (`ai/acp.ts`): `openSession(cwd) → sessionId`, `prompt(sessionId, blocks, hooks,
  signal)`, `closeSession(sessionId)`, `loadSession` when the agent advertises `loadSession` (else a
  restart replays the transcript as text, as Ask does today). `session/update` handling grows from
  text-only to: `agent_message_chunk`, `agent_thought_chunk`, `tool_call` / `tool_call_update`
  (title, kind, status, `rawInput`, locations, content incl. diffs), `plan`, `current_mode_update`,
  `available_commands_update`. Permissions are per thread (remember "allow for this session" per
  session id). `AiService` keeps `threads: Map<threadId, {sessionId, cwd, …}>`.
- **IPC** (`api.ts` + `API_METHODS` + handlers): `aiThreadOpen(repoId, anchor) → AiThread`,
  `aiThreadSend(threadId, text, attachments?) → requestId`, `aiThreadCancel(threadId)`,
  `aiThreadClose(threadId)`, `aiThreads(repoId)` / `aiThreadDelete`. One event, `ai-update
  { threadId, requestId, update: AiUpdate }` where `AiUpdate` is a discriminated union (`text`,
  `thought`, `tool`, `plan`, `permission`, `done`, `error`). `aiRun` stays for one-shot callers
  (push checks, commit message) and is reimplemented as open → send → close.
- **Shared types** (`packages/shared/src/ai.ts`): `AiThread { id, repoId, anchor: ThreadAnchor,
  turns: AiTurn[], createdAt, head }`, `ThreadAnchor` = `{kind:'review', scope} | {kind:'explain',
  hash} | {kind:'recompose', hashes} | {kind:'walkthrough', scope} | {kind:'impact', scope} |
  {kind:'ask', rev, path, lines} | {kind:'changestack', …} | {kind:'free'}`, `AiTurn { role,
  blocks: AiBlock[] }`, `AiBlock` = text (markdown) | thought | tool call | permission | artifact.
  `AskThread` migrates into this (one-time settings migration, test it).
- **Artifacts in chat.** Features that produce structured results keep producing them: the system
  prompt for each anchor says "when you revise the <findings | plan | diagram | commit message | walkthrough>,
  send the whole thing again in one fenced block tagged ```json:findings (etc.); otherwise answer in
  prose". The renderer parses tagged blocks, runs the *same verifier* as the one-shot path
  (`verifyFindings`, `repairPlan`, `verifyWalkthrough`, `fromSpec` for diagrams), and shows an
  artifact card with **Apply** (findings merge into the Review view marked "from chat"; a plan
  replaces the recompose editor's state as one undo step; a commit message replaces the draft,
  undoable; a diagram renders inline). Nothing silently changes behind the user.
- **Renderer**: `components/Thread.tsx` (turn list, composer with Shift+Enter newline, Stop, retry;
  tool-call cards with status, `rawInput`, and diffs; permission cards inline with Deny / Allow
  once / Allow for this session; thought blocks collapsed), used by: Review view (right rail), Explain
  box (grows into a thread: "Ask a follow-up"), Recompose dialog (a chat column beside the plan: "Put
  the tests in their own commit"), Walkthrough and Impact views, the Ask panel (becomes a Thread with
  an ask anchor), and a free-standing **AI** panel (⌘/Ctrl+Shift+A) for questions about the repository
  with no anchor. Markdown: a small in-house renderer for the subset we need (paragraphs, lists,
  headings, emphasis, inline code, links, fenced code through the existing shiki highlighter);
  unit-tested, no HTML passthrough. (A markdown dependency is an "ask Jesse first" item; the subset
  renderer avoids both the question and the sanitiser.)
- **Anthropic API mode**: multi-turn `messages`, `max_tokens` raised to 8192 (configurable),
  still no tools, so tool cards never appear there.
- **Secrets**: the secret scan runs on every outgoing turn (not only the first).
- **Fake agent** (`e2e/fake-agent.mjs`): keeps per-session history, replies "turn N" so tests can
  prove continuity, emits `agent_thought_chunk`, a `tool_call` with a diff and a `plan`, honours
  `session/cancel`, optionally advertises `loadSession`.

**As built (5a), where reality refined the plan:**

- The reducer lives in `packages/shared/src/thread.ts` and runs on both sides: main folds the
  same `ai-update` events into the copy it saves, so the renderer's copy cannot drift from it.
- `AiUpdate` gained three kinds: `turn` (a user message went in; the agent's turn starts),
  `permission-answered`, and `meta` (mode and slash commands). `ThreadAnchor` gained `task` for
  one-shot requests (commit message, push checks, conflict help), which are never saved.
- IPC as planned, plus: `aiThreadOpen(repoId, anchor, resume?)` reopens a saved thread;
  `aiThreadDelete(repoId, threadId)` (like `deleteAskThread`); `aiThreadPermission` answers a
  card; `aiThreadArtifact` checks an artifact in main (the verifiers need what the feature saw,
  which lives in main); `openExternal` opens Markdown links (http, https, mailto only).
  `askThreads` / `saveAskThread` / `deleteAskThread` stay, as views of the ask-anchored threads.
- One-shot requests still ask permission in the modal (their views show no thread); thread
  turns ask inline. "Allow for this session" is remembered by GitGoose per session for the same
  tool kind, title and input, also when the agent offers no `allow_always` option.
- `aiThreadSend` resolves only once the turn has started: setup, consent, login, the secret scan
  and opening or loading the session all refuse before anything is in the thread.
- The Markdown subset is `lib/markdown.ts` (pure, unit-tested) plus `components/Markdown.tsx`,
  not one `lib/markdown.tsx`: renderer tests cannot import modules that touch `window`.
- `json:diagram` artifacts are the walkthrough's sequence diagram (checked by `verifySequence`)
  until phase 6 brings dsviz and `fromSpec`. `json:commit-message` is offered by the AI panel.
- Spec 007 had no Ask section; it has one now, pointing to spec 006.
- The chat rails in Review, Walkthrough and Impact open from a **Chat** button: at the default
  window size a permanent 320 px rail would leave the findings too narrow.

### 5b. GitHub Copilot as an agent

Copilot CLI speaks ACP natively since 0.0.397 (`copilot --acp`, stdio NDJSON; docs:
docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server). The ACP registry lists it as
`npx @github/copilot@<version> --acp`.

- Preset `copilot` in `AGENT_PRESETS` and the `aiAgent` choice (fix the duplication: derive the
  choice options from `AGENT_PRESETS`): label "GitHub Copilot CLI", command `copilot --acp` when
  `copilot` is on PATH (resolve `copilot.cmd` on Windows; spawn already uses `shell` there), else
  `npx -y @github/copilot@<pinned> --acp`. Pin the version in one constant with a comment on why
  (the CLI self-updates; a pinned npx is reproducible).
- **Auth**: Copilot advertises `authenticate`; the terminal method is `copilot login`
  (`--device-code` / `--web-flow`). The existing login dialog (spec 006) handles both. GitGoose's own
  GitHub token is **never** passed to the agent (ask-before rule on credentials; the plan does not
  change that). Env overrides: a per-agent `env` text setting (KEY=VALUE lines) mirroring Zed's
  `agent_servers.{command,args,env}`; documented for `COPILOT_MODEL`, never pre-filled with tokens.
- **Permissions**: Copilot's permission requests put the real command in `toolCall.rawInput`
  while `title` is prose (copilot-cli issue #4335): the permission card shows `rawInput` when present.
  Never pass `--allow-all-tools`/`--yolo` by default; a GitGoose permission card answers each ask.
- **Model**: `--model` flag / `COPILOT_MODEL`; a per-preset "model" text setting that becomes
  `--model` for Copilot and Gemini, and is ignored by presets without a flag.
- Tests: unit on `agentCommandLine('copilot')` on both platforms; e2e with the fake agent renamed
  "Copilot" in `initialize` proving the login path and the `rawInput` display. No test talks to the
  real CLI (no network in CI).

The interesting idea: ACP's `session/update` is a stream of typed events, and a thread is just a
reducer over it. Once the reducer exists, every feature is "an anchor plus a first message", which is
why the one-shot features collapse into special cases rather than staying separate code paths.

---

## Phase 6: dsviz in GitGoose, a skill, and the extensions GitGoose needs

dsviz lives in `/home/user/DiagramBuilder` and is published to npm as `dsviz` (2.1.0, ESM, per-file
build, zero runtime deps in the core, React optional). GitGoose takes it as a dependency (the brief
asks for it; still, the prompt tells Opus to say so in the PR text).

### 6a. In DiagramBuilder: the skill and the extensions (publish as 2.2.0, additive)

**The skill** `.claude/skills/dsviz/SKILL.md` (+ `references/api.md`, `references/spec.md`,
`references/recipes.md`), following the skill-creator conventions: when to use it (any diagram in a
React app or any SVG export), the three ways to draw (a family function, a `Scene` by hand, a JSON
`DiagramSpec`), the theme contract (`--dv-*`, `.dark`, `injectStyles`), the rules (layouts never
style; ids stable across frames so tweens work; estimate text, never measure), the family cheat-sheet
with signatures, and recipes: sequence from a call trace, architecture with zones, a DAG with the
layered layout, a git graph, a before/after array. Kept under 500 lines; the references hold the
long tables. The same folder is copied into GitGoose (`.claude/skills/dsviz/`) so GitGoose agents
load it; the copy is a build step (`pnpm sync:skill`), not a fork.

**Extensions** (each with tests in `tests/`, a demo in `site/demos`, an entry in the guide):

1. `spec.ts`: `DiagramSpec` (discriminated on `type`: `sequence | class | state | architecture |
   graph | git | array | table | code`), `validateSpec(x): { ok, errors[] }` with precise messages
   (hand-written, no deps), `fromSpec(spec, opts): Scene`, `describeSpec(spec): string` (alt text:
   "Sequence diagram, 3 participants, 5 messages: …"). This is what a model emits and what GitGoose
   verifies, in the same spirit as `verifyFindings`.
2. `layout/layered.ts`: a Sugiyama-lite DAG layout (longest-path layering, barycenter ordering, a
   few sweeps, straight or elbow connectors) used by `ds.graph` (`layout: 'layered' | 'circle'`),
   `sys.architecture` and `uml.classDiagram` when a node has no `x/y`. Deterministic for a given
   input order (tests assert exact positions on small graphs and invariants on random DAGs: no
   overlaps, edges point downward or rightward).
3. `layout/tidy.ts`: Reingold–Tilford for n-ary trees (`ds.tree`), closing the listed gap;
   `binaryTree` can opt in.
4. `ds.graph`: rect nodes sized to their label (`shape: 'rect' | 'circle'`), node `kind` →
   `role: 'node-<kind>'` so stylesheets can colour "changed / upstream / downstream / test" nodes.
5. `git.graph(commits, refs, opts)`: a commit graph family (lanes by the same first-parent rule as
   GitGoose's layout, nodes, curved edges, branch and tag labels, tones per lane; a `highlight` set).
   Used for "what this rebase does" pictures and for the Change Stack overview.
6. `uml.sequence`: notes, `alt` else-dividers, per-message `tone`, `activate: false`.
7. `code.block(lines, { highlight, language? })`: a monospace block with line numbers and
   highlighted ranges, for pointing at lines in an explanation.
8. Renderer: text crossfade on label change (listed gap); `<Diagram injectStyles>`; controls stop
   re-injecting their stylesheet on every render; `toSVG` gets `theme: 'light' | 'dark'`.

### 6b. In GitGoose

- `components/DiagramView.tsx`: wraps `<Diagram>`, maps `--dv-surface/fg/muted/font/mono` onto
  GitGoose tokens, sets `.dark` from the theme, offers Copy as SVG / Save as SVG and PNG (via
  `toSVG` and a canvas), and renders `describeSpec` as the `aria-label`.
- Replace `lib/sequence.ts` + the walkthrough's SVG with `fromSpec({type:'sequence'})`; the model's
  walkthrough answer carries `diagrams: DiagramSpec[]` validated by `validateSpec` (invalid ones are
  listed under "dropped", like findings).
- Chat (phase 5) renders ```json:diagram blocks as diagram artifacts; the Explain prompt may ask
  for one diagram when the commit changes a flow.
- Impact view: the blast-radius picture (changed definition → uses → tests) with `ds.graph` layered.
- `docs/learn/09-layered-layout.md`: exercise: implement `layout/layered.ts` from its tests.

---

## Phase 7: Change Stack

What CodeRabbit's Change Stack is (confirmed from coderabbit.ai/change-stack, the launch post and
docs.coderabbit.ai/change-stack): not a stacked-PR tool but a **review workspace** that re-organises
a change into AI-generated *cohorts* (related work grouped by intent) and ordered *layers* anchored to
line ranges, each with a summary, optional diagram and findings; an Overview with intent, risk,
dependencies, architecture impact, behaviour, uncertainties and merge readiness; a three-panel layout
(left rail: Overview / Layer / Blast Radius / Architecture Impact + Layers or Files tree; centre: the
layer-scoped diff with Files / Diagrams tabs; right: Summaries / Comments or Chat); active summary
sync; keyboard J/K/L/H/Z/[/]/U/C; mark files viewed; a pending review submitted to GitHub; snapshots
with out-of-date warnings; Code Peek; semantic diff grouping. GitGoose already has review findings,
walkthrough, reading order, impact, Code Peek, ask-about-lines and GitHub sign-in: Change Stack is
the view that puts them in CodeRabbit's shape and adds cohorts, layers, readiness and the review
draft.

### Scope

A **change** is what Review already accepts: uncommitted, staged, a commit, a run of commits, or a
branch since its fork point (a PR, when the branch has one). Opened from the Review button's menu
("Open Change Stack"), a branch's menu, a PR's menu, and ⌘/Ctrl+Shift+R.

| CodeRabbit | GitGoose |
|---|---|
| Overview: intent, risk, dependencies, architecture impact, behaviour, uncertainties | the same six, from one AI call over the diff + commit messages + code context, each item citing hunk ids; "Needs author context" when the model marks it uncertain |
| Change cohorts → ordered layers → line-range anchors, per-layer summary | `layers[] { id, title, intent, hunks: hunkId[], summary, risk: low/med/high, dependsOn: layerId[], diagram?: DiagramSpec }`; verified: every hunk id exists, every hunk appears exactly once (leftovers into "Other changes"), no cycles |
| Diagrams (sequence, state, ER) | dsviz specs (phase 6): sequence, state, architecture, git |
| Blast Radius | the Impact view's data drawn as a layered graph (changed / upstream / downstream / tests), "Open in layer" from a node |
| Architecture Impact | a before/after architecture diagram when the model can produce one from the code context; otherwise the layer dependency graph |
| Needs your attention: Blockers / High priority / Pending / Advisory | review findings bucketed by severity and profile; "Pending" = findings not yet looked at |
| Merge readiness: Ready / Caution / Risky / Blocked, with confidence | computed locally from findings, linters, secret scan, conflicts with the base and pre-push checks; the AI's risk only adjusts the confidence |
| Active summary sync | the right rail highlights the layer summary of the hunk in the centre of the diff |
| Keyboard J/K, L/H, Z, [ ], U, C, F/D, Esc, ⌘Enter | the same |
| Mark files viewed | per snapshot, stored per repository |
| Comments → pending review → Approve / Comment / Request changes | a local draft (range comments + chosen findings); on a GitHub PR, submit as a GitHub review through the existing sign-in (network: confirm, show exactly what is sent); otherwise copy as markdown |
| Snapshots, out-of-date warning | each run keyed by the change's head and base; the view warns when either moved, "Refresh" re-runs incrementally (phase 36 machinery); findings compared remaining / addressed |
| Chat | the phase 5 thread with a `changestack` anchor: it knows the layers and hunk ids and can revise layers (```json:layers artifact) |
| Code Peek, semantic grouping | existing Peek; hunks grouped by enclosing definition from the code graph (already computed for numbered diffs) |
| Share links, voice, timeline, Triage queue, cloud coding agent | left out (desktop app, no server) |

### Design

- `packages/shared/src/changestack.ts`: types above, `verifyStack(answer, hunks)`.
- `main/ai/prompts.ts`: `changeStack` prompt (reuses `numberedDiff`, intent, code context, the
  walkthrough's grouping rules) asking for one JSON object `{ overview, layers }`; `service.ts` →
  `toChangeStack` + verifier; cached per `(scopeKey, head, base, guidanceHash)` like reviews.
- `lib/changestack.ts` (renderer state: current layer, file, viewed set, draft comments, rails).
- `components/ChangeStackView.tsx` with `StackRail`, `LayerDiff` (reuses `DiffView` with a hunk
  subset and the gutter findings), `StackSummaries`, `StackComments`, `StackOverview`,
  `ReadinessBand`; `react-resizable-panels` for the rails (already a dependency).
- GitHub: `github/service.ts` gains `submitReview(owner, repo, number, { event, body, comments[] })`
  (REST `POST /repos/{owner}/{repo}/pulls/{n}/reviews`), with comments mapped to the PR's diff
  positions by `path` + `line` + `side`.
- Tests: `changestack.test.ts` (verifier: unknown hunk, duplicated hunk, cycle, leftovers),
  `github.test.ts` for the review payload, prompts snapshot; e2e `changestack.spec.ts` with the fake
  agent (rails, J/K, viewed marks, readiness from a seeded finding, draft → markdown; a GitHub
  submit against the existing fake GitHub server in `github.spec.ts`).

---

## Order and status

1 → 2 → 3 (graph) can run first, in a day each. 4 is the largest UI piece and independent of AI.
5a → 5b, then 6a (DiagramBuilder) → 6b, then 7, which needs 5 and 6.

- [x] 1a blue selection · [x] 1b no month headers · [x] 1c double-click checks out · [x] 1d topological order
- [x] 2 straight lanes
- [x] 3 line view
- [x] 4a sidebar · [x] 4b drag-and-drop matrix
- [x] 5a threads · [ ] 5b Copilot
- [ ] 6a dsviz skill + extensions (2.2.0) · [ ] 6b dsviz in GitGoose
- [ ] 7 Change Stack
