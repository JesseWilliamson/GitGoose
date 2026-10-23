# PLAN-4 prompts

One prompt per phase of `docs/PLAN-4.md`, to paste into a fresh Opus session in the right checkout.
Run them in order (1 → 2 → 3 → 4 → 5a → 5b → 6b → 7 (6a is dropped)). Each prompt starts with the same
preamble; it is repeated so a prompt can be pasted on its own.

How to get a production-quality result out of each session:

- Paste the preamble and the phase prompt together. Do not paste several phases at once.
- Let the session finish its own checklist (typecheck, test, e2e, bench where named) before you
  review. Ask it to paste the test output into the PR description.
- Review the "what to learn" note it writes at the end; if you want to build a piece yourself, say
  so before it starts that piece (the prompts name the exercise candidates).
- When a session asks one of the "ask before" questions (dependency, credentials, IPC removal),
  answer it; those are deliberate stops.

---

## Preamble (paste before every phase prompt)

```
You are working in the GitGoose repository (an Electron git client). Read CLAUDE.md first, then
docs/PLAN.md §1–2, docs/adr/*.md, and the spec files named in the phase below. Follow docs/PLAN-4.md
for this phase: it contains the design decisions; do not relitigate them, but if reality disagrees
with the plan, update the plan file in the same PR and say so.

House rules (non-negotiable):
- The renderer never blocks. Git runs in main through GitRunner only, NUL-separated plumbing formats
  only (-z, %x00, --porcelain=v2), readOnly: true for reads. Cost is proportional to what is on
  screen: virtualize, stream, lazy-load, keep big arrays out of React state.
- Every Repo method that writes goes through exclusive() and records an undo entry when it can be
  undone (ADR-005). UI actions go through run() in lib/actions.ts: errors become toasts, undoable
  actions offer Undo, only remote-changing actions confirm.
- Adding an IPC method: GitGooseApi + API_METHODS in packages/shared/src/api.ts, handler in
  apps/desktop/src/main/ipc.ts, WRITES if it writes. Never remove or rename an IPC method without asking.
- Tests run real git against @gitgoose/fixtures; never mock git. No test talks to a real AI agent,
  API or GitHub; use e2e/fake-agent.mjs and the fake GitHub server.
- Styling: Tailwind v4 utilities over theme tokens (bg-panel, text-muted, border-line, bg-select,
  var(--lane-N)) defined in styles.css for dark and light.
- Ask before: adding a dependency, anything touching credentials or askpass, anything that rewrites
  history or force-pushes by default, removing or renaming IPC methods, network calls the user did
  not ask for. Stop and ask; do not work around.
- No model names or AI identifiers in commit messages, code comments, PR titles or bodies.

Definition of done for the phase: pnpm typecheck, pnpm test, and pnpm e2e (xvfb-run -a pnpm e2e on
Linux) all pass; pnpm bench --check passes when the log, layout, graph rendering or store changed;
every behaviour change has a test that would fail without it; the spec/ADR named in the phase is
updated; docs/PLAN-4.md's status checklist is ticked for what shipped.

Working style: work on a branch named claude/plan4-<phase>, commit in small steps with messages that
explain why (the reader is Jesse, who is learning the codebase), and finish with a short "what to
learn" note in the PR description: the one interesting idea in the change, the trade-off you made,
and what to read to understand it. If the phase names an exercise for Jesse, write the exercise file
in docs/learn/ with the routine from docs/learn/README.md, and keep the reference implementation
small and well-commented. Before pushing, re-read your own diff adversarially: what would make CI
reject it? Fix that first. Do not open a pull request unless asked; push the branch and report.
```

---

## Phase 1 prompt: graph polish

