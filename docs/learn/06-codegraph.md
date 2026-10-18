# Exercise 6: the code graph

**Files:** `packages/codegraph/src/extract.ts` (`fromMatches`, `CodeParser`),
`packages/codegraph/src/grammars.ts` (the grammar registry and `EXTRAS`),
`packages/codegraph/src/store.ts` (`GraphStore`), `packages/git/src/codeindex.ts` (`CodeIndexer`),
`apps/desktop/src/main/codegraph.ts` (the service), `apps/desktop/src/main/indexer.ts` (the utility process)
**Tests:** `packages/codegraph/src/extract.test.ts`, `store.test.ts`, `packages/git/src/codeindex.test.ts`,
`codegraph.test.ts` (`pnpm test packages/codegraph packages/git/src/code`)
**Used by:** Code Peek (Ctrl/Cmd+click a name in a diff), Impact ("What could this affect?"),
and the AI's context for review, walkthrough and ask. Decision record: `docs/adr/008-code-graph.md`.

## The idea in one paragraph

A tree-sitter grammar turns a file into a syntax tree in a few milliseconds, and a *tags query*
(a pattern language over that tree, shipped with each grammar) names the nodes that define
things and the nodes that use them. That is a code graph's raw material: symbols and references
per file. The part that makes it a git client's code graph is the key: content is stored per
**blob id**, not per path. A tree (a commit, the index, the working tree) is just rows of
(path, blob). "Where is `total` defined at commit X?" is a join. Indexing commit Y after X
parses only the blobs Y has and X did not, so after the first index the cost of a commit is the
commit. Parsing runs in a utility process so the window never waits; the renderer only sees a
status (`indexing` with progress, `ready`) and Peek and Impact wait for it.

## Do it

1. Replace the body of `fromMatches` with `return { symbols: [], refs: [] }` and rebuild it
   from the tests. The interesting rules: a function inside a class is a method; every
   reference remembers the innermost definition around it; one definition can be matched by
   two patterns (Rust tags a `fn` in an `impl` as both) and must be stored once.
2. Stub `CodeIndexer.syncWorktree` and rebuild it. Unchanged tracked files share the index's
   blobs; modified and untracked files are read from disk and hashed with `git hash-object`.
   The test checks that a second sync parses nothing.
3. Run it: `pnpm dev`, open a repository, watch the status bar, then Ctrl+click a name.

## Questions to answer before peeking

- Why does the store key trees by the commit's **full hash**, and what would go wrong keying
  them by branch name?
- `syncRev` returns early when the tree is already stored. When is that wrong? (Hint: what
  does `reindexCode` delete?)
- The TypeScript tags query alone finds no functions. Why does `GRAMMARS.typescript` list two
  query files, and in which order must they go?
- The main process opens the same SQLite file read-only while the utility process writes to
  it. Which journal mode makes that safe, and what does a reader see mid-transaction?
- A `reference.call` for `k` shows up in Ruby for a method parameter. Why can a tags query not
  tell a local variable from a method call there, and would you fix it?

## Extensions

- Add a language: a `grammars.json` entry (the npm grammar package with its `.wasm` and
  `queries/tags.scm`), an extension in `EXT`, a case in the "every other grammar" test. If the
  package ships no tags query, write one in `packages/codegraph/queries/` (Kotlin is the
  example) and check its node names against the package's `src/node-types.json`.
- Imports narrow references: `cart.ts` imports `total` from `./price`, so a `total` called in
  `cart.ts` is the one in `price.ts`. The store has both facts; resolve them.
- Swift has no prebuilt WASM yet. Build one with `tree-sitter build --wasm` and add it.
