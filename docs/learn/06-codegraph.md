# Exercise 6: the code graph

**Files:** `packages/codegraph/src/definitions.ts` (`findDefinitions`, `endOf`),
`packages/codegraph/src/languages.ts` (the patterns)
**Tests:** `packages/codegraph/src/definitions.test.ts` (`pnpm test packages/codegraph`)
**Used by:** Code Peek (Ctrl/Cmd+click a name in a diff), and later the review and impact features

## The idea in one paragraph

To answer "where is this defined?" you do not need a parser. Definitions are written in a few
fixed shapes per language (`function x`, `def x`, `fn x`, `class X`), always at the start of a
line, so one regex per shape finds them. Where a definition *ends* is the only hard part: count
braces from its first line until they balance (ignoring braces inside strings and comments), or,
for Python and Ruby, stop at the first line indented no deeper than the definition. git does the
rest: `git grep -w` finds every use of a name in milliseconds, at any revision, and blob ids make
caching exact (same content, same id, same definitions).

## Do it

1. Replace the body of `findDefinitions` with `return []` and keep `endOf`. Make the TypeScript
   test pass first: only the patterns and the "a function inside a class is a method" step.
2. Then stub `endOf` and rebuild it. The tests that break first tell you which rule you missed:
   one-line definitions, `{` on the next line (Allman style), and multi-line signatures.
3. Run Code Peek on this repository (`pnpm dev`, open any diff, Ctrl+click a function name).

## Questions to answer before peeking

- Why are the patterns tried in order, with `break` after the first match? Find a line that two
  TypeScript patterns would both match.
- `NOT_NAMES` applies only to `guard`ed patterns. What went wrong when it applied to all of them?
  (Hint: Rust.)
- The cache key is the blob id of the file content, not the path and revision. Why is that both
  simpler and more correct?
- Where does this approach fail? Write a TypeScript snippet that `findDefinitions` gets wrong.
  Is it worth fixing, or is it rare enough to accept?

## Extensions

- Add a language you use (Elixir, Scala, Lua…): a `LANGUAGES` entry, an extension in `EXT`, and a
  test. Decide whether its blocks are braces, indentation or `end`.
- `enclosingDefinition` answers "which function is this changed line in?". Show it in the hunk
  headers of the diff view (git's own `@@ … @@ funcname` heuristic is often wrong; is yours better?).
- Tree-sitter would give exact answers. What would it cost (bundle size, native builds, one grammar
  per language) and what would it buy? When would you switch?
