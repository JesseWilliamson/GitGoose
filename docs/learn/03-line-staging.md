# Exercise 3: the hunk-to-patch builder

**File:** `packages/git/src/patch.ts`, function `buildPatch`
**Tests:** the "line staging" block in `packages/git/src/repo.test.ts`
(`pnpm test packages/git -t "line staging"`)
**Background:** ADR-006

## The idea

git cannot stage "lines 3 and 5". It can apply a patch to the index (`git apply --cached`). So to
stage some lines, rewrite the file's diff so it contains only those changes, and apply that.

A unified diff hunk looks like:

```
@@ -10,4 +10,5 @@ function name
 context
-removed
+added
+added too
 context
```

`-10,4` means: starting at line 10 of the old file, this hunk covers 4 lines (context + removed).
`+10,5`: in the new file, 5 lines (context + added).

## Do it

1. Replace `buildPatch` and `rewriteHunk` with stubs that return `null`.
2. Start with forward patches (staging) and whole hunks (`lines` undefined).
3. Then line selection. Write down the rule before coding: for an unselected `+` line, does it
   become context or disappear? For an unselected `-` line? (Think about what the target file,
   the index, contains.)
4. Then reverse patches (unstage, discard). The rule flips. Why?
5. The multi-hunk test checks header arithmetic. If hunk 1 adds 3 lines, where does hunk 2 start
   in the new file?

## Questions

- `git apply` needs `--unidiff-zero` for hunks without context lines. Why do our patches never
  need it?
- What does `\ No newline at end of file` attach to, and what goes wrong if you drop it?
- Staging lines of an untracked file first runs `git add -N`. What is an intent-to-add entry, and
  why does the diff then show the whole file as added?
