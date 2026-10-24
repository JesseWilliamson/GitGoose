import { GITHUB, mount, Section, Shell, Toc } from '../Layout'
import { Bends, LaneWalk, ManyBranches, OnTop, PinMain, RowOrder, StraightVsCompact, Viewport } from '../figures/git'

const toc = [
  ['summary', 'Summary'],
  ['products', 'The products'],
  ['walk', 'The lane walk'],
  ['straight', 'Straight vs curved'],
  ['order', 'Ordering rows'],
  ['columns', 'Assigning columns'],
  ['many', 'Handling many branches'],
  ['taste', 'What looks best'],
  ['recipe', 'If you build one'],
  ['gitgoose', 'What GitGoose does'],
  ['sources', 'Sources'],
] as const

const products: [string, string, string, string, string][] = [
  ['GitKraken', 'https://www.gitkraken.com/', 'Desktop GUI', 'Fully straight', 'Solo/hide, Smart Branch Visibility, pin a branch to the left'],
  ['Sublime Merge', 'https://www.sublimemerge.com/', 'Desktop GUI', 'Not in the comparison', 'Merge commits folded by default; hide branches from the location bar'],
  ['Fork', 'https://git-fork.com/', 'Desktop GUI', 'Not in the comparison', 'Collapse and expand merges (click the tip or arrow keys)'],
  ['Sourcetree', 'https://www.sourcetreeapp.com/', 'Desktop GUI', 'Mostly straight, sometimes curves', 'All vs current branch toggle; per-branch mute'],
  ['Git Extensions, SmartGit', 'https://gitextensions.github.io/', 'Desktop GUI', 'Very curved', 'Branch filtering'],
  ['gitk, git log --graph', 'https://git-scm.com/docs/git-log', 'Built into git', 'Curved, compact (reorders commits)', 'New --graph-lane-limit cap'],
  ['VS Code Git Graph', 'https://marketplace.visualstudio.com/items?itemName=mhutchie.git-graph', 'Editor extension', 'Rounded or angular', 'Show current branch only; loads 300 commits, then 100 more'],
  ['git-graph', 'https://github.com/mlange-42/git-graph', 'CLI', 'Straight, role-ordered', 'Branch roles decide column order'],
  ['Jujutsu (jj log)', 'https://jj-vcs.github.io/jj/latest/', 'Alternative VCS', 'Text graph, subset only', 'Shows a subset; gaps become "(elided revisions)" nodes'],
]

const sources: [string, string | null][] = [
  ['Commit Graph Drawing Algorithms, Pierre Vigier', 'https://pvigier.github.io/2019/05/06/commit-graph-drawing-algorithms.html'],
  ['git-graph repository and GitGraph docs', 'https://github.com/mlange-42/git-graph'],
  ['GitKraken Desktop 11.10 blog post and release notes', null],
  ['GitKraken: hide branches feedback thread', null],
  ['Sourcetree: mute and solo branches request', null],
  ['Sublime Merge Dev Build 1067', null],
  ['Sublime Merge: hide merge commits suggestion', null],
  ['Fork: Collapsible git graph, and the collapse-all-merges request', null],
  ['git --graph-lane-limit changes', 'https://git-scm.com/docs/git-log'],
  ['jj-log manual', 'https://jj-vcs.github.io/jj/latest/cli-reference/#jj-log'],
  ['neo-git-graph configuration and display settings', null],
  ['gitkraft-core lane layout source', null],
  ['Ideas for improvements to git log --graph (gist)', null],
  ['SourceGit: merge graph lanes request', null],
  ['r/neovim Git Graph discussion', null],
  ['OpenReplay: The Best Git UIs', null],
]

