# Plan 3: closing the gap with GitKraken and Tower, then CodeRabbit-style AI

Jesse's brief: stashes in the graph; then everything GitKraken and Tower have that a git client
should have; then AI-native features inspired by CodeRabbit (explainability, code graph, code
review). The gap list and the CodeRabbit survey came from two research passes over the vendors'
own docs and GitGoose's code; their findings are summarised here, with what we build and how.

Rules that carry over: the renderer never blocks; cost follows what is on screen; every write
goes through `exclusive()` and records undo when it can; no network nobody asked for; AI sends
nothing without consent and every agent tool call needs permission.

## Part A: git client features

Grouped by area; each item names its git plumbing. "(GK)" GitKraken, "(T)" Tower.

**History editing** (builds on drop/move/drag, spec 007)
1. Reword any commit on the current branch; squash / fixup a commit into the one below; drag a
   commit onto another to squash (T). Interactive rebase with a generated todo (`reword` via
   `exec git commit --amend -F`, `fixup`, `squash`).
2. Fixup staged changes into an older commit (GK, T): `commit --fixup=X` then
   `rebase -i --autosquash X^` with the todo accepted as generated.
3. Squash merge, merge without committing, rebase --onto (GK, T).
4. Redo after Undo (GK): the undo journal keeps forward positions.

**Branches, tags and remotes**
5. Remotes: add, rename, remove, edit URL (GK, T).
6. Tags: push one / all, delete on the remote, show which are local only (GK, T).
7. Upstream: set / unset tracking, push to a named remote branch (GK, T).
8. Fast-forward a branch that is not checked out (GK): `update-ref` with the old value.
9. Branch cleanup (T): merged and stale badges, delete several (undoable).
10. Hide and solo branches in the graph (GK), per repository.

**Comparing and files**
11. Compare two commits, branch vs branch, a commit vs the working tree, a selection's combined
    diff (GK, T): a `range` diff target.
12. Split (side-by-side) diff and word-level highlighting (GK, T).
13. Restore a file to an old revision (undoable); open or save a file as of a commit (T, GK).
14. Image diffs (GK, T), lazy and size-capped.
15. External diff and merge tools (GK, T): `difftool` / `mergetool`.
16. Patches: save as files (`format-patch -o`), apply from a file or the clipboard
    (`am --3way` / `apply --3way --index`) (GK, T).

**Stashes**
17. Stashes in the graph (GK): each stash a node beside its base commit.
18. Partial stash (selected files, staged only, keep index), stash to a new branch, apply one
    file from a stash (T, GK).
19. Snapshots (T): `stash create` + `stash store`, the working tree untouched.

**Repositories**
20. Reflog view; restore a lost commit or deleted branch (T).
21. Worktrees: list, add, remove, prune, lock, open as a tab (GK, T).
22. Submodules: status, init/update, add, sync, remove, open as a tab (GK, T).
23. Git LFS when installed: detect, track, pull, lock (GK, T).
24. Identity per repository and globally; commit templates and co-author trailers (GK, T).
25. Signatures: show and verify (`%G?`), sign tags (GK, T).
26. Bisect from the graph: good / bad / skip, a banner while it runs.
27. Git command log: every command GitGoose ran, with duration and stderr (GK activity log).
28. Commit options: skip hooks, hook output on failure; file tree view and filter in change lists.

**Hosting** (network only when used; the GitHub sign-in already exists. It was removed on 2026-10-22, see spec 005)
29. GitHub pull requests: create from a branch, list for the repo, badge on branches, check out a
    PR (GK, T). PLAN.md deferred PR views until after M5; M5 is done, so this is now in scope,
    deliberately small (no review threads in the app).

Left out: Launchpad, cloud workspaces and patches, issue trackers, git-svn, stacked branches with
restack (Tower Pro; revisit), gitflow (rarely used now).

## Part B: CodeRabbit-inspired AI

CodeRabbit's quality comes from context (definitions, references, co-change history, guidelines,
learnings, linters) and from checking findings before showing them. We build the context
locally and deterministically in main, then let the model judge; we verify its output against
the input (no new paths, no lines outside the diff) before showing it.

**Code graph** (no AI; also useful on its own)
30. Symbol index: definitions by language-aware regexes, cached by blob id, references by
    `git grep -w`; Code Peek in the diff (definition and references of an identifier).
    `packages/codegraph`, pure, a good piece for Jesse to own.
31. Co-change map from history: "usually committed with X, which is not staged"; owners of the
    changed lines (`blame`, `shortlog`).
32. Impact view of a change: changed symbols, callers outside the diff, tests, co-changed files;
    "Assess impact" asks the model which callers are at risk (it may only cite call sites we sent).

