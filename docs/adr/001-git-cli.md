# ADR-001: Run the git CLI, not libgit2

**Status:** accepted

## Decision

All git work shells out to the `git` binary through `GitRunner` (packages/git/src/runner.ts).
No libgit2, nodegit, or isomorphic-git.

## Why

- The user's git already handles credential helpers, SSH agents, hooks, LFS, worktrees, sparse
  checkout, signing and every config option. A reimplementation has to chase all of them.
- No native module to rebuild for every Electron upgrade.
- Plumbing formats are stable contracts: `status --porcelain=v2 -z`, `log --format` with
  `%x00` separators, `for-each-ref --format`, `cat-file --batch`.
- Tower, Fork, GitHub Desktop and VS Code all made the same choice.

## Rules that make it work

- Forced config on every call: `core.quotepath=false`, `color.ui=never`, `core.pager=cat`;
  environment `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`.
- Parse only NUL-separated machine output. Never parse text meant for humans.
- Read-only commands use `--no-optional-locks`, so a background refresh never blocks the user's
  own git in a terminal.
- Process start-up cost is real (a few ms). Where we would spawn many processes, keep one open:
  `LogStream` (one `git log` per history walk) and `CatFile` (one `cat-file --batch` per repo).

## Consequences

- Git must be installed. The setting `gitPath` lets users point at a specific binary.
- Line staging needs a patch builder (ADR-006), because git has no "stage these lines" command.