```
Phase 1 of docs/PLAN-4.md: four small independent changes to the commit graph. Read docs/specs/001-log-and-graph.md,
apps/desktop/src/renderer/src/components/Graph.tsx, GraphCell.tsx, lib/store.ts (selectCommit),
lib/actions.ts (checkout), packages/git/src/log.ts (LogStream.start), packages/shared/src/settings.ts
and the e2e specs graph.spec.ts, interaction.spec.ts, layout.spec.ts.

Do them as four commits:

1a. Selection tint is blue. In CommitRow the `row-tint` div paints color-mix(lane 22%, bg) when
    selected; make it the bg-select token instead (the WIP row, sidebar and palette already use it)
    in both layouts. Remove the lane colour from that path. e2e: select a row and assert the tint's
    computed background equals var(--gs-select) in dark and in light theme.

1b. Remove month headers entirely: useMonthStarts, HEADER_H, the month prop, the offset parameter of
    GraphCell, the header arithmetic in CommitRow (drop zones, tint top), the `headers` flag, and
    monthLabel/sameMonth if nothing else uses them. estimateSize becomes a constant. Update spec 001
    and the graphStyle setting description. Delete month-header assertions in e2e. Run pnpm bench
    --check and paste the numbers.

1c. Double-click on a commit row checks out. In CommitRow's rowProps add onDoubleClick: if exactly one
    local branch (not HEAD) points at the commit, checkout(repoId, ref.name); if several, open a
    small menu at the pointer listing "Check out <branch>" for each (reuse the DropMenu/DM pattern
    in menus.tsx, with a new store field, not the drop field); if none, checkout(repoId, hash)
    (detached, undoable). HEAD's own row, stash rows and the WIP row do nothing. Pills inside the row
    keep their own double-click (stop propagation there). Make sure the double-click's two clicks do
    not leave a range or toggle selection behind. e2e in interaction.spec.ts: three cases (branch →
    HEAD moves and Undo returns; bare commit → detached; HEAD row → nothing), plus the several-
    branches menu.

1d. Topological order. Add setting commitOrder: choice('date', [{date,'Date (newest first; branches
    interleaved by time)'}, {topo,'Topological (each branch kept together)'}]) in the Graph section
    with a description that says dates run out of order in topological mode. LogStream takes
    order: 'date' | 'topo' and passes --date-order or --topo-order; plumb through Repo so the log
    key includes it and a change restarts the stream and relayouts once (no flicker: the swap rule
    in store.ts already handles a new first page). View menu + command palette entries. Tests:
    log.test.ts asserts the argv; repo.test.ts shows a fixture with two interleaved branches orders
    differently in the two modes; layout.test.ts runs the invariants on topo-ordered input. Bench:
    add a topo run, measured with and without a commit-graph file, and record first-page latency in
    ADR-003 with a paragraph on why --date-order can print as it goes, why --topo-order cannot
    without generation numbers, and what the commit-graph file changes.

Finish with the DoD from the preamble; graph and log changed, so bench is required.
```

---

## Phase 2 prompt: a branch on top of another goes straight up

