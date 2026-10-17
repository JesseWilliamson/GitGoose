# ADR-004: Stream the log; keep a commit-graph

**Status:** accepted

## Decision

1. One `git log --topo-order` process per history walk (`LogStream`), read lazily with stream
   backpressure. Pages are slices of what has been read. No `--skip` paging.
2. If the repository has no commit-graph file, the app writes one in the background after
   opening (`git commit-graph write --reachable --split`), and extends it after fetch and pull.
   `core.commitGraph=false` turns this off.

## Why

- `--skip=N` makes git re-walk N commits for each page: page k costs k times page 1.
  Backpressure costs nothing: when we stop reading, the pipe fills and git blocks on write.
- `--topo-order` must print children before parents. Without generation numbers git can only
  guarantee that by walking all of history before printing the first commit. The benchmark
  showed it: first page of 100k commits took ~530 ms, and the rest of the log only ~320 ms more.
  With a commit-graph (which stores generation numbers) the first page takes ~15 ms.
- Every ref change (a commit, a checkout, a fetch) restarts the walk, so this matters far beyond
  startup.
- The commit-graph is a cache that `git gc` and `git maintenance` already write; many repos have
  one. Writing it is what git itself would do, and `--split` keeps later writes incremental.

## Consequences

- We write into `.git/objects/info/`. It is safe (git treats the file as an optional cache and
  verifies it) and can be disabled per repo with `git config core.commitGraph false`.
