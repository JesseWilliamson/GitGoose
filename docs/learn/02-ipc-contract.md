# Exercise 2: the IPC contract

**Files:** `packages/shared/src/api.ts`, `apps/desktop/src/preload/index.ts`,
`apps/desktop/src/main/ipc.ts`
**Background:** ADR-002

## The idea

The renderer is a web page with no Node access (`contextIsolation`, `sandbox`). It can only call
what the preload script exposes on `window.gitgoose`. Instead of one hand-written channel per
call, there is one interface (`GitGooseApi`), one runtime list of names (`API_METHODS`), and one
channel. Three compile-time links keep them in sync:

1. `API_METHODS ... satisfies readonly ApiMethod[]`: no name that is not in the interface.
2. The `Missing` type below it: no interface method missing from the list.
3. `createHandlers(): GitGooseApi` in main: every method needs a handler with the right types.

## Read first

- Trace one call, `api.stagePaths(id, ['a.txt'])`, from a click in `DetailPanel.tsx` through
  preload, `registerIpc`, `Repo.stagePaths`, and back. Why does the result come back as
  `{ ok, value | error }` instead of throwing?
- Why does `registerIpc` run a write through `repos.during`, which holds the file watcher back
  and refreshes once afterwards, rather than relying on the watcher alone? What would the graph
  show during a rebase of five commits without it?

## Do it: add `remotes()`

Show each remote's URL as a tooltip on its section in the sidebar.

1. Add `remotes(repoId: string): Promise<{ name: string; fetchUrl: string; pushUrl: string }[]>`
   to `GitGooseApi`. Run `pnpm typecheck` and read the errors: they are your to-do list.
2. Implement `Repo.remotes()` with `git remote -v` … or better, a plumbing-style command. (Hint:
   `git config --get-regexp '^remote\..*\.url$'`. Why is that safer to parse?)
3. Write a test in `packages/git/src/repo.test.ts` using the `with-remote` fixture.
4. Use it in `Sidebar.tsx`.

## Questions

- What would an attacker who controls the renderer (say, via a malicious commit message rendered
  as HTML) be able to do through this API? Which methods are the most dangerous, and what stops
  them being worse?
- Electron's structured clone cannot send class instances. What did this force on the types?
