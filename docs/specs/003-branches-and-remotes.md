# 003: Branches, history operations and remotes

**Status:** shipped (sidebar and drag-and-drop rebuilt as Tower's in PLAN-4 phase 4)

## Behaviour

- Double-click a branch (pill or sidebar) to check it out. Remote branches check out as a local
  tracking branch.
- Right-click a commit: create branch/tag here, check out detached, cherry-pick, revert, reset
  (soft/mixed/hard), copy SHA/message. Right-click a branch: the menus below.
- Drag and drop: the target and the Alt key decide what a drop does; there is no chooser menu
  (ADR-009). The full matrix is below.
- Toolbar: Pull (merge/rebase), Push (normal / force-with-lease), Fetch (all, prune), Branch,
  Stash, Pop. Ahead/behind badges on Pull/Push.
- Credential prompts from git or ssh appear as a dialog (password fields masked).

## The sidebar

Sections, top to bottom. Each one folds, and what is folded (sections, folders, remotes) is kept
per repository in settings (`sidebar`), so it survives a restart.

| section | items | notes |
|---|---|---|
| **Workspace** | Working Copy (Mod+Alt+1), History (Mod+Alt+2), Stashes (Mod+Alt+3, count), Pull Requests (Mod+Alt+4, only with a GitHub remote), Reflog (Mod+Alt+5) | Working Copy selects the WIP row and the commit panel; History shows every branch again (clears a branch's history view); Stashes and Pull Requests unfold their lists (the pull request list asks GitHub only when opened or refreshed); Reflog opens the reflog view |
| **Pinned** | pinned local branches, in pin order | pin from a branch's menu or by dragging it onto the header; stored in git config `gitgoose.pin` (multi-valued), so every worktree shares it; a rename carries the pin along |
| **Branches** | local branches as a folder tree on `/` | folders first, alphabetical; HEAD in bold with a check mark |
| **Remotes** | one node per remote (folded at first), each a folder tree of its branches | the node's menu: Fetch, Prune, Edit URL…, Rename…, Remove, and the tag checks |
| **Tags** | newest first, in folders | View ▸ Tags ▸ newest 50 / 100 / 250 / all (Settings → Appearance); the filter always searches all |
| **Submodules**, **Worktrees**, **Git LFS** | as before | Worktrees starts open only when there is more than one |

- **Filter** (bottom of the sidebar): while it has text, Pinned, Branches, Remotes and Tags show
  only matching refs, flat, by full name, folded folders included. Clearing it (Esc in the box)
  brings back the tree exactly as it was.
- **+** (bottom left): Create branch…, Create tag… (at HEAD), Add remote…, Add submodule…, Add
  worktree…. **Gear** (bottom right): Group refs in folders (every repository); Show merged badge,
  Show stale badge, Show reflog, Show stash count, Click a branch: show its history / reveal its
  commit (this repository).
- **Badges** after a branch's name, in this order, giving way before the name does: `↑n ↓n`
  (tooltip: the upstream and when the repository last fetched), `gone`, `merged`, `stale`,
  `worktree`, `#PR`, and `local only` on tags after "Check which tags are on <remote>".
- **A click on a branch shows its history**: it solos the branch through the graph filter (spec
  001), the Viewing bar says "Viewing the history of …", and Ctrl/Cmd-click adds or removes a
  branch. History, Esc in the sidebar, or Show all go back to every branch (hidden branches stay
  hidden). A double-click checks out and leaves the graph as it was before the click. Tags, and
  branches when the gear says "reveal its commit", jump to their commit instead. **Reveal in
  History** in every ref's menu always jumps without filtering.
- **Keyboard** (sidebar focused): ↑↓ move, ← folds or goes to the parent folder, → unfolds or
  goes in, Enter checks out (or activates), Space shows the history, Delete deletes the branch,
  tag or stash (undoable; an unmerged branch still asks), Esc shows every branch, Mod+0 goes to
  HEAD's branch (opening its folders). Mod+Alt+0 does that from anywhere.
- **Virtualized**: the sidebar is one flat list of rows (`lib/sidebarRows.ts`) rendered with
  `@tanstack/react-virtual`; 2,000 branches and tags keep ~40 rows in the DOM.

### Context menus

An action that cannot run *right now because of state* (this is HEAD, a merge commit, nothing to
push, already up to date, no upstream yet, AI turned off, nothing staged) is shown greyed with the
reason in a tooltip (and as the item's `aria-description`). An action whose *subject does not exist
in this repository* is left out: no remotes means no Push to… / Fetch all / Track a remote branch,
no GitHub remote means no Create pull request…, no separate push URL means no "push to the fetch
URL again". Real alternates are swapped (Pin / Unpin, Show / Hide in the graph, Push / Publish,
Lock / Unlock). The reasons are pure functions in `lib/menuRules.ts` (one per conditional action,
`undefined` when allowed), tested in `menuRules.test.ts` and shared with the AI pane. The point of
greying is to teach the rule, so a menu must still fit a 1024×640 window without scrolling. The
lists below name everything a menu can offer; some items are greyed in some states.

- **Local branch**: Check out; Check out in a new worktree…; Create branch from…; Merge into HEAD,
  Merge options ▸, Rebase HEAD onto it; Pull (HEAD's branch); Fast-forward (only behind); Push, or
  Publish to <remote> (no upstream); Force push with lease…; Push to <remote>…; Track ▸; Stop
  tracking; Create pull request…; Compare ▸; AI review / walkthrough / impact; Pin / Unpin;
  Reveal in History; Hide / Solo in the graph; Rename…; Delete; Copy name.
- **Remote branch**: Track… (a local branch, not checked out); Check out; Create branch from…;
  Pull into HEAD; Merge / Rebase; Make HEAD track it; Compare ▸; Reveal in History; Hide / Solo;
  Delete on remote…; Copy name.
- **Tag**: Check out; Push to <remote>; Create branch from…; Compare ▸; Reveal in History; Delete
  tag; Delete on <remote>…; Copy name.
- **Stash**: Apply; Pop; Create a branch from this stash…; Drop.
- **Remote**: Fetch; Prune; Show/Hide its branches; Push all tags; Check which tags are on it;
  Edit URL…; push URL; Rename…; Copy URL; Remove.

## Drag and drop

A plain drop runs at once and offers Undo; Alt picks the alternative; drops that change a remote
ask first. A badge by the pointer says what the drop will do and what Alt would do instead.
`lib/dnd.ts` (`dropPlan`) is this table; `lib/dnd.test.ts` has one case per row.

| source → target | drop | Alt | asks |
|---|---|---|---|
| local branch → HEAD's branch, Working Copy, WIP row, or HEAD's row | Merge into HEAD | Rebase HEAD onto it | – |
| local branch → other local branch (sidebar or pill) | Check out the target, merge the source into it | Check out the target, rebase it onto the source | – |
| local branch → remote node | Push to its upstream there, or Publish (with tracking) | Force push with lease | yes |
| local branch → remote branch | Push onto that remote branch (and track it) | Force push with lease | yes |
| local branch → Branches header | Create branch from it… | – | – |
| local branch → Tags header | Create tag at its tip… | – | – |
| local branch → a folder in Branches | Rename into that folder (`branch -m`) | – | – |
| local branch → Pinned header | Pin (not when pinned already) | – | – |
| local branch → Worktrees header | Check out in a new worktree… (not HEAD's branch) | – | – |
| local branch → Pull Requests item | Create pull request… | – | its own dialog |
| remote branch → Branches header | Check out as a local tracking branch | Create it without checking out | – |
| remote branch → HEAD's branch / Working Copy / WIP row | Pull it into HEAD (`pull <remote> <branch>`) | Pull with rebase | – |
| remote branch → other local branch | Set as its upstream | – | – |
| commit(s) → Working Copy / HEAD's branch / WIP row | Cherry-pick (oldest first) | Revert (HEAD's own commit too) | – |
| one commit → Branches / Tags header | Create branch / tag at it… | – | – |
| commit(s) → the upper or lower third of a row on the editable part of HEAD | Move above / below it | – | – |
| commit(s) → the middle of such a row | Squash into it | Fixup (keeps the target's message) | – |
| commit(s) → other local branch | Cherry-pick onto it without a checkout (see below) | – | – |
| tag → remote node | Push the tag | – | yes |
| stash → Working Copy / WIP row | Apply | Pop | – |
| a file in a commit's or stash's file list → Working Copy / WIP row | Apply that file's change to the working tree | – | – |
| working-copy file(s) → Stashes item | Stash only those files | – | – |

Everything else is not a target: no badge, no highlight, the pointer says no. A dragged commit
that is part of the selection drags the whole selection.

## Git commands

`checkout [--track -b | --detach]`, `branch [-m | -d | -D]`, `merge --no-edit [--ff-only | --no-ff]`,
`rebase`, `reset --soft|--mixed|--hard|--keep`, `cherry-pick [-m 1]`, `revert --no-edit [-m 1]`,
`tag [-a -m]`, `fetch --progress [--prune] --all`, `pull --no-edit --rebase|--no-rebase [<remote> <branch>]`,
`push [-u remote branch] [--force-with-lease]`, `push remote --delete`.
Cherry-pick onto a branch that is not checked out: `merge-tree --write-tree --name-only -z
--merge-base=<C^> <branch> <C>` (git 2.40+; exit 1 means conflicts, and the drop is refused before
anything changes), `commit-tree` with C's author and message, `update-ref <branch> <new> <old>`.
Apply one file's change: `diff --binary <C^> <C> -- <path>` (a stash: its working tree against
its base, plus its third parent for untracked files), `apply`, falling back to `apply --3way`.
Pins: `config --add gitgoose.pin <branch>`, `config --unset-all --fixed-value gitgoose.pin <branch>`,
`config --get-all gitgoose.pin`.
GIT_ASKPASS / SSH_ASKPASS point at the askpass trampoline (packages/git/src/askpass.ts).

## Undo

All local operations are undoable (ADR-005), drops included: cherry-pick onto another branch
moves that branch back (`update-ref` with the old value), an applied file is written back (and,
after a `--3way` apply, its index entries too), a pin is removed. Changes to remotes are not
undoable: force push, publishing, pushing a tag and remote branch deletion ask for confirmation
instead.

## Acceptance tests

`repo.test.ts` "branches", "remotes", "stash", "askpass", "drag-and-drop operations";
`lib/dnd.test.ts` (the matrix), `lib/refTree.test.ts`, `lib/sidebarRows.test.ts`;
`e2e/sidebar.spec.ts`, `e2e/dnd.spec.ts`, `e2e/interaction.spec.ts`, `e2e/remotes.spec.ts`,
`e2e/workingtree.spec.ts` (push/pull, branches).
