# GitGoose — plan 2

Nine additions on top of the first build. Each section says what it is, the design decision that
makes it tractable, what it touches, and how it is tested. Section 10 orders them and maps them
onto the agent workflow from `docs/PLAN.md`: one spec, one branch, one reviewer per slice.

Items, roughly smallest to largest:

| # | item | size |
|---|---|---|
| 1 | Not the ⌘ icon for "Commands" | trivial |
| 2 | Deletion failures (and other failed actions) impossible to miss | small |
| 3 | Make UI scaling actually work | small, but touches everything |
| 4 | A realistic development repository | small |
| 5 | Author avatars and icons on commit nodes | medium |
| 6 | A fuller settings page | medium |
| 7 | Movable, resizable panes | medium |
| 8 | Three-pane conflict resolution, IntelliJ style | large |
| 9 | Sign in with GitHub; AI features over ACP | large |

---

## 1. The "Commands" button icon

`Toolbar.tsx` uses lucide's `Command` icon, which is the macOS ⌘ glyph. Replace it with
`SquareTerminal` (a prompt in a box: "type a command") and label the button "Palette". The
shortcuts dialog already prints ⌘ on macOS and Ctrl elsewhere through `modName()`, which is
correct: that one is platform-specific on purpose.

Also audit the other places that assume a platform: `Kbd` rendering, tooltip text like
"Ctrl/Cmd+Enter" (should read the real modifier via `modName()`), and the `drag` region padding
in `TabBar` (macOS only, already conditional).

**Test:** an e2e assertion that no toolbar button renders the `Command` icon, and that tooltips
contain "Ctrl" on Linux/Windows.

---

## 2. Failed actions you cannot miss

### Problem

A failed delete (branch not fully merged, remote refused, file locked) currently produces a toast
in the bottom-right corner, which is easy to miss and auto-dismisses nothing but still competes
with success toasts. Jesse asked for something near the title bar or a modal.

### Design: two channels, by whether the user has to decide

Toasts stay for outcomes that need no decision (success, info). Failures of an action the user
just asked for go to an **attention bar**: a full-width band directly under the tab bar, red,
with the error's first line, a "Details" expander showing git's stderr, and action buttons. It
does not auto-dismiss; it goes away when the user clicks an action or ✕. Multiple problems
stack (newest first), so two failures are not one overwriting the other.

Failures that are really a question ("not fully merged: delete anyway?") become a **modal** with
the explanation and explicit buttons, because the user has to choose. The rule:

| outcome | surface |
|---|---|
| success, nothing to decide | toast (bottom right, auto-dismiss) with Undo where applicable |
| failure, nothing to decide (push rejected, fetch auth failed, hook refused) | attention bar until dismissed |
| failure that is a question (not fully merged, would overwrite files, needs force) | modal |
| operation stopped on conflicts | the conflict wizard opens, plus one info toast |

Implementation: `run()` in `lib/actions.ts` already funnels every action; it reports failures
through `toastError`. Add `attention(title, detail, actions)` in the store (`attentions: []`,
rendered by `AttentionBar.tsx` in `App.tsx` between `TabBar` and `Toolbar`), route `run()`'s
catch to it, and keep `toastError` only for background problems (watcher, aux refresh). The
`deleteBranch` special case becomes a `confirmAction` modal with "Delete anyway (undoable)".
A small "problem" pulse on the Undo/toolbar area is unnecessary once the bar exists.

**Tests:** e2e: delete a branch that is not fully merged → modal, confirm → deleted → Undo works;
push to a remote that rejects (a bare repo with a pre-receive hook that exits 1) → attention bar
with the hook's message in Details; two failures → two rows.

---

## 3. Make scaling work

### Problem

Settings has a "Font size" slider that sets `--gs-font-size` on `<html>`, but almost nothing
reads it: components use fixed Tailwind sizes (`text-[13px]`, `h-6`, 68 occurrences), and the
virtualized lists use constant row heights in JavaScript (`ROW_H = 28`, `LINE_H = 20`). So the
slider changes a few labels and misaligns everything else.

