# GitGoose — plan

An Electron git client that keeps the best of GitKraken (the commit graph, drag-and-drop branch
operations) and Tower (speed, undo, hunk/line staging, a conflict wizard, keyboard-driven quick
actions), and fixes GitKraken's two big problems: it is slow, and it gets in your way.

This document is the plan for building it with AI agents doing most of the typing while Jesse
owns the design and learns the interesting parts.

---

## 1. Why GitKraken is slow, and what we do differently

Electron is not the problem. VS Code is Electron and is fast. GitKraken is slow because of
how it talks to git and how it renders:

| GitKraken | GitGoose |
|---|---|
| libgit2 via nodegit (native module, loads whole repo structures into memory) | Shell out to the `git` binary with stable plumbing formats, stream and parse incrementally |
| Renders the whole graph into the DOM, re-renders on every state change | Virtualized rows: only visible commits exist in the DOM; graph column drawn per row |
| Lots of chrome: accounts, nags, GitHub integrations loaded at startup | Zero network at startup. Open repo → graph on screen in under a second |
| Modal-heavy UX, every action is a dialog | Inline actions, keyboard-first, undo instead of confirm dialogs |

The two performance rules that every piece of code must follow:

1. **The renderer never blocks.** All git work happens in the main process (or a utility
   process). Results stream to the UI over typed IPC.
2. **Cost is proportional to what is on screen, not to repo size.** Virtualize lists, page the
   log, lazy-load diffs, cache parsed results.

---

## 2. Architecture

### 2.1 Process model (Electron)

```
┌──────────────────── main process (Node) ───────────────────┐
│  GitService: spawn git, parse output, watch .git + worktree │
│  RepoStore: current snapshot (refs, HEAD, status, log pages) │
│  Credential broker: askpass trampoline → asks renderer       │
└───────────────▲────────────────────────────┬───────────────┘
                │ typed IPC (contextBridge)   │ events (status changed, log page ready)
┌───────────────┴────────────────────────────▼───────────────┐
│  renderer (React): graph, panes, diff viewer, command palette│
│  state in Zustand; UI is a pure function of the snapshot     │
└─────────────────────────────────────────────────────────────┘
```

- `contextIsolation: true`, `nodeIntegration: false`. The preload script exposes a small typed
  API (`window.gitgoose.repo.openRepo(path)`, `...log.page(cursor)`, etc.). Nothing else.
- If git work ever makes the main process lag (window moves stutter), move `GitService` into
  an Electron `utilityProcess`. Design the service as a plain class with no Electron imports so
  this move is a one-file change.

### 2.2 Git backend: the `git` CLI, not libgit2

Shell out, like Tower, Fork, GitHub Desktop and VS Code do. Reasons:

- The user's git handles everything: credential helpers, SSH agent, hooks, LFS, worktrees,
  sparse checkout, signing. libgit2 reimplements each of these and lags behind.
- No native module ABI pain with Electron upgrades.
- Plumbing output formats are stable contracts: `--porcelain=v2 -z`, `--format` with `%x00`
  separators, `cat-file --batch`.

Rules for the command layer (`packages/git`):

- Always pass `-c core.quotepath=false -c color.ui=never`, `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`.
- Parse `-z` / NUL-separated output only. Never parse human-readable output.
- Long-running helpers stay open: one `git cat-file --batch` process per repo for blob reads.
- Every command has a parser with unit tests against real output captured from fixture repos.

Key commands:

| Need | Command |
|---|---|
| Log for the graph | `git log --date-order --all --format='%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%x1e' -n 2000 [--skip]` (stream stdout, parse per record) |
| Refs / decorations | `git for-each-ref --format='%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track)' ` |
| Working tree | `git status --porcelain=v2 -z --branch --untracked-files=all` |
| Diffs | `git diff [--cached] --no-color -U3 -z -- <path>`; `--numstat -z` for summaries |
| Stage a hunk/lines | Build a patch from the hunk and `git apply --cached --unidiff-zero` (there is no "stage lines" command; every client constructs a patch) |
| File contents | persistent `git cat-file --batch` |
| Undo | `git reflog` + `reset`/`update-ref`; record a journal of operations with their pre-state |

### 2.3 Credentials

`GIT_ASKPASS` and `SSH_ASKPASS` point at a tiny bundled script that sends the prompt back to
the app over a local socket; the app shows a dialog and replies. This is the GitHub Desktop
(dugite) approach. Phase it: in M2 rely on the user's existing credential helper / ssh-agent;
add the trampoline in M3.

### 2.4 Watching for changes

`@parcel/watcher` on the worktree and on `.git/{HEAD,index,packed-refs,refs/,logs/}`. Debounce
100 ms. On change: re-run `status` and `for-each-ref`; only re-run `log` if refs changed. While
one of our own writes runs, the watcher is held back and one refresh follows the write: a rebase
is many ref moves, and the renderer should see only where it ends. When the log is re-run, the
rows on screen stay until the new first page is in, then swap in one render.