```
Phase 2 of docs/PLAN-4.md (read that section in full first; it has the diagram and the design).
Read docs/adr/003-graph-rendering.md, packages/graph/src/layout.ts and layout.test.ts,
packages/git/src/repo.ts (snapshot(), trunkRefs), packages/shared/src/index.ts (RepoSnapshot),
apps/desktop/src/renderer/src/lib/store.ts (where GraphLayout is constructed), lib/edges.ts,
components/GraphCell.tsx, docs/learn/01-lane-layout.md.

Build:
1. In main: Repo.straightTips(trunkTip, headHash) using one
   `git for-each-ref --format=%(refname)%00%(objectname)%00%(ahead-behind:<trunk>)%00%(ahead-behind:<head>)`
   over refs/heads and refs/remotes (git ≥ 2.41; detect the version once and skip the feature on
   older git, returning empty lists). Candidates have behind = 0 and ahead > 0. Verify each with
   `git rev-list --first-parent -n <ahead+1> <tip>`: the last hash must equal the base. Put the
   result on the snapshot as graph: { straight: { overTrunk: string[], overHead: string[] } } and
   include it in the refs key so a change relayouts. Unit tests in repo.test.ts on fixtures: a
   branch on top of main (yes), a branch that merged main (no: first-parent check fails), a branch
   behind main (no), several branches on top (all yes), HEAD detached, unborn HEAD.
2. In packages/graph: LayoutOptions.straight. Rule A: a tip (no lane waiting for it) in overTrunk
   arriving while lane 0 is held takes lane 0 and ends the hold. Rule B: a tip in overHead arriving
   while the pending HEAD lane is still pending takes that column; the pending marker moves to the
   first free column to the right, emitting on this row a `pass` edge from the old column to the new
   one with pending: true (check edgePath draws a diagonal pass correctly; add the case if not).
   When HEAD is a trunk tip both rules apply to the same tip. Tests (layout.test.ts): the four
   fixtures named in the plan, the existing invariants on all of them, paging equivalence (the same
   rows whether pushed in one page or many), and that colours stay per column.
3. In the renderer: pass snapshot.graph.straight into GraphLayout; GraphCell needs no change unless
   the diagonal pending edge needs one.
4. Docs: amend ADR-003 with a section "A branch on top of a reserved line continues it", including
   the rejected alternative (bounded retroactive lane renaming in the streaming layout) and why git
   hints won. Update spec 001. Write docs/learn/07-straight-lanes.md: delete the two rules and
   rebuild them from the tests; include the question from the plan.
5. e2e in graph.spec.ts with a fixture main: A-B, topic: X-Y-Z on B, topic checked out, no changes:
   the Z, Y, X and B nodes share the same lane (read data-lane or the circle's cx). With an
   uncommitted change the WIP dashed line runs beside topic and joins B.

DoD per the preamble; layout changed, so pnpm bench --check is required and the numbers go in the PR.
```

---

## Phase 3 prompt: line view (hold Shift)

```
Phase 3 of docs/PLAN-4.md (read it in full). Read lib/store.ts (LogData, selectCommit, the page
swap), components/Graph.tsx (GraphList, onKeyDown), components/GraphCell.tsx, lib/graphFilter.ts,
docs/specs/007-search-selection-recompose.md ("Several commits"), e2e/multiselect.spec.ts.

Build:
1. lib/lineView.ts (pure, unit-tested): lineThrough(log, hash): Uint32Array of row indexes, in graph
   order: walk first parents down through log.index while loaded; walk up through a first-parent
   child map (add LogData.firstChildren: Map<hash, hash[]>, extended per page exactly like index,
   never rebuilt) choosing, at each step, the child whose row lane equals the current row's lane
   (the layout's inheritance rule: the first-parent child in the same lane is the one that handed
   the lane down). Tests on the fixtures with criss-cross and octopus merges: exactly the
   first-parent chain; the upward walk stops at a fork it did not come from; new pages extend it.
2. GraphList: a `visible: Uint32Array | null` view. The virtualizer counts visible.length and maps
   item index → row index through it; no new arrays per frame, no relayout. While collapsed,
   GraphCell draws one straight `pass` edge in the row's own lane and colour (nodes keep their x).
   The WIP row shows only when HEAD is on the line.
3. Trigger: Shift held for 150 ms (keydown without keyup, no click) while a commit or range is
   selected collapses to the line through the selection cursor; keyup expands. Window blur expands
   (a Shift lost to another window must not stick). The cursor row keeps its screen y across both
   transitions (compute the new scrollTop from the row's offset before and after). Shift-click and
   Shift+arrows inside the view behave as today. A bar over the graph (next to FilterBar) says
   "Showing the line through <sha> · N commits hidden · release Shift to show all".
4. Pinned mode: View → Line view (Ctrl/Cmd+Shift+L) and a palette entry keep it on until toggled;
   Esc releases; the bar's text changes accordingly.
5. e2e lineview.spec.ts with the multiselect fixture (main: A-B, topic: X-Y-Z from A): select Y,
   page.keyboard.down('Shift'), wait, assert rows X, Y, Z, A visible and B absent, the selected row's
   bounding top unchanged; keyboard.up('Shift') restores all rows; Shift-click Z while collapsed
   selects Y..Z; the pinned mode via the menu.
6. Spec 007 gets a "Line view" section; add the question in the plan to docs/learn/01-lane-layout.md
   as a follow-up exercise.

DoD per the preamble; graph rendering and store changed, so bench is required.
```

