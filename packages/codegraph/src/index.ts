/**
 * codegraph: what code defines and where it is used.
 *
 * Two layers. `extract` parses a file with tree-sitter (the official grammars' WASM and tags
 * queries) into symbols and references; `store` keeps those per blob in SQLite and answers
 * "where is X defined / used as of this tree?". Both are plain Node: the git package feeds
 * them content by blob id and trees by revision, and the app runs them in a utility process.
 *
 * `definitions` is the older line-pattern finder, kept for files no grammar parses (Swift) and
 * for callers that need an answer before a repository is indexed.
 *
 * This entry is browser-safe (the renderer uses `identifierAt`); the parser and store are
 * exported from `@gitgoose/codegraph/node`.
 */
export * from './languages'
export * from './definitions'
export * from './grep'
