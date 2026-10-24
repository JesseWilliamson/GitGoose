import { GITHUB, mount, Shell } from '../Layout'
import { GooseGraph } from '../figures/git'

function Home() {
  return (
    <Shell page="home" root="./">
      <div className="home">
        <div className="hero">
          <div>
            <h1 className="home-title">A fast git client with the graph you like.</h1>
            <p className="home-lede">
              GitGoose keeps <b>GitKraken's commit graph</b> and drag-and-drop branch operations, and adds <b>Tower's power features</b>:
              undo instead of confirmations, line staging, a conflict wizard, keyboard-first everything. Then it fixes GitKraken's two problems: it is slow, and it gets in your way.
            </p>
            <div className="cta">
              <a className="btn primary" href={GITHUB}>Source on GitHub</a>
              <a className="btn" href="./how-it-works/">How it works</a>
              <a className="btn" href="./graphs/">Drawing git graphs</a>
            </div>
          </div>
          <GooseGraph />
        </div>

        <div className="cards">
          <div className="card">
            <h3>Fast on big repositories</h3>
            <p>The log streams from one <code>git log</code> process and only on-screen rows exist in the DOM. A 100,000-commit repository paints in about half a second and scrolls at 60 fps.</p>
          </div>
          <div className="card">
            <h3>Undo instead of "are you sure?"</h3>
            <p>Commits, merges, rebases, resets (even <code>--hard</code>), discards, branch and tag changes and stashes can all be undone with Ctrl/Cmd+Z. Only what touches a remote asks first.</p>
          </div>
          <div className="card">
            <h3>Nothing at startup</h3>
            <p>No network, no accounts, no telemetry. The one exception is author pictures from GitHub's public API, which you can turn off.</p>
          </div>
        </div>

        <section className="section">
          <h2>What it does</h2>
          <ul>
            <li><b>The graph you like.</b> Lanes and curves like GitKraken, with the main line always in the left lane, a dashed "uncommitted changes" node, and branch pills you can drag onto each other to merge, rebase or reset. Two layouts: Tower's two-line rows, or GitKraken's one-line columns with avatars as nodes.</li>
            <li><b>Line staging.</b> Stage, unstage or discard individual lines or hunks. There is no git command for it; GitGoose builds the patch, like every client does, and tests it against real repositories.</li>
            <li><b>Conflict wizard.</b> Resolve each conflict block by picking ours, theirs or both, then continue.</li>
            <li><b>Keyboard first.</b> A command palette (Ctrl/Cmd+K), j/k navigation, search by message, author, path, code or SHA.</li>
            <li><b>Drag and drop that does one thing.</b> The target and the modifier key decide what a drop does, a badge on the pointer says so, and the result can be undone.</li>
            <li><b>Code context.</b> A tree-sitter code graph answers "who calls this?" from the diff you are reading, at any revision, indexed in the background.</li>
            <li><b>Your own AI agent.</b> Explain a diff, draft a message, recompose a branch: through the Agent Client Protocol with the agent you already use, or the Anthropic API.</li>
          </ul>
        </section>

        <section className="section">
          <h2>Why it is fast</h2>
          <p>Electron is not the problem; VS Code is Electron. GitKraken is slow because of how it talks to git and how it renders.</p>
          <table className="compare">
            <thead><tr><th>GitKraken</th><th>GitGoose</th></tr></thead>
            <tbody>
              <tr><td>libgit2 via a native module, loading whole repository structures into memory</td><td>The user's own <code>git</code> binary, stable plumbing formats, parsed as they stream</td></tr>
              <tr><td>Renders the whole graph into the DOM and re-renders on every change</td><td>Virtualized rows: about forty exist at a time, each drawing its own small SVG</td></tr>
              <tr><td>Accounts, nags and integrations loaded at startup</td><td>Zero network at startup. Open a repository, see the graph, in under a second</td></tr>
              <tr><td>A dialog for every action</td><td>Inline actions, keyboard first, undo instead of confirm</td></tr>
            </tbody>
          </table>
          <p>Two rules hold everywhere in the code: <b>the renderer never blocks</b> (all git work runs in the main process and crosses typed IPC), and <b>cost is proportional to what is on screen, not to repository size</b>. A benchmark on 100,000 commits enforces budgets for the first log page, the layout, first paint and scroll frame rate. <a href="./how-it-works/">How it works</a> has the details.</p>
        </section>

        <section className="section">
          <h2>Built in the open, and as a way to learn</h2>
          <p>GitGoose is Jesse Williamson's project, built with AI agents doing most of the typing while Jesse owns the design and writes the parts worth learning: the lane layout, the IPC contract, line staging, undo. The repository is the agents' memory: a brief, architecture decision records, a spec per feature, and exercises in <code>docs/learn/</code> for the pieces to build by hand.</p>
          <p>The page on <a href="./graphs/">drawing git graphs</a> is part of that: a comparison of how clients lay out commit graphs, with every figure a live run of the same lane walk GitGoose uses, drawn with <a href="https://github.com/JesseWilliamson/DiagramBuilder">dsviz</a>.</p>
        </section>
      </div>
    </Shell>
  )
}

mount(<Home />)
