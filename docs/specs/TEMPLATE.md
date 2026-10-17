# NNN: <feature>

**Status:** draft | approved | shipped

## Behaviour

What the user sees and does, step by step. Include the keyboard path.

## Git commands

The exact commands, with flags, and which output format is parsed.

## Edge cases

Empty repo, detached HEAD, unborn branch, conflicts, renamed files, binary files, huge repos,
Windows paths/CRLF, worktrees, a second tool changing the repo meanwhile.

## Undo

What the inverse is (ADR-005), or why the operation needs a confirmation instead.

## Acceptance tests

- vitest (packages/*): …
- Playwright (apps/desktop/e2e): …
