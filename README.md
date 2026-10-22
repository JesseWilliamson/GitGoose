# GitGoose

A fast git client with GitKraken's commit graph and Tower's power features.

- **The graph you like.** Lanes and curves like GitKraken, with the checked-out branch always in the
  left lane, a dashed "uncommitted changes" node, and branch pills you can drag onto each other to
  merge, rebase or reset.
- **Fast on big repositories.** The log streams from one `git log` process and only on-screen rows
  exist in the DOM. A 100,000-commit repository paints in about half a second and scrolls at 60 fps.
- **Undo instead of "are you sure?"** Commits, merges, rebases, resets (even `--hard`), discards,
  branch and tag changes and stashes can all be undone with Ctrl/Cmd+Z.
- **Line staging.** Stage, unstage or discard individual lines or hunks.
- **Conflict wizard.** Resolve each conflict block by picking ours, theirs or both, then continue.
- **Keyboard first.** Command palette (Ctrl/Cmd+K or Ctrl/Cmd+Shift+P), j/k navigation, search
  by message, author, path, code or SHA.
- **No network at startup**, no accounts, no telemetry. The one exception: author pictures are
  fetched from GitHub (no sign-in) for repositories with a GitHub remote and for GitHub noreply
  addresses, unless avatars are set to Initials. Errors are logged locally only.

## Develop

Requires Node 22+, pnpm 10, and git.

```
pnpm install
pnpm dev
```

See `CLAUDE.md` for the layout and conventions, `docs/PLAN.md` for the plan, and `docs/adr/` for
the decisions behind the architecture. `docs/learn/` has hands-on exercises for the core ideas.

| command | |
|---|---|
| `pnpm test` | parser, git-operation and layout tests (real git, no mocks) |
| `pnpm e2e` | Playwright drives the built app (`xvfb-run -a pnpm e2e` on headless Linux) |
| `pnpm bench` | 100k-commit benchmark; `--check` enforces the budgets |
| `pnpm dist` | build installers for this OS |
| `pnpm install:local` | build this working tree and install it as your everyday GitGoose; run again to update |