**Review**
33. Review changes: staged, working tree, branch vs upstream, or selected commits. Findings
    `{path, startLine, endLine, type, severity, category, title, message, suggestion?}` shown in
    the diff gutter and a findings panel; profiles quiet / chill / assertive.
34. Apply a suggestion (checked, undoable) or Fix with AI (agent proposes the file; Use / Discard).
35. Review rules: guideline files (CLAUDE.md, AGENTS.md, .cursorrules, …) scoped by directory,
    path instructions (also read from `.coderabbit.yaml`), learnings saved from dismissals.
36. Incremental re-review: earlier findings marked addressed / open, only changed hunks re-sent.
37. Linters on changed files (approved once per command) and a built-in secret scan before any
    AI request.
38. Pre-push checks in plain language (pass / fail / indeterminate; warn or block).

**Explainability**
39. Walkthrough of a range or branch: summary, grouped files, review effort 1–5, related history,
    an optional sequence diagram drawn as our own SVG from JSON.
40. Reading order: hunks grouped into layers (contract, implementation, tests) with one-line
    summaries; low-complexity hunks folded.
41. Ask about a selection: the lines, their function, definitions of what they use, and their
    history (`blame -L`, `log -L`), answered in a thread pinned to that commit.

## Order

Stashes in the graph (17) first (asked for directly). Then Part A by value: 1–4, 11–13, 5–9,
20, 18, 16, 21–22, 10, 24–28, 14–15, 19, 23, 29. Then Part B: 30–31, 33–35, 39–41, 32, 36–38.

Each feature lands with unit tests against real git (fixtures) and an e2e test of its UI path;
`pnpm typecheck`, `pnpm test`, `pnpm e2e` green before every push, bench when the graph or log
changes.

## Status

- [x] 17 stashes in the graph
- [x] 1–4 reword, squash / fixup (menu and drag onto), fixup staged into an older commit,
      squash merge and merge without committing (prepared message in the commit box), redo
- [x] 11–13 compare (two commits, a commit vs HEAD or the working tree, branch vs HEAD, since
      the fork point, a chain's combined changes), split view, word-level highlighting,
      open / save / restore a file as of a revision (restore is undoable)
- [x] 5–9 remotes (add, rename, URL and push URL, remove; all undoable), tags (push one or all,
      delete on a remote, "local only" marks after an explicit check), tracking (track, stop,
      push to a named remote branch), fast-forward a branch that is not checked out, branch
      cleanup (merged and stale badges, delete several in one undoable step)
- [x] 20 reflog view (sidebar, palette, Repository menu): lost commits marked, restore as a
      branch under the name it had, check out, reset to an entry
- [x] 18 stash only some files, only the staged changes, or everything keeping the staged part;
      a branch from a stash (undo drops the applied changes only if they are untouched); take one
      file from a stash, untracked files included
- [x] 16 save commits as numbered .patch files; apply a patch from a file or the clipboard
      (mailbox patches become commits with am --3way, plain diffs are staged with apply --3way;
      both undoable; a stopped am is its own operation with continue / abort)
- [x] 21 worktrees: sidebar section, add on a new or existing branch (opens as a tab; undo
      removes it), remove (undoable when clean; changes need an explicit "delete"), lock,
      forget missing ones; branches checked out elsewhere are marked
- [x] 22 submodules: sidebar section with state (not cloned, moved, changes), clone / update,
      sync URLs, add (undo deletes it unless it changed since), remove (undo checks it out again
      from the clone git keeps), open as a tab
- [x] 10 hide and solo branches (eye button and menus; a whole remote can be hidden), a bar over
      the graph saying what is left out with Show all; remembered per repository
- [x] 24 identity (this repository or global, undoable; shown over the commit box), commit
      templates (comment lines become the placeholder), co-author trailers from recent authors
- [x] 28 skip hooks for one commit (a failing hook's output is in the attention bar); changed
      files as a tree (folders merge single-folder chains, stage / unstage / discard a folder) and
      a filter over every file list
- [x] 25 signature verification in commit details (only signed commits are verified; failures
      read "cannot be checked"), signed tags (Settings → Git)
- [x] 26 bisect from the graph: start from a commit's menu, a bar that says what to do next with
      Good / Bad / Skip / Stop, good / bad / first-bad marks on rows
- [x] 27 git command log (View menu, palette): every git process per repository with duration,
      exit code and stderr; reads hidden by default; credentials in URLs masked
- [x] 14 image diffs: side by side (sizes, dimensions), swipe, onion skin; loaded only when shown,
      capped at 25 MB per side
- [x] 15 external diff tool (diff header, file menus) and merge tool (conflict view) through git
      difftool / mergetool, so git's own tool configuration applies; Settings → Diff can name one
- [x] 19 snapshots: the working tree (untracked files included) saved as a stash entry without
      touching a file; undo drops the entry
- [x] 23 Git LFS when installed: a sidebar section (patterns, set-up warning, files to pull), track
      a file's type from its menu (undoable), pull, lock / unlock and a locks dialog (network,
      on request), LFS images shown in image diffs from the local store. Not tested against a
      lock server (none in CI); lock / unlock surface the server's error when it refuses.
- [x] 29 GitHub pull requests: a sidebar list loaded only when opened or refreshed (no-remote state says so;
      the signed-out state went with sign-in on 2026-10-22), #N badges on branches, check out any PR (pull/N/head, forks
      too, undoable), create one from a branch's menu (pushes first when GitHub lacks it)

