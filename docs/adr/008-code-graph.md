# ADR-008: Code graph on tree-sitter, indexed in the background

**Status:** accepted

## Decision

- Code Peek, Impact and the AI's code context are answered from a **code graph**: every
  definition (functions, methods, classes, types, constants) and every reference (calls, type
  uses, constructor calls, imports) in the repository, found by **tree-sitter** parsers, stored
  in **SQLite**.
- Parsers are the official grammar packages' prebuilt WASM (`tree-sitter-typescript`,
  `tree-sitter-python`, …) run by `web-tree-sitter`, with each grammar's own `queries/tags.scm`.
  Grammar and query always come from the same package version, so they cannot drift. Kotlin's
  package ships no query; ours is in `packages/codegraph/queries/`.
- Storage is Node's built-in `node:sqlite` (Electron 44 ships Node 24). No native module to
  rebuild, no dependency. One database per repository under the app's user data directory,
  keyed by the repository's common git dir. Nothing is written into the repository.
- The index is **git-aware**: content is parsed per **blob id**, never per path. A tree
  (a commit, the index, or the working tree) is a list of `(path, blob)` rows pointing at parsed
  blobs. Indexing a commit that touches 12 files parses 12 blobs. Any revision can be indexed
  and queried, not only the working tree, because the diff being read may be at any commit.
- Parsing runs in an Electron **utility process**, never in main or the renderer. Main opens
  the same database read-only to answer queries (SQLite WAL allows one writer and readers).
- The renderer learns the index's state from `codegraph` events (`indexing` with progress,
  `ready`, `error`, `off`). Features that need the graph (Code Peek, Impact) show the progress
  and wait while a repository indexes, as Codex and Cursor do. The AI's context (review,
  walkthrough, ask) uses the graph when it is ready and the old line-pattern definitions
  (`findDefinitions`) otherwise, since a slightly poorer context beats a blocked review.
- Swift and any file whose grammar fails to load keep the line-pattern path.

## Why

- The previous `git grep` + line-pattern approach could not tell a call from a mention, two
  methods of the same name apart, or a definition from an overload, and had no notion of
  imports. Users compare this to CodeRabbit's code graph analysis; the only way to get there is
  a parser per language.
- The library suggested for this (`@colbymchenry/codegraph`) is, at runtime, the same stack
  (web-tree-sitter, prebuilt grammars, `node:sqlite`) wrapped in a 286 MB per-platform bundle
  with an MCP server, a viewer, agent installers, a daemon and telemetry on by default, writing
  `.codegraph/` into every repository and indexing only the working tree. We want the parsers,
  not the product around them.
- Language servers would be more precise but need a toolchain per language installed, start
  slowly, and cannot answer for a past revision.
- Blob-keyed indexing keeps the two performance rules: the cost of a change is proportional to
  the change, and the first index of a repository runs off the main thread with the rest of the
  app usable.

## Consequences

- The app grows by about 25 MB of WASM grammars, copied into resources at build time
  (`apps/desktop/scripts/grammars.mjs`, `extraResources` in electron-builder).
- `packages/codegraph` depends on `web-tree-sitter` and the grammar packages; the desktop app
  declares the same grammar packages so the main process can resolve the WASM files in
  development. Tests in `packages/codegraph` and `packages/git` parse with the real grammars.
- A first index of a large repository takes time (tens of thousands of files: minutes). The
  state is visible, the rest of the app is not affected, and it is only ever done once per
  blob: later commits and checkouts index only what changed.
- Query precision is tree-sitter's, not a type checker's: two classes with a method of the same
  name are still both found for a call of that name. Imports narrow this for languages that
  name what they import. Resolving through types is a later step, if ever needed.
