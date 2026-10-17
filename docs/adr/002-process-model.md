# ADR-002: Process model and IPC

**Status:** accepted

## Decision

- Git runs in the Electron **main process**, inside `packages/git` (plain Node, no Electron
  imports). The renderer never touches Node.
- The window uses `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The preload
  script is emitted as CommonJS because sandboxed preloads cannot be ES modules.
- One IPC channel (`gitsquid:invoke`) carries `(method, args)`. The method list is
  `API_METHODS` in `packages/shared/src/api.ts`, checked against the `GitSquidApi` interface at
  compile time. Results and errors both travel as data (`IpcResult`), so git's stderr survives.
- Main pushes events on `gitsquid:event`: snapshots, worktree changes, credential prompts,
  progress, menu commands.

## Why

- One typed table instead of fifty hand-written channels: adding a method is one line in the
  interface, and the compiler points at the missing handler.
- Keeping `packages/git` free of Electron means it is testable with plain vitest and can move to
  an Electron `utilityProcess` with a one-file change if git work ever makes the main process
  stutter. So far all git work is asynchronous child processes, so main stays responsive.

## Consequences

- Everything crossing IPC must be structured-clone data: no classes, Dates or functions. Dates
  are unix seconds.