Part A is complete.

Part B:

- [x] 30 symbol index (packages/codegraph: definitions by language patterns with scope ends,
      cached by blob id; uses by git grep -w) and Code Peek: Ctrl/Cmd+click a name in a diff.
      Exercise 6 in docs/learn
- [x] 31 hints from history above the commit box: a file that usually changes with yours but is
      missing (co-change over the last 300 commits per file, mass commits ignored), and whose
      lines you are changing (blame of each hunk's old side); Settings → Git can turn it off
- [x] 33 AI review of staged or uncommitted changes, a branch since it forked, or selected commits:
      a numbered diff with enclosing definitions goes out; JSON findings come back and are
      verified (file in the change, lines inside its hunks, known type and severity, no
      duplicates, profile quiet / chill / assertive) before the Review view and diff gutters show
      them; what verification drops is listed with the reason
- [x] 34 Apply suggestion (only onto the lines as reviewed; undoable) and Fix with AI (the agent's
      file write, or a fenced file in API mode, becomes a proposal shown as a diff; Use writes it
      only if the file is unchanged; undoable)
- [x] 35 review rules: guideline files covering the changed files (CLAUDE.md, AGENTS.md, GEMINI.md,
      .cursorrules, .windsurfrules, copilot-instructions; scoped by directory), path instructions
      from .coderabbit.yaml, and learnings saved with "Don't flag again" (per repository,
      optional glob, manageable); the Review view says what the model was told
- [x] 39 walkthrough of uncommitted changes, a commit, a run of commits or a branch: summary,
      review effort 1-5, files grouped by purpose (checked: only files in the change, the rest
      under "Other changes"), a sequence diagram drawn as our own SVG from checked JSON, recent
      history of the same files (local)
- [x] 40 reading order: every hunk placed in a layer (contracts, implementation, tests, config,
      docs) by path and codegraph, imports / comments / whitespace folded, a one-line summary each
- [x] 41 ask about selected lines in any diff: the context is the lines, the definition around
      them, definitions of names they use (codegraph), the commits that changed them (log -L) and
      who wrote them (blame -L); follow-ups keep the thread; threads are saved per repository,
      pinned to their commit, and listed in its details
- [x] 32 impact of a change (local, no AI): definitions it touches, adds or removes, every use
      outside the change with the function it is in, tests (by name and by use), usual
      companions; Assess impact asks the model which uses are at risk, citing only listed ones
- [x] 36 incremental re-review: hunks keyed by content; Review again sends only changed ones
      (no model call when nothing changed), carries findings whose exact lines are still there
      (relocated after shifts) and lists the rest as addressed; a change in guidance (a new
      learning, an edited CLAUDE.md) makes it a full review
- [x] 37 secret scan (built in, always on) over the exact text of every AI request: a match
      stops it with what was found, masked, and where (file:line for diffs); Redact and send
      replaces each one with "[REDACTED kind]". Reviews also report secrets on added lines
      themselves. Linters: ESLint, Ruff, ShellCheck when the repository is set up for them, plus
      a command from Settings; each exact command allowed once per repository; run without a
      shell, only on files whose disk text is the reviewed text; reports on added lines become
      findings and are listed to the model so it does not repeat them
- [x] 38 pre-push checks: rules in plain words from .coderabbit.yaml (custom_checks; error
      blocks, warning warns) and your own per repository, judged by the AI against exactly what
      the push sends (commits and diff); every check gets one verdict, missing or garbled ones
      are inconclusive (never pass), failures citing lines outside the push are not believed.
      A built-in secret scan of the pushed lines runs without AI. Blocking failures stop the
      push until Push anyway; other failures warn; all passing pushes straight away. Covers
      Push, Push branch, Push to…, and the push before Create pull request. Also: "Review what
      will be pushed" in the palette

- [x] 42 code context for the AI (spec 008): reviews and walkthroughs are told the change's
      intent (its commit messages) and its surroundings from the code graph (changed definitions
      with their uses outside the change, old and new signatures, removed-but-still-used ones
      first; definitions of names the added lines use; the tests that cover it), ranked and
      budgeted in proportion to the diff; the Review view says what was sent

Part B is complete.
