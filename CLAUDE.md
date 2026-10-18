# GitGoose — brief for agent sessions

GitGoose is an Electron git client: GitKraken's commit graph and drag-and-drop, Tower's speed,
undo, line staging and conflict wizard. Read `docs/PLAN.md` for the why, `docs/adr/` for decisions
already made (do not relitigate them in passing), and `docs/specs/` for feature specs.

## Working with Jesse

Jesse wants to learn, not just receive code. Explain design decisions, point out the interesting
idea in each change, and leave room for him to implement parts himself when he asks. Plain, direct
explanations. `docs/learn/` holds exercises for the four pieces he plans to own.

## Layout

```
apps/desktop/          Electron app (electron-vite)
  src/main/            main process: window, IPC router (ipc.ts), RepoManager + file watcher, settings, menu,
                       avatars, github/ (device-flow sign-in; the only code that holds a token),
                       ai/ (ACP client for the user's agent, Anthropic API fallback),
                       codegraph.ts + indexer.ts (the code graph service and its utility process, ADR-008)
  src/preload/         the only bridge: builds window.gitgoose from API_METHODS
  src/renderer/src/    React UI: lib/store.ts (zustand + log data), lib/actions.ts (every user action), components/
  e2e/                 Playwright tests that launch the real app (+ fake-agent.mjs, a scripted ACP agent)
packages/shared/       IPC contract (api.ts), data types, pure conflict-marker parser
packages/git/          everything that runs git: runner, parsers, LogStream, CatFile, patch builder, undo, askpass, Repo,
                       CodeIndexer (builds the code graph per blob id)
packages/codegraph/    tree-sitter parsing (official WASM grammars + tags queries) and the SQLite graph store;
                       the package root is browser-safe, Node-only parts are under `@gitgoose/codegraph/node`
packages/graph/        lane layout. Pure, zero dependencies.
tools/fixtures/        deterministic test repositories (+ fast-import generator for big ones)
tools/bench/           performance benchmark with budgets
```

## The two performance rules

1. **The renderer never blocks.** All git work runs in the main process; results cross typed IPC.
2. **Cost is proportional to what is on screen, not to repo size.** Virtualize every list, stream
   the log (LogStream), lazy-load diffs and syntax grammars, keep big arrays out of React state.

`pnpm bench --check` enforces budgets (first log page, layout, app first paint, scroll fps). Run it
when touching the log, the layout, the graph rendering or the store.

## Conventions

- Git is run through `GitRunner` only. Parse NUL-separated plumbing output (`-z`, `%x00`,
  `--porcelain=v2`), never human-readable output. Read-only commands pass `readOnly: true`.
- Every `Repo` method that writes goes through `exclusive()` and records an undo entry when it
  can be undone (see ADR-005). New write operations need both.
- Adding an IPC method: add it to `GitGooseApi` and `API_METHODS` in `packages/shared/src/api.ts`
  (the compiler then demands a handler in `apps/desktop/src/main/ipc.ts`). If it writes, add it
  to `WRITES` in ipc.ts so the renderer gets a fresh snapshot right away.
- UI actions go through `run()` in `lib/actions.ts`: errors become toasts with git's stderr,
  undoable actions offer Undo instead of asking for confirmation. Confirm only what undo cannot
  reverse (anything that changes a remote).
- Styling: Tailwind v4 utilities over theme tokens (`bg-panel`, `text-muted`, `border-line`,
  lane colours `var(--lane-N)`), defined in `styles.css` for dark and light.
- Tests run real git against fixtures from `@gitgoose/fixtures`. Never mock git.

## Definition of done

`pnpm typecheck`, `pnpm test` and `pnpm e2e` (needs a display; `xvfb-run -a pnpm e2e` on Linux)
all pass, and the change has a test that would fail without it. Performance-sensitive changes
also pass `pnpm bench --check`.

## Ask before

- adding a dependency
- anything touching credentials or askpass
- anything that rewrites history or force-pushes by default
- changing the IPC surface in a way that removes or renames methods
- network calls the user did not ask for (there are none at startup, and that is deliberate)

## Commands

```
pnpm install          # also downloads the Electron binary (postinstall)
pnpm dev:repo         # build .fixtures/dev-repo: ~3,000 realistic commits, branches, remotes, conflicts, bulk stash
pnpm dev              # run the app with hot reload (opens the dev repo when it exists)
pnpm test             # vitest: parsers, git operations, layout
pnpm typecheck
pnpm e2e              # builds, then Playwright drives the real app
pnpm bench            # 100k-commit benchmark (add --check to enforce budgets)
pnpm dist             # package installers with electron-builder
```