### Design: zoom the whole window; size code separately

Two settings replace the one slider:

1. **UI scale** (80–175%, default 100%, with Ctrl/Cmd+= / - / 0 bound to it). Implemented with
   `webContents.setZoomFactor()` in the main process. Chromium scales the entire page: every CSS
   px, every SVG, every row height, all in proportion, with no component changes. The
   virtualizer keeps working because it measures in CSS px and zoom changes how many device
   pixels a CSS px gets, not the numbers. This is how VS Code's `window.zoomLevel` works. The
   existing View-menu zoom roles are removed (they change the same factor but never persist).
2. **Code font size** (10–20px) and **code font family**, read by the diff view, blame, the
   conflict editors and the commit message box through `--gs-code-size` / `--gs-code-font`.
   Those components compute `LINE_H` from the font size (`Math.round(size * 1.6)`) instead of a
   constant, so rows and virtualization stay aligned.

The old "Font size" slider is removed; its stored value migrates to UI scale (13px → 100%).

Why not change every `text-[13px]` to `rem`? It would take a day, risk layout regressions in 30
components, and still not scale SVG strokes, icons and JS row heights. Zoom does all of it in one
call. The one real cost: zoom also scales the code font, so code size is "relative to scale",
which is what users expect anyway.

**Tests:** e2e: set scale 150% → `getZoomFactor()` is 1.5 and a known row's bounding box is 1.5×
taller; set code size 16 → diff line height 26 and no overlap (virtual item size equals
rendered height); restart → both persist.

---

## 4. A realistic development repository

`makeLargeRepo` builds a 100k-commit history for the benchmark, but it is one file, one author
and a repeating merge pattern: fine for timing, useless for eyeballing the UI. Add
`makeDevRepo()` in `tools/fixtures` and a root script `pnpm dev:repo` that writes it to
`.fixtures/dev-repo` (cached) and `pnpm dev` opens it by default when it exists.

Shape (all deterministic from a seeded PRNG so screenshots are reproducible):

- A project tree that looks real: `src/` with ~60 files in nested folders (TypeScript, CSS,
  JSON, Markdown), `docs/`, `tests/`, `package.json`, `README.md`, a 2 MB binary asset, a
  CRLF file, a file with spaces and one with unicode in its name.
- ~3,000 commits over two simulated years, from 8 authors with distinct names and emails (two
  of them GitHub-noreply addresses, for avatar testing), with realistic messages
  ("fix: …", "feat(router): …", "Merge pull request #412 from …").
- Each commit changes 1–6 files: edits to existing lines (the generator keeps file contents in
  memory so changes are real, not appends), new files, deletes, 5% renames.
- 25 branches: long-lived `main`, `develop`, `release/1.x`, `release/2.x`; feature branches
  that start, run 5–40 commits and merge back with `--no-ff`; a few that never merged and are
  still open; two that were merged with a squash so they look divergent; one orphan `gh-pages`.
- 40 tags (`v1.0.0` … `v2.7.3`, annotated), 3 stashes, 2 remotes (`origin` as a bare clone with
  the local branch ahead by 2 and behind by 3, `upstream` with one extra branch).
- A ready-made conflict: branch `conflict/renames-vs-edits` touches the same lines as `develop`
  and renames a file the other side edited, so the three-pane tool has something hard to show.
- A dirty working tree: 3 modified files, 1 staged, 2 untracked, 1 deleted.

Built with `fast-import` for the history (seconds, not minutes) and plain git for the parts
`fast-import` cannot express (stashes, remotes, the working tree). Also add a smaller
`makeDevRepo({ commits: 300 })` variant for e2e tests that want realism without the wait.

**Tests:** the generator is itself tested: branch and tag counts, author set, at least one
rename detected by `-M`, `git fsck` clean, the conflict branch really conflicts.

---

## 5. Avatars and icons on commit nodes

### What GitKraken draws

The node of each commit is the author's avatar (a circle), with a ring on HEAD; merge commits
are a smaller plain dot; the WIP node is a dashed circle with a pencil; stash commits get a
stash icon. Tags and branches stay as pills in the ref column.