---

## Phase 4 prompt: Tower's sidebar and drag-and-drop

```
Phase 4 of docs/PLAN-4.md. Read 4a and 4b in full: the sections table, the context menus and the
drop matrix are the specification. Read docs/specs/003-branches-and-remotes.md,
components/Sidebar.tsx, components/menus.tsx (GraphMenu, DropMenu, ref menus), lib/actions.ts
(dropOptions and every action it calls), lib/graphFilter.ts, components/Graph.tsx (REF_MIME,
COMMITS_MIME, RefPill, onDrop), packages/git/src/repo.ts (branch, merge, rebase, cherryPickMany,
stash*, remotes, worktrees), e2e/graph.spec.ts, interaction.spec.ts, remotes.spec.ts, stash.spec.ts.

Deliver in this order, one PR per step is fine:

Step 1, pure pieces with unit tests: lib/refTree.ts (names → folder tree on "/", collapsed set,
filter flattening); lib/dnd.ts with the payload types per MIME (REF_MIME, COMMITS_MIME, new
STASH_MIME, FILE_MIME { rev | 'worktree', path }) and dropPlan(snapshot, source, target, { alt })
→ { label, run, confirm? } | null. The matrix table in 4b is the test list: one case per row, with
and without Alt, plus the "not a target" rows returning null. Keep run() thin: it calls actions.

Step 2, Repo methods (exclusive + undo + tests in repo.test.ts): cherryPickOnto(branch, hashes)
using `git merge-tree --write-tree --merge-base <commit>^ <branch> <commit>` (git ≥ 2.40; refuse
with a clear error on conflicts or older git) then commit-tree and update-ref with the old value; applyFileFrom(rev | stash, path) applying
the path-limited diff to the working tree with apply --3way (undo restores the file); pin/unpin via
`git config --add/--unset gitgoose.pin <branch>` and reading `--get-all`; renameBranchInto(folder).

Step 3, the sidebar: sections Workspace (Working Copy ⌘1, History ⌘2, Stashes ⌘3 with count,
Pull Requests ⌘4 when a GitHub remote exists, Reflog ⌘5), Pinned, Branches (folder tree), Remotes
(folder tree per remote), Tags (newest first, View ▸ Tags ▸ newest 50/100/250/all), Submodules,
Worktrees, Git LFS. Filter box at the bottom; footer with + (Create branch…, Create tag…, Add
remote…, Add submodule…, Add worktree…) and a gear (Group refs in folders [global], Show merged
badge, Show stale badge, Show reflog, Show stash count, Click a branch: show its history / reveal
its commit [per repository]). Single click on a branch shows its history (solo through the existing
graph filter, "Viewing" bar explains, ⌘/Ctrl-click adds a branch); History / Esc / Show all return
to everything; Reveal in History jumps without filtering. Badge order ↑n ↓n, gone, merged, stale,
worktree, #PR, local only, with the tooltip on the tracking badge naming the upstream. Keyboard:
↑↓ move, ←→ fold, Enter checks out, Space shows history, Delete asks (undoable), ⌘0 selects HEAD's
branch and scrolls to it. Virtualize the list (@tanstack/react-virtual, already a dependency).
Context menus reordered and completed as listed in 4a. Keep data-testids stable where tests use them
(sidebar-ref, data-ref, ref-label, toggle-hidden, stash-item, remote-section, worktree-item,
submodule-item) and add new ones for sections, folders and Workspace items.

Step 4, drag and drop: remove the DropMenu chooser; wire dropPlan into every target in the matrix
(sidebar headers, folders, refs, remote nodes, Workspace items, graph rows, pills, the WIP row). Add
components/DragBadge.tsx: a fixed element following the pointer from a document-level dragover
listener (clientX/Y, altKey), showing dropPlan's label for the target under the pointer (targets
carry data-drop-target; no React state per move) and hidden when there is no plan. Plain drop runs
immediately with Undo; Alt picks the alternative; remote-changing drops confirm with the existing
dialogs. Drag sources: branches (sidebar and pills), tags (to remotes only), commits (existing),
stashes, files in stash/commit file lists and the changes list.

Step 5, docs and tests: spec 003 gets the sections table and the full matrix; write
docs/adr/009-drag-and-drop.md ("target and modifier decide; no chooser; why not GitKraken's menu;
the badge is the discoverability"); docs/learn/08-drop-matrix.md as the exercise (write dropPlan
from the tests; the merge-tree question from the plan). e2e sidebar.spec.ts and dnd.spec.ts as the
plan lists (Playwright dragTo with and without Alt via keyboard.down('Alt'); assert the badge text,
the result in git, the confirm on remote changes, and Undo after each local drop).

DoD per the preamble. The sidebar is on screen for every repository: profile it with the 3,000-commit
dev repo plus a fixture with 2,000 generated branches and tags, and keep scrolling at 60 fps.
```