### 2.5 The commit graph (the thing we are keeping from GitKraken)

Split into two pure pieces so they can be built and tested without Electron:

1. **Layout** (`packages/graph`): input is commits in topo order (each with parent hashes);
   output is, per row, `{ lane, color, edges: [{fromLane, toLane, kind}] }`.
   Algorithm (gitk / GitUp family): keep an array of active lanes, each waiting for a hash.
   For each commit: it lands in the first lane waiting for it (or a new lane). Other lanes
   waiting for it end there (merge curves). Its first parent inherits the lane; extra parents
   get new lanes unless a lane already waits for them. Reserve lane 0 for the current branch
   and main, like GitKraken. O(rows × lanes), incremental: a new page appends without
   relayout because lanes are state carried forward.
2. **Rendering**: a virtualized list (`@tanstack/virtual`). Each visible row renders a small
   SVG for its graph cell plus HTML for message, author, refs. Start with SVG per row
   (simple, inspectable in devtools). Move the graph column to a single Canvas only if
   profiling shows SVG is the bottleneck. Measure first.

Performance target from day one: a 100k-commit repo opens in under 1 s to first paint and
scrolls at 60 fps. Keep a benchmark script that opens a large fixture and records both numbers.

### 2.6 UI stack

- Electron + `electron-vite` (Vite for main, preload and renderer), TypeScript strict.
- React 19, Zustand for state, Tailwind v4 + shadcn/ui (same controls Jesse uses in getbetter).
- `@tanstack/virtual` for every long list (log, file lists, diff hunks).
- Diff viewer: custom read-only hunk view first (needed anyway for hunk/line staging), with
  Shiki for lazy syntax highlighting. CodeMirror 6 `@codemirror/merge` later for editing in
  the conflict wizard.
- `cmdk` command palette (Tower's Quick Actions, Cmd+Shift+A).
- Tests: vitest for parsers and layout; Playwright (Electron mode) for end-to-end smoke tests.
- Packaging: electron-builder; auto-update later via GitHub releases.

### 2.7 Repo layout (pnpm workspace)

```
apps/desktop/          electron app: src/main, src/preload, src/renderer
packages/git/          GitService, command runners, parsers. Node only, no Electron imports.
packages/graph/        pure layout algorithm. No dependencies at all.
packages/shared/       types shared across IPC (Commit, Ref, StatusEntry, Hunk, ...)
tools/fixtures/        scripts that generate deterministic test repos
tools/bench/           opens a big repo, records first-paint and scroll fps
docs/adr/              architecture decision records (one file per decision)
docs/specs/            one spec per feature slice; agents read and update these
CLAUDE.md              the brief every agent session starts from
```

The separation matters for agents: three agents can work in `git`, `graph` and `desktop` at
the same time because they only share `packages/shared` types, written in Phase 0.

---

## 3. Milestones

Each milestone has acceptance criteria you can check by hand.

**M0 Foundation** (one session, Jesse watching closely)
- Workspace scaffolded, CI runs typecheck + vitest + Playwright smoke on macOS/Windows/Linux.
- `packages/shared` types. ADR-001 (git CLI), ADR-002 (process model), ADR-003 (graph rendering).
- Fixture generator: linear history, merges, octopus merge, orphan branch, tags, stash, conflicts.
- App opens a repo and shows a virtualized commit list (no graph yet) with refs decorations.
- Benchmark script exists and prints numbers.

**M1 The graph**
- Lane layout with tests on every fixture shape. Jesse writes the algorithm; an agent reviews.
- Graph column rendered per row. Paged loading as you scroll. Current branch in lane 0.
- Acceptance: 100k commits, < 1 s to first paint, smooth scroll.

**M2 Working tree and commits**
- Status pane (staged / unstaged / untracked), file diff viewer, stage / unstage file, hunk,
  and selected lines. Commit with message editor, amend. Live refresh via the watcher.
- Checkout branch, create / rename / delete branch, fetch / pull / push using the user's
  existing credential setup.

**M3 GitKraken-style interaction**
- Drag a branch onto another: menu offers merge / rebase / reset. Right-click commit menus:
  cherry-pick, revert, reset, create branch/tag here, copy sha.
- Stash list, apply / pop / drop. Askpass trampoline for credential prompts.

**M4 Tower-style power features**
- Undo (operation journal + reflog) for commit, merge, rebase, reset, checkout, stash.
- Conflict wizard: list conflicts, pick ours / theirs / edit, mark resolved, continue.
- File history, blame, search commits (message, author, path, sha).
- Command palette with every action; full keyboard navigation.

**M5 Ship**
- Packaging and signing for all three OSes, auto-update, crash reporting (local only),
  settings (git path, theme, fonts), multi-repo tabs. Perf pass on the benchmark.

Out of scope until after M5: GitHub / GitLab integrations, PR views, issue tracking, teams.
Those are exactly the things that make GitKraken feel heavy.

---

## 4. Building it with AI agents

### 4.1 The repo is the agents' memory

Every agent session starts cold. Everything it needs to know must be in the repo:

- `CLAUDE.md`: architecture summary, the two performance rules, conventions, "definition of
  done", a list of things agents must ask about rather than decide (credentials, anything
  that writes to `.git`, new dependencies).