### Design

- **Node kinds** are decided by the layout consumer, not the layout: `commit`, `merge`,
  `head`, `wip`, `stash` (hash is in the stash list). `GraphCell` takes `kind` and `avatar`.
- **Geometry.** Avatars need ~18px nodes. Row height stays 28px. Lane width goes from 16 to 20
  px only for lane 0 is wrong (lanes must be uniform), so `LANE_W` becomes 20 and the node
  radius 9; lines keep 2px. The graph column widens by 25% at the same lane cap, which is fine
  with the resizable column from the last round.
- **Rendering.** SVG `<clipPath>` with a circle, `<image href=…>` inside, and the initials
  circle underneath as the fallback while the image loads or when there is none. One `<defs>`
  per cell is fine (40 rows); measured in the benchmark.
- **Where images come from.** Three sources, chosen in Settings → Graph → "Author avatars":
  - *Initials* (default): the coloured initials circle, no network. Keeps the "no network
    unless asked" rule.
  - *GitHub*: signed out, only `NNN+user@users.noreply.github.com` emails resolve
    (`https://avatars.githubusercontent.com/u/NNN?s=48`, no API call); signed in (§9a), every
    author resolves through the commits API. Unknown emails fall back to initials.
  - *Gravatar*: `https://gravatar.com/avatar/<sha256(email)>?s=48&d=404`, falls back to initials
    on 404.
- **Fetching and caching live in the main process**, not the renderer: the renderer is
  sandboxed with `img-src 'self' data:` in its CSP, and it should not know URLs or emails of
  avatar services. Main exposes a custom protocol `gitgoose-avatar://<email-hash>` (registered
  with `protocol.handle`) that serves from a disk cache in `userData/avatars/` (PNG, 30-day
  TTL, negative cache for misses) and fetches on miss with a 3-second timeout. A failed fetch
  serves a 1×1 transparent PNG so `<image>` fails fast to the fallback. Concurrency capped at
  4 in flight; the first screen of a 100k repo needs at most 40.
- **Privacy note in the setting**: enabling GitHub or Gravatar avatars sends hashed emails (or
  GitHub user ids) to those services.

**Tests:** unit: email → source URL mapping, cache TTL, negative cache. e2e: with avatars off,
nodes show initials; with a local HTTP server standing in for the avatar host (settable base URL
for tests), nodes show images, a 404 falls back, and the benchmark still meets its budget.

---

## 6. A fuller settings page

Replace the small modal with a **settings page** in the centre pane (`center: { kind: 'settings' }`),
with a left list of sections and a search box that filters settings by label, like VS Code's. The
schema lives in one place so the page, defaults, validation and migration never drift:

```ts
// packages/shared/src/settings.ts
export const SETTINGS = defineSettings({
  'ui.scale':           { type: 'number', default: 1, min: 0.8, max: 1.75, step: 0.05, label: 'UI scale', section: 'Appearance' },
  'ui.theme':           { type: 'enum', default: 'system', values: ['system', 'dark', 'light'], ... },
  'code.fontSize':      { type: 'number', default: 13, min: 10, max: 20, ... },
  ...
})
export type Settings = SettingsOf<typeof SETTINGS>
```

`defineSettings` gives: typed `Settings`, `defaults()`, `validate(patch)`, and `version` with
`migrate(old)` steps (first one: `fontSize` → `ui.scale`). The page renders each entry by its
`type` (toggle, number, enum, text, path, keybinding), so adding a setting is one line.

Sections and the settings worth having:

| section | settings |
|---|---|
| Appearance | theme; UI scale; code font family and size; date format (relative / absolute / both); compact rows |
| Graph | author avatars (initials / GitHub / Gravatar); lane colours (8 / 16); show remote branches on the graph; show tags on the graph; column width (reset) |
| Git | git executable; default pull (merge / rebase / fast-forward only); fetch on open (off / on); auto-fetch every N minutes (off by default: it is network); prune on fetch; sign-off commits; GPG sign (passes `-S`; signing itself stays with git's config) |
| Diff | context lines (3); ignore whitespace; tab size; wrap long lines; show line numbers; syntax highlighting on/off; max file size to highlight |
| Confirmations | confirm force push (on); confirm delete remote branch (on); confirm discard (off: it is undoable); confirm reset hard (off, undoable) |
| Integrations | external editor command (`code --goto {file}:{line}`); terminal command; AI provider (see §9) |
| Startup & updates | reopen last tabs; check for updates (on in packaged builds); open the development repository (dev builds only) |
| Keyboard | the shortcut table from `keys.ts`, each rebindable, with conflict detection |

Each setting that affects a command threads through: `diff` reads context lines and whitespace
flags from settings when building its args; `pull` reads the default; the date column reads the
format. Settings are still one JSON file; the page writes through `setSettings` with validation,
and invalid stored values fall back to defaults instead of breaking startup.

**Tests:** unit: `defineSettings` validation and migration. e2e: change pull default to rebase
→ Pull button runs `--rebase` (visible in a merge-free linear result); change context lines to
1 → diff hunks show one context line; search "whitespace" finds the setting.

---

## 7. Movable, resizable panes

*Later change (Jesse): moving panes between slots was removed; the panes have fixed places and stay resizable and collapsible. The layout setting now holds only side widths and collapsed flags; older saved layouts keep their widths.*

### Design: layout as data

Today the three columns have fixed widths. The target is: drag the dividers; collapse the
sidebar or detail panel; move the detail panel to the left, or the diff below the graph, like
GitKraken's layout options; and have it all persist per user.

The layout is a small tree stored in settings:

```ts
type Layout = {
  left:   { panes: PaneId[]; size: number; collapsed: boolean }
  right:  { panes: PaneId[]; size: number; collapsed: boolean }
  bottom: { panes: PaneId[]; size: number; collapsed: boolean }
}
type PaneId = 'branches' | 'details' | 'diff' | 'conflicts' | 'settings'
```

The centre is always the graph. A pane shows in one slot; slots with several panes show them
as tabs. The `diff` pane is special: with `bottom` empty it opens over the graph (as now); if
the user docks it to `bottom`, the graph stays visible above it (VS Code style).

- **Resizing:** `react-resizable-panels` (4.x). It handles pointer capture, keyboard resizing,
  min sizes, collapse, and persists sizes through an `onLayout` callback. Writing this by hand
  is a week of edge cases (touch, RTL, nested groups, a11y); the library is 10 kB.
- **Moving:** each pane header has a grip; dragging it shows four drop zones (left, right,
  bottom, and "tab here" on another pane header). Dropping updates the `Layout` and the tree
  re-renders. Uses native HTML drag events, like the branch pills; no extra library.
- **Presets** in the View menu: "Default", "Wide graph" (both sides collapsed), "Diff below",
  "Reset layout". Keyboard: Ctrl/Cmd+B toggles the sidebar, Ctrl/Cmd+J toggles the bottom.
- The conflict wizard and settings page occupy the centre when open, as now, and are not
  dockable in this round.

**Tests:** e2e: drag the sidebar divider → width persists after restart; dock details to the
left → it renders left of the graph; collapse and restore; "Reset layout" returns defaults. A unit
test on the pure `moveTo(layout, pane, slot)` reducer covers the tree edits.

---

## 8. Three-pane conflict resolution (IntelliJ style)

### What IntelliJ shows

Left: your version (ours). Right: their version (theirs). Middle: the result, editable. Changes
are computed against the common ancestor (base), not between left and right. Each change in a
side pane has gutter buttons: `>>`/`<<` to apply it into the result, `×` to ignore it. Changes
that exist on only one side (or are identical on both) are non-conflicting and can be applied
all at once; real conflicts (both sides changed the same base region differently) are
highlighted red and need a choice, or hand editing. Panes scroll together, aligned by chunk.

### Design

**Data.** For a conflicted file we already read base/ours/theirs via `cat-file` stages 1/2/3.
Compute two diffs with `@codemirror/merge`'s exported `diff(base, ours)` and `diff(base, theirs)`
(the library we already depend on for the editor exports its diff engine). Merge the two change
lists by base range into blocks:

```ts
type Block =
  | { kind: 'same' }                                   // nobody changed it
  | { kind: 'ours' | 'theirs'; range }                 // one side changed it: non-conflicting
  | { kind: 'both-same' }                              // both made the identical change
  | { kind: 'conflict'; oursRange; theirsRange }       // both changed it differently
```

This is a diff3 in ~150 lines (and a good exercise: see `docs/learn/05-three-way-merge.md`,
to be written with it). `git merge-file --diff3 -p` is the reference implementation to test
against: every block our algorithm calls a conflict must appear as conflict markers in git's
output, and vice versa.

**Result document.** Start with the base and apply all non-conflicting blocks (IntelliJ offers
this as a button; we default to it, with "Start from base" and "Start from git's merge" as
alternatives in a dropdown). Conflicts are left as base text with a red block in the middle
pane until resolved. The result pane is a CodeMirror editor; the side panes are read-only
CodeMirror editors with change decorations. All three editors are plain `EditorView`s; we do
not use `MergeView` (two-pane only) but reuse its exported `diff`, decorations idea and
`goToNextChunk`-style navigation.

**Gutter actions** live between the panes as absolutely positioned buttons aligned to block
tops (we know each block's line in each pane). Applying a block replaces the corresponding
range in the result; the result's block map updates by replaying the change through the
`ChangeSet` so later blocks keep their positions. "Apply all non-conflicting", "Accept left",
"Accept right", and "Next / previous conflict" in the header. Resolved conflicts turn green;
the Save button is enabled when no red blocks remain (markers typed by hand still count: the
existing `countConflicts` check stays).

**Scroll sync.** Proportional scrolling is wrong when one side has long insertions. Instead,
sync on block anchors: when the middle pane scrolls, find the block at its top line and scroll
each side so the same block's first line is at the top. Cheap and matches IntelliJ's behaviour.

**Keep the block view.** The current ours/theirs/both block list stays as the "simple" mode;
three-pane is the default for text files, simple for small conflicts (< 3 blocks) if the user
prefers it (setting). Delete/modify conflicts and binary files keep the existing buttons.

**Tests:** unit: the three-way block algorithm against `git merge-file --diff3` on the fixture
conflicts and on generated cases (random base, random non-overlapping and overlapping edits).
e2e: open the dev repo's conflict branch, apply non-conflicting, accept left on one conflict,
type into the middle for another, save, continue; verify the file content with git.

---

## 9. Sign in: GitHub, and an AI agent over ACP

Two sign-ins, for two different things. GitHub sign-in gives the app an identity on GitHub
(avatars for every author, later pull requests, HTTPS push without a credential helper). AI
features come from an agent the user already has installed and logged into, spoken to over the
Agent Client Protocol (ACP), so GitGoose never holds AI credentials at all.

### 9a. Sign in with GitHub

**Mechanism: the OAuth device flow.** It is the flow made for desktop apps: no client secret
(GitHub's docs: "The `client_secret` is not needed for the device flow"), so nothing secret ships
in the binary. One-time setup by Jesse: register a GitHub OAuth App, enable "Device flow" in its
settings, and put the public client id in `apps/desktop/src/main/github/config.ts`.

Flow, all in the main process (`apps/desktop/src/main/github/`):

1. `POST https://github.com/login/device/code` with `client_id` and `scope` → `user_code`,
   `verification_uri`, `device_code`, `interval`.
2. Show a dialog: the code in large type, a "Open github.com/login/device" button (copies the
   code to the clipboard too).
3. Poll `POST https://github.com/login/oauth/access_token` with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code` every `interval` seconds; handle
   `authorization_pending`, `slow_down` (add 5 s), `expired_token` (offer a new code),
   `access_denied`.
4. Store the token with Electron `safeStorage` (OS keychain), call `GET /user` for login and
   `avatar_url`, show them in Settings → Accounts with Sign out. (Revoking needs the client
   secret, which the device flow deliberately does not have, so Sign out forgets the token
   locally and links to github.com's authorized-apps page; see spec 005.)

Scopes: `read:user` always; `repo` only when the user turns on a feature that needs it (push
over HTTPS, pull requests), requested with a second device-flow round so the first sign-in asks
for as little as possible.

**What it unlocks, in order:**

| feature | how |
|---|---|
| Avatars for every author (§5's "GitHub (signed in)" source) | `GET /repos/{owner}/{repo}/commits/{sha}` returns `author.avatar_url` for the GitHub account behind the commit, whatever email it used. One call per unknown author email per repository, cached email → avatar for 30 days. 5,000 requests/hour signed in, so even a 100k-commit repo with 500 authors is well inside the limit. The unauthenticated noreply-email trick stays as the signed-out fallback. |
| Push and fetch over HTTPS without a credential helper | the askpass trampoline answers GitHub's password prompt with the token when the remote host is `github.com` and the user has `repo` scope (GitHub accepts an OAuth token as the HTTPS password). |
| Pull requests (a later plan) | list PRs for the current branch, open one from a pushed branch, show checks. Deliberately not in this round: it is the feature that makes GitKraken heavy, and it should get its own spec. |

Repository → GitHub mapping comes from the `origin` URL (`git@github.com:o/r.git` or
`https://github.com/o/r`), parsed in the main process; non-GitHub remotes simply get no
GitHub features.

**Tests:** unit: URL parsing, device-flow state machine against a fake server (all four error
codes), token round-trip through `safeStorage`. e2e: sign in against a local fake GitHub
(device code → avatar appears on a commit whose email is not a noreply address).

### 9b. AI features over the Agent Client Protocol

**What ACP is.** A JSON-RPC protocol, over stdio, between an editor (the *client*) and a coding
agent it spawns as a subprocess. Zed and JetBrains use it to run Claude, Gemini CLI, Codex and
others inside the editor. The client sends `initialize` (its capabilities: file access,
terminals, whether it can run an auth command in a terminal), then `session/new` with a working
directory, then `session/prompt`; the agent streams `session/update` notifications (message
chunks, tool calls, plans) and asks the client for permission before tool calls. The agent
advertises `authMethods` in its `initialize` reply, and a prompt can fail with "auth required",
which the client resolves by running the advertised login.

**Why it fits GitGoose better than calling an API ourselves:**

- GitGoose never stores or sees AI credentials. The agent (Claude, Gemini, Codex, anything
  ACP-speaking) uses whatever login it already has on the user's machine. That also answers
  the policy question from the earlier draft of this plan: the user is using their own agent
  with their own account; GitGoose is an ACP client like Zed, not a product offering claude.ai
  login. (The Claude adapter is itself built on the Claude Agent SDK, so Anthropic's note that
  subscription login requires approval for "agents built on the Claude Agent SDK" still applies
  to how the adapter authenticates; that is the adapter's concern and Anthropic's call, not
  something GitGoose can grant or bypass. The adapter's own `/login` offers an API key or
  Claude Code login "where supported".)
- One provider implementation covers every agent, now and later.
- The agent can do more than complete text: for "resolve this conflict", it can be given the
  repository as its working directory and permission to edit exactly one file, with GitGoose
  showing the resulting diff for approval, instead of us pasting three versions into a prompt.

**Design.** `apps/desktop/src/main/ai/acp.ts` using `@agentclientprotocol/sdk` (the official
TypeScript library) on the client side:

- **Agent configuration** in Settings → Integrations → AI agent, modelled on Zed's: a preset
  list (Claude: `npx @agentclientprotocol/claude-agent-acp`; Gemini CLI: `gemini
  --experimental-acp`; Codex: its ACP adapter) plus "Custom" (command, args, env). A "Test"
  button spawns it, runs `initialize`, and shows the agent name, version and auth methods.
- **Lifecycle.** The agent process starts on first use, stays alive while the app runs (startup
  is seconds), restarts on crash, and is killed on quit. One session per repository, created
  lazily with `cwd` = the repository path.
- **Capabilities we advertise:** `fs.readTextFile: true` (so the agent can read files when
  asked to explain changes), `fs.writeTextFile` only for the conflict feature, `terminal: false`
  (the agent does not get a shell from a git client), `auth.terminal: true` so terminal-type
  login methods can be offered: when a prompt returns auth-required, GitGoose shows a dialog
  naming the method and opens the user's terminal (the external-terminal setting from §6) with
  the login command, then retries.
- **Permissions.** Every `requestPermission` becomes a modal in GitGoose (the attention surface
  from §2) showing the tool call and the file; "Allow once", "Allow for this session", "Deny".
  Nothing is auto-approved except read-only reads of files inside the open repository.
- **Prompts** are built in `ai/prompts.ts` exactly as before (commit message from the staged
  diff, explain a commit, summarize a branch, explain an error, suggest or perform a conflict
  resolution), each embedding the relevant text in the prompt and asking for a short answer, and
  each disallowing tools except where the feature needs them. Streamed `agent_message_chunk`
  updates go to the renderer as `type: 'ai-text'` events.
- **Fallback provider.** Users with no agent installed can paste an Anthropic API key
  (`@anthropic-ai/sdk`, `claude-opus-5-5`, key in `safeStorage`). Same `AiProvider` interface,
  text-only features. The earlier "local Claude Code subprocess" provider is dropped: ACP
  subsumes it.

*As built (spec 006):* a fresh session per request rather than one per repository (requests stay
independent and can run side by side); terminal logins show the command to run rather than
launching a terminal (no portable "run this in a new terminal" exists); and an agent's file
write is captured as a proposal the user accepts, so a denied or bad edit never touches disk.

**No network unless asked** holds as before: the agent is not spawned until an AI action is
used, and a one-time notice says what will be sent and to which agent.

**Tests:** unit: an in-process fake ACP agent (the SDK's `agent()` helper) exercising
initialize, auth-required → login → retry, streaming chunks, permission request → deny, agent
crash → restart. e2e: with the fake agent configured as "Custom", click ✨ in the commit box →
summary fills in; Explain on an error bar streams text; the conflict feature's permission modal
appears and a denial leaves the file untouched. No test ever talks to a real agent or API.

## 10. Order and process

Dependencies: §3 (scaling) and §6 (settings schema) change `Settings`, so they go first and
together, because §5, §7, §9 all add settings. §4 (dev repo) goes early because §5, §7 and §8
are judged by eye on it. §1 and §2 are independent and small.

| slice | contents | reviewer focus |
|---|---|---|
| A | §1 icon, §2 attention bar + modal | every `run()` failure path routed; stderr preserved |
| B | §6 settings schema + page, §3 scaling | migration from old settings.json; zoom persistence; no `text-[Npx]` added to code panes |
| C | §4 dev repo | determinism; fsck; generation time < 20 s |
| D | §5 avatars | CSP unchanged; no renderer network; cache bounds; bench budget |
| E | §7 panes | layout reducer tests; keyboard resizing; persisted sizes |
| F | §8 three-way merge | algorithm vs `git merge-file`; result positions after edits |
| G | §9a GitHub sign-in | device flow error paths; token only in safeStorage; scopes minimal |
| H | §9b ACP agent | no agent spawned before consent; permission modal on every tool call; fake agent in tests |

Each slice: write `docs/specs/00N-<name>.md` from the template (Jesse approves), implementer
agent builds in a worktree with tests, reviewer agent gets the diff and spec only, CI green,
Jesse's "teach me this diff" pass, merge. Slices C, D, E, F and G can run in parallel after B; H after A (it uses the attention surface).

Pieces worth Jesse writing himself, in the spirit of `docs/learn/`: the three-way block
algorithm (§8), the layout reducer (§7), and the avatar cache protocol handler (§5, a small but
complete example of main-process ownership of network and disk).

New dependencies (ask-before list): `react-resizable-panels`, `@codemirror/merge`,
`@agentclientprotocol/sdk`, `@anthropic-ai/sdk` (fallback provider only). No others.