---

## Phase 5a prompt: threads over long-lived ACP sessions

```
Phase 5a of docs/PLAN-4.md (read it in full). Read docs/specs/006-ai-over-acp.md, 007 (Ask), 008,
apps/desktop/src/main/ai/acp.ts, service.ts, prompts.ts, anthropic.ts, packages/shared/src/ai.ts,
packages/shared/src/api.ts, apps/desktop/src/main/ipc.ts, renderer lib/ai.ts, lib/ask.ts,
components/AskPanel.tsx, AiDialogs.tsx, ReviewView.tsx, WalkthroughView.tsx, ImpactView.tsx,
RecomposeDialog.tsx, DetailPanel.tsx (Explain), e2e/fake-agent.mjs and every e2e spec that uses it.
Also read the ACP docs for session/update, session/request_permission, session/load and
session/cancel (agentclientprotocol.com/protocol).

Design (fixed by the plan): a thread owns one ACP session while its view is open plus a 10-minute
idle grace; threads are independent of each other (that is spec 006's rule, now per thread).

Build:
1. Main: AcpAgent.openSession(cwd), prompt(sessionId, blocks, hooks, signal), closeSession,
   loadSession when advertised, else replay the transcript as text on restart. Handle
   agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update (title, kind, status,
   rawInput, locations, content including diffs), plan, current_mode_update,
   available_commands_update. Permissions per session ("allow for this session" remembered per
   session id). AiService.threads map; idle timer; close on repo close and on quit.
2. IPC: aiThreadOpen(repoId, anchor) → AiThread, aiThreadSend(threadId, text) → requestId,
   aiThreadCancel, aiThreadClose, aiThreads(repoId), aiThreadDelete; one event ai-update
   { threadId, requestId, update: AiUpdate } with a discriminated union (text, thought, tool, plan,
   permission, done, error). aiRun stays and is reimplemented as open → send → close. Threads
   persist per repository like askThreads do today; migrate AskThread into AiThread with a settings
   migration and a test.
3. Shared types in packages/shared/src/ai.ts exactly as the plan lists (AiThread, ThreadAnchor,
   AiTurn, AiBlock). Each anchor has a system preamble in prompts.ts that (a) gives the feature's
   existing context and (b) states the artifact protocol: when revising the findings / plan /
   diagram / commit message / walkthrough, send the whole thing in one fenced block tagged
   ```json:findings (json:plan, json:commit-message, json:walkthrough; a diagram is a ```mermaid block);
   otherwise prose.
4. Renderer: components/Thread.tsx (turn list; composer with Shift+Enter newline, Stop, retry;
   tool-call cards with status, rawInput and diffs; permission cards inline with Deny / Allow once /
   Allow for this session; thought blocks collapsed by default) and lib/markdown.tsx, a small
   in-house renderer for paragraphs, headings, lists, emphasis, inline code, links (opened
   externally) and fenced code through the existing shiki highlighter; unit-tested; no raw HTML.
   Artifact cards parse the tagged blocks, run the same verifiers as the one-shot path
   (verifyFindings, repairPlan, verifyWalkthrough, cleanCommitMessage) and offer Apply: findings
   merge into the Review view marked "from chat"; a plan replaces the recompose editor's state as
   one undo step; a commit message replaces the draft (undoable); walkthrough sections update in
   place. Use Thread in: Review (right rail), Explain (the box grows a composer: "Ask a follow-up"),
   Recompose (a chat column beside the plan), Walkthrough, Impact, Ask (AskPanel becomes a Thread with
   the ask anchor; keep its testids), and a free-standing AI panel (⌘/Ctrl+Shift+A, anchor 'free')
   whose first message gets only the repository name and HEAD.
5. Anthropic API mode: multi-turn messages, max_tokens 8192 (setting), no tools. The secret scan runs
   on every outgoing turn, not only the first.
6. fake-agent.mjs: per-session history and replies that say "turn N" so continuity is provable;
   emits an agent_thought_chunk, a tool_call with a diff and a plan when the prompt contains
   "FAKE:tools"; honours session/cancel; advertises loadSession when FAKE_AGENT_LOAD=1 and answers
   session/load by replaying. e2e thread.spec.ts: follow-up continuity, tool card and permission
   card, artifact apply for findings and for the recompose plan (undo), cancel mid-turn, agent crash
   mid-thread → restart and replay, the free AI panel; keep every existing AI e2e green.
7. Spec 006: replace "A fresh session per request" with the thread rule and add the artifact
   protocol and the update union; spec 007's Ask section points to it. Write the "what to learn"
   note around the reducer idea from the plan.

Do not add a markdown or sanitiser dependency; if you believe one is needed, stop and ask with the
reason. DoD per the preamble.
```

---

## Phase 5b prompt: GitHub Copilot as an agent

```
Phase 5b of docs/PLAN-4.md (read it, including the Copilot facts and sources). Requires 5a merged.
Read packages/shared/src/ai.ts (AGENT_PRESETS, agentCommandLine, agentLabel), settings.ts (aiAgent,
aiAgentCommand, anthropicModel), main/ai/acp.ts (spawn, toInfo, authenticate), service.ts
(onSettings, consent key), components/AiPanel.tsx, SettingsPage.tsx, e2e/ai.spec.ts (login test),
and the Copilot CLI ACP reference at
docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server plus copilot-cli issue #4335.

Build:
1. Preset 'copilot' ("GitHub Copilot CLI"). Derive the aiAgent choice options from AGENT_PRESETS so
   the two lists cannot drift (keep the setting values stable). Command: `copilot --acp` when
   `copilot` resolves on PATH (on Windows resolve copilot.cmd / the winget .exe to a full path; spawn
   already uses shell there), else `npx -y @github/copilot@<PINNED> --acp` with the pin in one
   constant and a comment on why. Show the resolved command line in Settings under the preset.
2. Per-agent extras: a `model` text setting that becomes --model for Copilot and Gemini and is
   ignored by presets without a flag; an `env` setting (KEY=VALUE per line) applied to the agent's
   process and mirrored on Zed's agent_servers {command,args,env}. GitGoose's GitHub token is never
   put there and never passed to any agent; say so in the setting's description. Changing model or
   env restarts the agent like a command change does. Do not pass --allow-all-tools or --yolo.
3. Permission cards show rawInput (command / commands / path) when present, above the title, because
   Copilot's title is prose. Make the card's testid carry data-has-raw-input.
4. Auth: confirm the existing login flow works when the agent's auth methods include a terminal
   method `copilot login` and an agent method; the dialog's copy command must be the preset's own
   executable plus the method's args. If Copilot returns -32000 with a different payload shape than
   the fake agent, adapt toInfo and add the shape to the fake agent.
5. Tests: unit on agentCommandLine/agentLabel for copilot on linux, darwin and win32 (mock PATH
   resolution); settings validation of env lines (reject lines without "=", trim, ignore blanks);
   e2e with the fake agent reporting name "GitHub Copilot" and a tool_call with rawInput.command
   proving the card shows it; Settings shows the resolved command. Spec 006's agent table gains the
   row; the AI provider description in settings.ts is updated (it still says "Commit messages,
   explanations and conflict help").

DoD per the preamble. Anything that would hand a credential to the agent is an ask-first stop.
```

---

## Phase 6a prompt: not applicable

```
Dropped. 6a was the dsviz skill and extensions, run in the DiagramBuilder checkout. GitGoose uses
Mermaid instead (see docs/PLAN-4.md Phase 6), so there is nothing to build in DiagramBuilder and
no skill to copy. Go straight to 6b.
```

---

## Phase 6b prompt: Mermaid in GitGoose

```
Phase 6b of docs/PLAN-4.md. Read lib/sequence.ts and sequence.test.ts, components/WalkthroughView.tsx
(the SVG), ImpactView.tsx, lib/impact.ts, main/ai/prompts.ts (walkthrough), packages/shared/src/ai.ts
(SequenceDiagram, WalkthroughResult), packages/shared/src/thread.ts (splitArtifacts), styles.css
(tokens, dark and light), and the Thread component from 5a.

Jesse decided on Mermaid: the model writes a fenced ```mermaid block (sequence, state,
flowchart/architecture, gitGraph, ER, class diagrams, as Mermaid supports them). Adding the
`mermaid` package was asked for; still state it in the PR description with the version and the
bundle size change of the renderer.

Build:
1. lib/mermaid.ts: validateMermaid(src): Promise<{ ok: true } | { ok: false; message }> using
   mermaid.parse; it never throws, the parser's message is the error. Parsing needs a DOM, so the
   test runs under happy-dom (a valid and an invalid diagram). renderMermaid(src) with mermaid.render,
   a fresh id per render, securityLevel 'strict', startOnLoad false, theme 'base' with themeVariables
   built from the --gs-* and --lane-N tokens. Load mermaid with a dynamic import so the graph's
   first paint does not pay for it (measure with the bench's first-paint number).
2. components/MermaidDiagram.tsx: draws the source, draws again when the source or the app theme
   changes, shows the parser's message in place when the source is invalid.
3. Walkthrough: the model returns "diagram": null | a Mermaid string; the main process keeps it
   if it is a non-empty string of sane size (verifyMermaid); the view draws it with MermaidDiagram,
   so an invalid diagram shows its parse error there. Delete lib/sequence.ts and the SVG component
   once the e2e passes with the new path; replace SequenceDiagram in shared.
4. Thread artifacts: ```mermaid blocks become diagram artifacts; the card parses them with
   validateMermaid (an invalid one is a problem card with the message) and draws them with
   MermaidDiagram. The artifact protocol asks for a ```mermaid block of the right kind with one
   short example; the Explain preamble may ask for one diagram when a commit changes a flow; the
   free AI panel can draw on request. ```json:diagram is no longer a format.
5. Impact view: a blast-radius picture as a Mermaid flowchart: changed definitions, their uses
   outside the change, tests; classes for changed / upstream / downstream / test nodes; click a
   node to jump to its file as the list does today.
6. Tests: validateMermaid (valid and invalid), verifyMermaid, splitArtifacts for ```mermaid; e2e
   walkthrough.spec.ts and impact.spec.ts updated (the fake agent returns a Mermaid diagram), ai.spec.ts
   for a chat diagram artifact; bench first paint unchanged.
7. Spec 006 mentions diagrams in chat: keep it in step. There is no dsviz skill and no layered-layout
   exercise any more.

DoD per the preamble, bench included.
```

---

## Phase 7 prompt: Change Stack

```
Phase 7 of docs/PLAN-4.md (read the whole section: the CodeRabbit → GitGoose table is the scope).
Requires 5a, 5b and 6b merged. Read ReviewView.tsx, lib/review.ts, WalkthroughView.tsx,
lib/walkthrough.ts, ImpactView.tsx, lib/impact.ts, DiffView.tsx (hunk rendering, gutter findings,
Code Peek), main/ai/prompts.ts (review, walkthrough, reading order), service.ts (toReview,
toWalkthrough, the incremental cache), packages/git/src/review.ts (numberedDiff, verifyFindings),
main/github/service.ts and github.test.ts (the fake GitHub server), docs/PLAN-3.md Part B, and
CodeRabbit's docs for the UI you are mirroring (docs.coderabbit.ai/change-stack and its
navigation, reading-diffs, findings, reviewing, chat and snapshots pages).

Build, in this order:
1. packages/shared/src/changestack.ts: types (ChangeStack { overview: { intent, risk, dependencies,
   architecture, behaviour, uncertainties }, layers: Layer[] }, Layer { id, title, intent,
   hunks: string[], summary, risk, dependsOn, diagram?: string }, Readiness { band: ready |
   caution | risky | blocked, confidence, reasons[] }) and verifyStack(answer, hunks): every hunk id
   exists, each hunk in exactly one layer (leftovers → "Other changes"), no dependency cycles,
   overview items cite only known hunk ids, diagrams parse with mermaid.parse. Tests for each rule.
2. Prompt + service: changeStack(scope) reusing numberedDiff, intent and code context, asking for
   one JSON object; toChangeStack + verifier; cached per (scope key, head, base, guidance hash) like
   reviews; a Refresh that re-sends only changed hunks and keeps layers whose hunks are unchanged.
3. Readiness computed locally (findings by severity and profile, linter and secret findings,
   conflicts with the base via merge-tree, pre-push check results when they exist); the model's
   risk only moves the confidence. Unit tests.
4. The view (center kind 'changestack', opened from Review's menu "Open Change Stack", a branch's
   menu, a PR's menu and ⌘/Ctrl+Shift+R): left rail with Overview / Layers / Files / Blast radius /
   Architecture impact and the Layers or Files tree (file and finding counts per layer); centre with
   the layer-scoped diff (DiffView with a hunk subset, gutter findings, Code Peek) and Files /
   Diagrams tabs; right rail with Summaries / Comments or Chat (the 5a Thread with a changestack
   anchor that can revise layers through a ```json:layers artifact). Active summary sync highlights
   the summary of the hunk nearest the centre. Overview page: the six items, the readiness band with
   reasons, "Needs your attention" buckets Blockers / High priority / Pending / Advisory from
   findings, snapshot line ("Reviewed at <sha> against <base>"; a warning when either moved, with
   Refresh). Mark files viewed per snapshot (stored per repository). Keyboard: J/K layers, L/H
   files, Z focus mode, [ and ] rails, U unified/split, C comment on the focused hunk, F/D tabs, Esc,
   ⌘Enter submits the composer. Rails with react-resizable-panels, widths remembered.
5. Comments and review submission: range comments from the gutter (click-drag or Shift-click) and
   chosen findings accumulate in a local draft; "Submit review" offers Approve / Comment / Request
   changes; on a GitHub PR it posts through github/service.submitReview (REST
   POST /repos/{owner}/{repo}/pulls/{n}/reviews, comments mapped by path + line + side) after a
   confirm that shows exactly what will be sent; without a PR, "Copy as markdown". Never post
   without the confirm.
6. Blast radius: the Impact data as a layered ds.graph with CodeRabbit's node kinds (changed,
   upstream, downstream, test, supporting), "Open in layer" on a node; Architecture impact: a
   before/after architecture diagram when the model returned one, else the layer dependency graph.
7. Tests: changestack.test.ts (verifier and readiness), github.test.ts (review payload and the fake
   server's response), prompt snapshot; e2e changestack.spec.ts with the fake agent (rails, J/K,
   viewed marks persist across reopen, readiness from a seeded finding, draft → markdown, snapshot
   warning after a new commit, chat revising a layer); a GitHub submit test against the fake GitHub
   server. Spec 009-change-stack.md written from TEMPLATE.md; PLAN-4 status ticked.

Left out on purpose (say so in the spec): share links, voice input, timeline, Triage queue, cloud
coding agent. DoD per the preamble; DiffView changed, so run the bench.
```