- `docs/adr/`: why each big decision was made, so an agent does not relitigate it or
  silently replace the git CLI with isomorphic-git.
- `docs/specs/NNN-feature.md`: for each feature slice: user-facing behaviour, the git
  commands involved, edge cases, acceptance tests. Written or approved by Jesse before any
  code. The agent updates the spec when reality disagrees with it.

### 4.2 The loop for every feature slice

```
Jesse writes/approves spec  →  Implementer agent builds in a worktree branch, with tests
                            →  Reviewer agent (fresh context, given the diff only) reviews
                            →  CI: typecheck, vitest, Playwright
                            →  Jesse reads the diff with a "teach me this diff" walkthrough
                            →  merge
```

One slice = one branch = one PR = roughly one agent session. Slices should be small enough
to review in 20 minutes. If a spec produces a 2,000-line PR, split the spec.

### 4.3 Agent roles (prompts, not products)

- **Implementer**: reads CLAUDE.md, the ADRs and the spec; builds with tests against fixture
  repos; never mocks git. Runs the fast checks before pushing.
- **Reviewer**: gets the diff and the spec, not the implementer's reasoning. Looks for
  blocking the renderer, parsing human-readable git output, untested parsers, Windows path
  bugs.
- **Researcher**: reads other clients' source (GitHub Desktop / dugite for askpass, VS Code's
  git extension for command patterns, gitk for the layout) and writes a short note into
  `docs/research/` before a hard slice.
- **Tester**: writes Playwright scenarios from the spec's acceptance list, and adds fixture
  shapes when a bug reveals a missing one.
- **Bench**: a scheduled task that runs `tools/bench` nightly on main and reports regressions.

### 4.4 Parallelism

Phase 0 is sequential: one agent, Jesse watching every file, because it sets the conventions
all later agents copy. After M0, run streams in parallel in separate worktrees:

- Stream A: `packages/git` commands and parsers (agent).
- Stream B: `packages/graph` layout (Jesse, with an agent as reviewer and test writer).
- Stream C: `apps/desktop` shell, panes, theme, command palette skeleton (agent).

They meet at `packages/shared` types. Changes to shared types go through Jesse.

### 4.5 Guardrails that keep agents honest

- No mocking git. Tests run real git against generated fixture repos. An agent cannot make a
  parser test pass by faking output.
- Perf budget in CI: the bench script fails if first-paint or scroll regress beyond a threshold.
- Every parser test includes the raw captured output in the test file, so a reviewer can read
  the contract.
- `CLAUDE.md` "ask first" list: new dependencies, anything touching credentials, anything that
  rewrites history, changes to IPC surface.

### 4.6 What Jesse should build himself

To learn the most per hour, own these and let agents do the rest:

1. The lane layout algorithm (M1). It is 150 lines of pure logic and it is the heart of the app.
2. The IPC contract and preload API (M0). Understanding this is understanding Electron.
3. The hunk-to-patch builder for line staging (M2). Teaches the unified diff format properly.
4. The undo journal design (M4). Teaches the reflog and what git can and cannot undo.

For each, ask an agent for a spec and a test suite first, then implement until the tests pass,
then ask a reviewer agent to critique it.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Credentials and auth prompts (HTTPS tokens, SSH passphrases, 2FA) | Lean on the user's helpers first (M2); askpass trampoline in M3; copy dugite's proven design |
| Windows: paths, CRLF, Git for Windows quirks | CI on all three OSes from M0; fixtures include CRLF files |
| Large repos | Benchmark from M0; paging; persistent `cat-file --batch`; profile before optimizing |
| Scope creep toward GitKraken's feature list | Milestones are gated; integrations are explicitly post-M5 |
| Agents drifting from the architecture | ADRs + CLAUDE.md + reviewer agent with a checklist; small PRs |

---

## 6. First week

1. M0 session: scaffold, CLAUDE.md, ADRs, fixtures, CI, commit list, bench. Jesse reviews all.
2. Write `docs/specs/001-log-and-refs.md` and `002-graph-layout.md`.
3. Jesse starts the layout algorithm; an agent writes its tests from the fixture shapes.
4. Agent builds the log/refs commands in `packages/git` in parallel.
