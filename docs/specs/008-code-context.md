# 008: What the AI is told besides the diff (code context)

**Status:** shipped

Code: `packages/git/src/codecontext.ts` (rendering, budget), `Repo.codeContext`, `Repo.scopeCommits`,
`Repo.definitionsOf` (repo.ts), `packages/codegraph/src/store.ts` (`referencesIn`),
`apps/desktop/src/main/ai/prompts.ts` (review, walkthrough). Tests: `packages/git/src/codecontext.test.ts`,
`apps/desktop/src/main/ai/service.test.ts`. Decision record: ADR-008.

## Why

CodeRabbit describes review context in three parts ([their post on context engineering](https://www.coderabbit.ai/blog/the-art-and-science-of-context-engineering)):
**intent** (why the change exists), **environment** (how the changed code relates to the rest),
and **standards** (the team's rules). Before this spec a GitGoose review had the standards
(guideline files, path instructions, learnings, linters) and the diff, nothing else. The model
saw a changed signature but not the calls that still pass the old arguments; a removed function
but not the file that still imports it; a new call but not what it calls. It guessed, or stayed
quiet.

The same post names the Goldilocks problem: too little context and the model guesses, too much
and the diff drowns in it. So every piece here is ranked, sampled and budgeted, and the Review
view says what was sent.

## Behaviour

Review (any scope) and Walkthrough send, besides the diff:

- **Intent**: the commit messages of the change, newest first (commit, branch and outgoing
  scopes; uncommitted and staged changes have none). Up to 20, bodies cut at 600 characters.
- **Environment**, from the code graph (ADR-008):
  1. Definitions the change touches (changed, added, removed), with the defining line before
     and after when it changed, and their uses outside the change: a count, how many are in
     tests, and a sample of up to 6 (non-test first). A removed definition that is still used
     is marked `STILL USED` and listed first.
  2. Definitions, outside the change, of the names the added lines call or use as types:
     up to 12, most used first, each with up to 12 lines of its body.
  3. Test files for the changed files (by name) or using the changed definitions, and whether
     each one is in the change too.
- The review prompt says these lines are not part of the change and findings may not point at
  them, but asks the model to report when the change breaks them. Verification (spec 006,
  `verifyFindings`) drops any finding outside the diff anyway, so context lines can never
  become findings by accident.

The Review view's context line shows `code graph: N changed definitions, N uses outside, N
definitions used, N test files`, or `code (no graph yet)` when the index was not ready and line
patterns and `git grep` answered instead, and `(cut for size)` when the budget bit.

Walkthrough gets a smaller slice (12 definitions, 4 sample uses, 8 used definitions, 8k
characters): the flows a diagram draws. Push checks and Assess impact get the parsed
definitions in their hunk headers (no extra context).

## Where the facts come from

| fact | with the graph | without it |
|---|---|---|
| definitions of a file's text | `symbolsIn(blobId(text))`: the blob id is sha1 of `blob <size>\0` + text, so no git call and any content the indexer has seen is found, at any revision | `findDefinitions` (line patterns) |
| uses of a changed definition | `references(name, tree)`: calls, type uses, imports the parser saw; a word in a comment or a string is not one | `git grep -w`, minus lines that define the name |
| names the added lines use | `referencesIn(blob)` on the added lines, imports left out, names defined inside the change left out, names with no definition in the repository (built-ins, libraries) dropped for free | identifiers on the added lines minus keywords, at most 6, each one a `git grep` |
| tests | `testsByName` + test files among the uses | same |

The graph is read as of the review's head revision (the working tree, the index, or a commit).
Before building the prompt, main asks the indexer to make sure that tree is indexed and waits
at most 3 seconds: HEAD, the index and the working tree already are, a commit costs only its
changed blobs, and a first index of a big repository is not waited for (ADR-008: a slightly
poorer context beats a blocked review).

## Budget

`contextBudget(diffChars)` = the diff's size, at least 8k and at most 30k characters: roughly
the 1:1 code-to-context ratio CodeRabbit reports. `renderCodeContext` fills it in priority
order (removed-but-used, changed, added definitions; then used definitions; then tests) and
shrinks a definition's block (all sample uses, two, none) before dropping it. When anything was
left out the text ends with `(… more context left out for size)` and the view says so.

## Edge cases

- A re-review sends only the changed hunks, and the context is computed for those hunks only.
  The context is not part of `contextKey`: a caller added elsewhere does not force a full
  re-review.
- Renamed files: the old side is read under the old path.
- Binary and deleted files contribute removed definitions only.
- SHA-256 repositories: `blobId` computes SHA-1, so the lookup misses and line patterns answer.
- A changed file the indexer has not parsed yet (edited within the last 300 ms) gets line
  patterns for its own definitions and the graph for everything else.

## Acceptance tests

- vitest: `codecontext.test.ts` (graph and pattern modes, ranking, budget, intent),
  `store.test.ts` (`referencesIn`), `service.test.ts` (what the review prompt contains and
  what the view is told).
- Playwright: the existing `aireview.spec.ts` context-line checks still hold; no new UI path.

## Next steps towards CodeRabbit

In the order they would pay off:

1. **Verification against the graph.** CodeRabbit runs a second pass to check findings.
   GitGoose checks locations deterministically; the graph can check claims too: a finding
   that says a definition is unused when `references` finds uses, or that a signature change
   breaks callers when none exist, can be downgraded or dropped before it is shown.
2. **Pull request intent.** For a branch with an open PR, its title and description are the
   intent. A network call, so only when the user turns it on (public repositories only since sign-in was removed, see spec 005).
3. **Depth by effort.** The walkthrough rates effort 1-5; a review could pick its profile and
   the amount of context from that (CodeRabbit's "level-appropriate prompts").
4. **Learnings scoped by symbol**, not only by path glob, now that symbols are known.

Co-change hints ("files that usually change together") were removed; the commit-box hint now only
says whose lines the change touches.
