# Exercise 9: the reader's rows (a 3,000-line diff that scrolls like a 30-line one)

**Files:** `apps/desktop/src/renderer/src/lib/stream.ts` (`buildStream`, `rowHeight`, `cellsFor`)
and `packages/shared/src/reader.ts` (`displayColumns`, `chooseLayout`)
**Tests:** `apps/desktop/src/renderer/src/lib/stream.test.ts` and
`packages/shared/src/reader.test.ts` (`pnpm test stream reader`)
**Background:** ADR-012, section "The reader"; ADR-003 for why the graph never measures rows

## The idea in one paragraph

The reader shows every file of a commit in one scrolling list. A list that long has to be
virtualized (only the rows on screen exist in the DOM), and a virtualizer needs every row's
height before it is drawn, or it must render rows to measure them, which is what makes long
lists jump while you scroll. So the reader turns a diff into rows whose heights are known in
advance: a file header, a hunk header, a line, a pair of lines. The hard row is a line that does
not fit and wraps: in a monospace font its height is `ceil(display columns / cells per line)`
lines, which is pure arithmetic once you count columns the way the screen does (a tab runs to the
next tab stop, a CJK glyph takes two cells). The same count decides each file's layout: two
newspaper columns when every line fits a column, side by side when the longest line fits a side,
otherwise unified.

## Do it

1. On a scratch branch, replace the body of `displayColumns` with `return text.length`. Which
   tests go red, and what would a user see in the app with a tab-indented Go file? (Run the app on
   such a file: lines run under the next row, because the row was too short.)
2. Restore it, then empty `buildStream` down to `return { rows: [], fileStart: new Map(), blockStart: [], layouts: new Map() }`
   and rebuild it test by test: blocks and files first, then collapsed and pending files, then
   unified lines, split pairs (`splitRows` already pairs them), and flow last.
3. Flow pairs line `k` with line `k + half`. Why `Math.ceil(n / 2)` and not `Math.floor`? Write
   the test for a file with an odd number of lines before you answer.
4. `rowHeight` of a `pending` row is `lines × lineH`. That is an estimate (context lines are not in
   the numbers). Read `DiffStream`'s "keep the reader's place" effect: what keeps the screen still
   when the real rows replace the estimate above the viewport?

## Questions to answer before peeking

- The layout rule keeps two columns spare. What goes wrong at exactly zero spare columns, given
  that the line-number gutter is sized to the file?
- The working copy is always unified. Which ADR forces that, and what would split staging need?
- `viewedKey` uses the blob ids from the diff header, not the path. Construct the rebase where a
  path-keyed mark would lie to you.

## Extensions

- Hysteresis: a window resized across a file's boundary flips it between flow and unified on
  every pixel. Add a two-column band where the current layout is kept.
- Flow by hunks (the lab's rejected option): flow a modified file's hunks side by side when the
  whole block fits one screen. Build it behind the header chip and read real code with it.