function Graphs() {
  return (
    <Shell page="graphs" root="../">
      <div className="doc-layout">
        <Toc items={toc} />
        <div className="doc-main">
          <h1>Drawing git graphs</h1>
          <p className="lede">How commit graphs handle many branches. There is no standard way to draw one: tools differ on two choices, how they <b>order rows</b> (which commit goes above which) and how they <b>assign columns</b> (which lane each branch runs in). Every figure here is a live run of a lane layout on a small history, so the controls change the algorithm, not a drawing.</p>

          <Section id="summary" title="Summary">
            <ul>
              <li><b>Straight lanes</b> (each branch keeps one column) are the most-praised look; GitKraken is the reference example.</li>
              <li><b>Nobody shows everything at scale.</b> Every serious tool hides branches somehow: solo/hide toggles, auto-focus on your branch, folding merged branches, or a hard cap on lanes.</li>
              <li><b>Main on the left</b> with a stable colour is the near-universal wish, now supported by pinning (GitKraken) and branch roles (git-graph).</li>
              <li><b>Core git caught up in 2026:</b> <code>git log --graph --graph-lane-limit=&lt;n&gt;</code> caps the lane count and marks the overflow with <code>~</code>.</li>
            </ul>
            <p className="small">The diagrams are illustrations drawn for this page, not screenshots of the products.</p>
          </Section>

          <Section id="products" title="The products">
            <p>The tools split by lane style and by how they cope when branches pile up.</p>
            <table className="products">
              <thead><tr><th>Tool</th><th>Type</th><th>Lane style</th><th>Main tactic for many branches</th></tr></thead>
              <tbody>
                {products.map(([name, url, type, lanes, tactic]) => (
                  <tr key={name}><td><a href={url}>{name}</a></td><td>{type}</td><td>{lanes}</td><td>{tactic}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="small">Lane styles for GitKraken, Sourcetree, Git Extensions, SmartGit and gitk come from Pierre Vigier's side-by-side comparison of the same repository.</p>
          </Section>

          <Section id="walk" title="The lane walk">
            <p>Almost every tool runs the same core algorithm, the one gitk and GitUp use and that GitGoose's layout package implements. Walk the commits newest to oldest, keeping an array of <b>slots</b>: slot <i>i</i> holds the hash the line in column <i>i</i> is travelling down to meet. For each commit:</p>
            <ol>
              <li>Every slot waiting for it ends here. The leftmost becomes its column. If none waits, it is a branch tip: it takes a free column.</li>
              <li>Its <b>first parent</b> inherits its column, so a branch's own history runs straight down. This is git's own idea of "the branch": what <code>--first-parent</code> follows and what a rebase replays.</li>
              <li>Each further parent (a merge) joins a slot already waiting for that parent, or opens a new one.</li>
            </ol>
            <LaneWalk />
            <p>Everything else on this page is a variation on what happens to the array when a slot opens or closes. Because the array is the only state, the walk is incremental: lay out the first page, keep the array, push the next page later, and nothing above changes. That is what lets GitGoose show the first screenful of a 100,000-commit history before git has finished printing it.</p>
          </Section>

          <Section id="straight" title="Straight vs curved branches">
            <p>The biggest visual difference between tools is whether a branch stays in one column. Both styles walk the rows keeping the same array; they differ in what happens when a slot opens or closes.</p>
            <StraightVsCompact />
            <ul>
              <li><b>Curved (compact):</b> finished slots are removed and new ones are inserted next to the merge that opens them, so every column to the right shifts sideways.</li>
              <li><b>Straight:</b> a finished slot becomes an empty one, and new branches only reuse an empty slot or append, so nothing else moves.</li>
              <li><b>The catch for straight lanes:</b> "forbidden columns". An empty slot cannot be reused if a merge edge drawn into it would cross another commit or lane, so Vigier's layout checks the column range first. A per-row walk like the one above cannot know the range ahead of time; it takes the leftmost free slot and accepts the crossing, which is why the merge edge in the "everything shown" picture below cuts across its neighbours.</li>
            </ul>
            <p>In Vigier's comparison, GitKraken is fully straight, Sourcetree mostly straight, and Git Extensions, SmartGit and gitk curved.</p>
            <Bends />
          </Section>

          <Section id="order" title="Ordering rows and columns">
            <p>Rows must be <b>topological</b> (every parent below its child); columns are usually decided by <b>first-parent inheritance</b>, optionally overridden by branch roles.</p>
            <h3>Rows, top to bottom</h3>
            <RowOrder />
            <ol>
              <li><b>Author date</b> breaks after rebase and cherry-pick, which can put older-dated commits on top of newer ones.</li>
              <li><b>Committer date</b> works most of the time, but clock skew or hand-set dates can put a child above its parent. Vigier suspects GitKraken sorts this way, since it drew one of his repositories wrong.</li>
              <li><b>Temporal topological sort</b> (his fix): a depth-first topological sort that visits commits newest-first by committer date. It is always valid, always gives the same result, and equals date order whenever dates are sane. Cost: O(n log n + m). This is also what <code>git log --date-order</code> does, which is why GitGoose asks git for the order and never sorts itself.</li>
            </ol>
          </Section>

          <Section id="columns" title="Assigning columns">
            <h3>Columns, left to right</h3>
            <PinMain />
            <ul>
              <li><b>Default:</b> a commit's first parent inherits its lane; extra merge parents get new lanes. Some implementations colour per lane rather than per commit, so a straight run keeps one colour.</li>
              <li><b>Branch roles:</b> git-graph gives each branch a regex-configured "persistence", like a z-order. Branches claim commits in that order, following first parents until they hit an already-claimed commit. Its GitFlow model makes main, master and trunk the most persistent. It then packs branches into columns by lifespan, shortest-first or longest-first.</li>
              <li><b>Manual pinning:</b> GitKraken 11.10 (March 2026) lets you pin any branch to the left edge.</li>
              <li><b>The old wish:</b> a 2012-era proposal asked <code>git log</code> for a <code>--force-branch-columns=master,dev</code> flag to fix chosen branches to the leftmost columns.</li>
            </ul>
            <p>Pinning is a reserved column, and a reserved column has a cost the walk cannot see on its own. GitGoose holds lane 0 for the main line so that a checkout never reshuffles the graph; a branch sitting on top of main then has its tip arrive <i>before</i> main's tip, while the column is still held.</p>
            <OnTop />
            <p>The walk streams, so when the topic's tip arrives nobody knows whether its line will reach main. Git does know: one <code>for-each-ref</code> with <code>%(ahead-behind:…)</code> and a bounded first-parent check lists the tips whose own line runs straight down to the trunk, and the layout lets those continue the reserved column. The alternative, renaming a lane retroactively when main's tip arrives with one incoming line, would edit rows already on screen and break the rule that pushing page 2 never changes page 1.</p>
          </Section>

          <Section id="many" title="Handling many branches">
            <p>Every tool cuts something once branches pile up. They differ in whether you choose what goes, the tool chooses, or a hard limit does.</p>
            <ManyBranches />
            <table className="products">
              <thead><tr><th>Strategy</th><th>Who decides what is hidden</th><th>Examples</th></tr></thead>
              <tbody>
                <tr><td>Solo / hide toggles</td><td>You, per branch</td><td>GitKraken solo; Sublime Merge hide from location bar; GitGoose hide and solo</td></tr>
                <tr><td>Auto-focus</td><td>The tool, from your checkout</td><td>GitKraken Smart Branch Visibility: current branch, its merge target, their upstreams</td></tr>
                <tr><td>Current branch only</td><td>A setting</td><td>VS Code Git Graph <code>showCurrentBranchByDefault</code>; GitGoose's line view (Ctrl/Cmd+L)</td></tr>
                <tr><td>Fold merges</td><td>You expand on demand</td><td>Sublime Merge (default, first parent only); Fork (click tip or arrow keys)</td></tr>
                <tr><td>Lane cap</td><td>A number</td><td>git <code>--graph-lane-limit=&lt;n&gt;</code>, overflow shown as <code>~</code>; GitGoose clips past eight lanes</td></tr>
                <tr><td>Revision subset</td><td>A query</td><td>jj log: mutable revisions plus context; gaps become "(elided revisions)"</td></tr>
                <tr><td>Lazy loading</td><td>Scroll position</td><td>VS Code Git Graph loads 300 commits, then 100 per "Load More"; GitGoose pages as you scroll</td></tr>
              </tbody>
            </table>
            <p>Sublime Merge's developers say folding turns the git repository's own history from a huge tangle into a clean, drillable line. Fork demonstrates the same on the Swift repository, which has over 100,000 commits.</p>
          </Section>

          <Section id="taste" title="What people think looks best">
            <p>Straight lanes, a pinned main branch, and no idle lines are what people ask for most.</p>
            <ul>
              <li><b>Straight lanes win among enthusiasts.</b> Vigier calls lane style a matter of taste but found straight branches much more readable. Builders of Neovim graph plugins ask for the same. Reviewers single out GitKraken's graph as one of the clearest for complex histories.</li>
              <li><b>Idle lanes are the top complaint.</b> When too many branch tails pile up, they become impossible to trace and form what one writer calls an ugly "mountain". A SourceGit request asks for a lane to appear only when its branch's first commit does.</li>
              <li><b>Folding is loved.</b> Fork users call collapse-all-merges a top reason to prefer it. Some Sublime Merge users want the reverse: hide merge commits and keep the real commits.</li>
              <li><b>Hiding must be one click away.</b> GitKraken users still want right-click "hide" in the graph itself, not hunting in the sidebar.</li>
              <li><b>Curves vs corners</b> is personal preference. VS Code Git Graph defaults to rounded transitions with an angular option.</li>
              <li><b>git-graph's own pitch</b> shows its role-ordered graph next to other clients on a GitFlow repository and invites you to decide which is most comprehensible.</li>
            </ul>
          </Section>

          <Section id="recipe" title="If you build one: a recipe">
            <p>Combine the best ideas above in this order.</p>
            <ol className="steps">
              <li><b>Sort rows</b> with a temporal topological sort, so the result is always valid and still reads newest-first.</li>
              <li><b>Assign lanes straight:</b> finished lanes become empty slots instead of being removed, and new branches reuse an empty slot or append. Before placing a merge parent, skip forbidden columns where its edge would cross another commit or lane.</li>
              <li><b>Pin main to column 0</b> with a fixed colour; order the remaining lanes by branch role, then by lifespan.</li>
              <li><b>Fold merged branches by default</b>, expandable by clicking the merge dot.</li>
              <li><b>Cap visible lanes</b> and show a marker (like git's <code>~</code>) for anything cut.</li>
              <li><b>Render only visible rows and edges.</b> Vigier finds the edges crossing the viewport with an interval tree; this cut his render time from 106 ms to under 1 ms on a large repository.</li>
            </ol>
            <Viewport />
            <p className="note">To self-test step 2: why does removing a finished lane make branches curve? (Answer: every lane to its right shifts one column left.)</p>
          </Section>

          <Section id="gitgoose" title="What GitGoose does, and what changes next">
            <p>Today GitGoose has steps 1, 3 (for main only, with the straight-tip hint above) and 6, straight lanes without the forbidden-column check, hide and solo per branch, a line view that shows one branch, and a clip rather than a marker past eight lanes. It has no folding.</p>
            <p>The <a href={`${GITHUB}/blob/main/docs/PLAN-6-graph.md`}>graph redesign plan</a> takes the rest in order: a lane cap with git's marker instead of a silent clip, pinning any branch, merged branches folded with a click to unfold (which needs the incremental layout to restart from a checkpoint below the merge), a nearest-free-slot rule to reduce crossings, and a measured experiment with one SVG per viewport instead of one per row so edges can curve across rows. Every step keeps the two rules the app is built on: the renderer never blocks, and the cost follows what is on screen.</p>
            <p>The figures on this page are drawn with <a href="https://github.com/JesseWilliamson/DiagramBuilder">dsviz</a>, whose <code>@dsviz/git</code> package runs the same walk with these layouts as options. It is the playground: a layout is tried here first, on a history small enough to read, then ported to the app with the fixture shapes as tests.</p>
          </Section>

          <Section id="sources" title="Sources">
            <ul className="sources">
              {sources.map(([title, url]) => <li key={title}>{url ? <a href={url}>{title}</a> : title}</li>)}
            </ul>
            <p className="small">The report this page is based on, <i>Git Tree Views: How Commit Graphs Handle Many Branches</i> (October 2026), has the links for every source.</p>
          </Section>
        </div>
      </div>
    </Shell>
  )
}

mount(<Graphs />)
