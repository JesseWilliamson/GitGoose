# Learning GitGoose by rebuilding its core

The plans reserved these pieces for you to build yourself. They are already implemented, so the app
works, but each one is small, self-contained and fully specified by tests. That makes them good
exercises: delete the implementation, rebuild it until the tests pass, then compare.

| # | piece | size | what you learn |
|---|---|---|---|
| 1 | [Lane layout](01-lane-layout.md) | ~80 lines | how a commit graph is actually drawn |
| 2 | [IPC contract](02-ipc-contract.md) | a new method, end to end | how Electron's processes talk, and keeping them type-safe |
| 3 | [Hunk-to-patch builder](03-line-staging.md) | ~60 lines | the unified diff format, and how "stage these lines" works |
| 4 | [Undo journal](04-undo.md) | a new undoable operation | the reflog, the object database, what git can and cannot undo |
| 5 | [Three-way merge](05-three-way-merge.md) | ~150 lines | Myers' diff, diff3, and why "conflict" is a precise idea |
| 6 | [Code graph](06-codegraph.md) | ~120 lines + a language | what "good enough" code intelligence costs, and when regexes are the right tool |
| 7 | [Straight lanes](07-straight-lanes.md) | ~25 lines | letting git answer what a streaming algorithm cannot know in time |

## The routine for each exercise

```
git switch -c learn/<topic>          # a scratch branch; master keeps the reference version
# delete or stub the code the exercise names
pnpm test <path>                      # red
# implement until green
git diff master -- <file>             # compare with the reference; neither is "the answer"
```

Then ask a reviewer agent (fresh session, no context) to critique your version against the
tests and the ADRs. Read its critique skeptically: it is a second opinion, not a grader.
