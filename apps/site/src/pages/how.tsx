import { Code, GITHUB, mount, Section, Shell, Toc } from '../Layout'
import { LogPipeline, ProcessModel } from '../figures/arch'

const toc = [
  ['processes', 'Three processes'],
  ['git', 'The git CLI, not libgit2'],
  ['log', 'Streaming the log'],
  ['graph', 'The commit graph'],
  ['undo', 'Undo by recording inverses'],
  ['staging', 'Line staging'],
  ['codegraph', 'The code graph'],
  ['repo', 'The repository'],
] as const

function How() {
  return (
    <Shell page="how" root="../">
      <div className="doc-layout">
        <Toc items={toc} />
        <div className="doc-main">
          <h1>How GitGoose works</h1>
          <p className="lede">The decisions behind the app, in the order they matter: where git runs, how the log reaches the screen, how the graph is laid out and drawn, and how every action becomes undoable. Each one is written up as an architecture decision record in the repository; this page is the tour.</p>

          <Section id="processes" title="Three processes">
            <ProcessModel />
            <p>Electron gives a main process (Node) and a renderer (Chromium). GitGoose keeps git entirely in the main process, inside a package with no Electron imports, so it can be tested with plain vitest against real repositories and could move to a utility process with a one-file change. The renderer is React with a zustand store and never touches Node.</p>
            <p>The bridge between them is one typed table. <code>packages/shared</code> declares the API as a TypeScript interface and a list of method names; the preload script builds <code>window.gitgoose</code> from the list, and the compiler demands a handler for every method in the main process's IPC router. Adding a method is one line in the interface, and the compiler points at what is missing. Results and errors both travel as data, so git's stderr survives the trip and ends up in the toast the user sees.</p>
            <p>Parsing source code for the code graph is the one job heavy enough to stall even the main process, so it runs in a third process, an Electron utility process, and writes to SQLite while the main process reads.</p>
          </Section>

          <Section id="git" title="The git CLI, not libgit2">
            <p>All git work shells out to the user's own <code>git</code> binary through one runner. No libgit2, no nodegit, no isomorphic-git. Tower, Fork, GitHub Desktop and VS Code made the same choice, for the same reasons:</p>
            <ul>
              <li>The user's git already handles credential helpers, SSH agents, hooks, LFS, worktrees, sparse checkout, signing and every config option. A reimplementation has to chase all of them.</li>
              <li>No native module to rebuild for every Electron upgrade.</li>
              <li>Plumbing formats are stable contracts: <code>status --porcelain=v2 -z</code>, <code>log --format</code> with <code>%x00</code> separators, <code>for-each-ref --format</code>, <code>cat-file --batch</code>.</li>
            </ul>
            <p>The rules that make it work: every call forces <code>core.quotepath=false</code>, <code>color.ui=never</code> and a C locale; only NUL-separated machine output is ever parsed, never text meant for humans; read-only commands pass <code>--no-optional-locks</code> so a background refresh never blocks the user's own git in a terminal; and every parser has tests against output captured from fixture repositories. Nothing mocks git.</p>
            <table className="compare">
              <thead><tr><th>Need</th><th>Command</th></tr></thead>
              <tbody>
                <tr><td>The log</td><td><code>git log --date-order --all --format=…%x00… -z</code>, streamed</td></tr>
                <tr><td>Refs</td><td><code>git for-each-ref --format=…</code></td></tr>
                <tr><td>Working tree</td><td><code>git status --porcelain=v2 -z --branch --untracked-files=all</code></td></tr>
                <tr><td>File contents</td><td>one long-lived <code>git cat-file --batch</code> per repository</td></tr>
                <tr><td>Stage lines</td><td>build a patch, <code>git apply --cached</code></td></tr>
              </tbody>
            </table>
          </Section>

          <Section id="log" title="Streaming the log">
            <LogPipeline />
            <p>One <code>git log</code> process per history walk, read lazily with stream backpressure: when the app stops reading, the pipe fills and git blocks on write. Pages are slices of what has been read; there is no <code>--skip</code>, which would make git re-walk the history for every page.</p>
            <p>The measurement that shaped this: <code>--date-order</code> is not the plain walk. It is a topological sort that breaks ties by date, which is what the lane layout needs (every child above its parents), but without extra information git must walk all of history before it can print the first commit. On 100,000 commits that is about 600 ms. The commit-graph file stores generation numbers that let git prove "nothing unseen is a child of this commit" early, and with it the first page takes about 10 ms. So GitGoose writes a commit-graph in the background when a repository lacks one, exactly as <code>git gc</code> would, and extends it after fetch and pull.</p>
          </Section>

          <Section id="graph" title="The commit graph">
            <p>Two pure pieces, built and tested without Electron.</p>
            <p><b>Layout</b> is a single pass over commits in topological order carrying one piece of state: an array of lanes, each waiting for the hash its line is travelling down to meet. A commit lands in the leftmost lane waiting for it, or a free one if it is a branch tip; its first parent inherits the lane; a merge's other parents join a waiting lane or open one. Lane 0 is held for the main line, so a checkout never reshuffles the graph, and HEAD gets a lane for the dashed line down from the uncommitted changes. Because all state is in that array, page 2 appends without changing page 1, and 100,000 commits lay out in about 90 ms.</p>
            <p><b>Rendering</b> is a virtualized list. Each visible row draws its own small SVG from the edges the layout recorded for it, split at the node into the parts above it, through it and below it, so a row never looks at its neighbours. About forty rows exist in the DOM at any time; scrolling re-renders the list but not the rows, which take their offset as a plain number so React's memo holds. The plan said to switch to Canvas only if profiling showed SVG was the bottleneck; at 60 fps over 100,000 commits it never did.</p>
            <p>The page on <a href="../graphs/">drawing git graphs</a> compares this layout with what other clients do, with the walk stepped through row by row, and the <a href={`${GITHUB}/blob/main/docs/PLAN-6-graph.md`}>graph redesign plan</a> says what changes next.</p>
          </Section>

          <Section id="undo" title="Undo by recording inverses">
            <p>Git keeps commits after branches move, but not which operations the user did or how to reverse them. So every write in GitGoose records its inverse as data in a journal, together with the HEAD it produced. Undo replays the inverse of the latest entry and refuses if HEAD has moved since, because another tool changed the repository.</p>
            <table className="compare">
              <thead><tr><th>Operation</th><th>Inverse</th></tr></thead>
              <tbody>
                <tr><td>commit, amend</td><td><code>reset --soft</code> to the previous commit; the changes stay staged</td></tr>
                <tr><td>merge, rebase, pull, cherry-pick, revert</td><td><code>reset --keep</code> to before, which refuses to clobber edits</td></tr>
                <tr><td><code>reset --hard</code></td><td><code>reset --keep</code> back, then apply a backup made with <code>git stash create</code></td></tr>
                <tr><td>discard files or lines</td><td>write back blobs saved with <code>git hash-object -w</code></td></tr>
                <tr><td>branch and tag changes, stashes</td><td>delete, recreate or rename back; pop or <code>stash store</code> the saved commit</td></tr>
              </tbody>
            </table>
            <p>This is what lets the UI skip confirmation dialogs: an undoable action runs at once and offers Undo in its toast. Only actions that change a remote ask first.</p>
          </Section>

          <Section id="staging" title="Line staging">
            <p>There is no git command that stages selected lines; <code>git add -p</code> is interactive and every GUI client builds a patch. GitGoose rebuilds the file's diff so that it contains only the selected changes and pipes it to <code>git apply</code>: <code>--cached</code> for the index, <code>--reverse</code> for unstage and discard. The rule is small enough to state: forward, unselected added lines are dropped and unselected removed lines become context; reverse, the other way round; then each hunk's line counts are recomputed. Tests cover multi-hunk shifts, files without a trailing newline, CRLF files and untracked files, which are first added with <code>git add -N</code> so they have a diff to select from.</p>
          </Section>

          <Section id="codegraph" title="The code graph">
            <p>Code Peek, Impact and the AI's code context are answered from a graph of every definition and reference in the repository, found by tree-sitter parsers (the official grammars' WASM builds and their own tag queries, so grammar and query cannot drift) and stored in Node's built-in SQLite. The index is git-aware: content is parsed per blob id, never per path, so a commit that touches twelve files parses twelve blobs, and any revision can be indexed and queried, not only the working tree. Parsing runs in a utility process; the main process opens the same database read-only to answer queries.</p>
          </Section>

          <Section id="repo" title="The repository">
            <Code>{`
apps/desktop/          Electron app: main process (IPC router, RepoManager, watcher, settings, GitHub,
                       AI over ACP, code graph service), preload bridge, React renderer
packages/shared/       the IPC contract and data types
packages/git/          everything that runs git: runner, parsers, LogStream, patch builder, undo, Repo
packages/graph/        lane layout: pure, zero dependencies
packages/codegraph/    tree-sitter parsing and the SQLite graph store
tools/fixtures/        deterministic test repositories
tools/bench/           the 100k-commit benchmark with budgets
docs/adr/              one record per decision; docs/specs/ one spec per feature; docs/learn/ exercises`}</Code>
            <p>Definition of done for any change: typecheck, the vitest suite (real git against fixtures, never mocked) and the Playwright end-to-end suite that drives the built app all pass, and the change has a test that would fail without it. Anything touching the log, the layout or the graph also passes the benchmark's budgets.</p>
            <p>Everything on this page is in <a href={`${GITHUB}/tree/main/docs/adr`}>docs/adr</a>, with the measurements that decided it.</p>
          </Section>
        </div>
      </div>
    </Shell>
  )
}

mount(<How />)
