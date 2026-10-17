# 003: Branches, history operations and remotes

**Status:** shipped

## Behaviour

- Double-click a branch (pill or sidebar) to check it out. Remote branches check out as a local
  tracking branch.
- Right-click a commit: create branch/tag here, check out detached, cherry-pick, revert, reset
  (soft/mixed/hard), copy SHA/message. Right-click a branch: checkout, merge into current, rebase
  current onto it, rename, delete, push, delete on remote.
- Drag a branch onto another (pill or sidebar item onto a pill or row). The menu offers what
  makes sense given which side is checked out: merge, fast-forward, rebase, reset, or check out
  then merge/rebase.
- Toolbar: Pull (merge/rebase), Push (normal / force-with-lease), Fetch (all, prune), Branch,
  Stash, Pop. Ahead/behind badges on Pull/Push.
- Credential prompts from git or ssh appear as a dialog (password fields masked).

## Git commands

`checkout [--track -b | --detach]`, `branch [-m | -d | -D]`, `merge --no-edit [--ff-only | --no-ff]`,
`rebase`, `reset --soft|--mixed|--hard|--keep`, `cherry-pick [-m 1]`, `revert --no-edit [-m 1]`,
`tag [-a -m]`, `fetch --progress [--prune] --all`, `pull --no-edit --rebase|--no-rebase`,
`push [-u remote branch] [--force-with-lease]`, `push remote --delete`.
GIT_ASKPASS / SSH_ASKPASS point at the askpass trampoline (packages/git/src/askpass.ts).

## Undo

All local operations are undoable (ADR-005). Changes to remotes are not: force push and remote
branch deletion ask for confirmation instead.

## Acceptance tests

`repo.test.ts` "branches", "remotes", "stash", "askpass"; `e2e/interaction.spec.ts`,
`e2e/workingtree.spec.ts` (push/pull, branches).
