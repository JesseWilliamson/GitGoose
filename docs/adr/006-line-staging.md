# ADR-006: Line staging with generated patches

**Status:** accepted

## Decision

To stage, unstage or discard part of a file, rebuild the file's diff so that it contains only the
selected changes (`buildPatch` in packages/git/src/patch.ts) and pipe it to `git apply`
(`--cached` for the index; `--reverse` for unstage and discard). Untracked files are first added
with `git add -N` (intent to add) so they have a diff to select from.

## Why

There is no git command that stages selected lines. `git add -p` is interactive. Every GUI client
builds a patch.

## The rule

- Forward (stage): unselected `+` lines are dropped; unselected `-` lines become context.
- Reverse (unstage, discard): unselected `+` lines become context; unselected `-` lines are dropped.
- Recompute each hunk's line counts. The side of the hunk that the rewrite did not change anchors
  its start line; the other side shifts by the net lines added by earlier hunks.

Tests in packages/git/src/repo.test.ts cover multi-hunk shifts, files without a trailing newline,
CRLF files, and untracked files.
