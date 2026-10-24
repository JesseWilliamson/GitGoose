/**
 * The figures on the "Drawing git graphs" page and the home page. Each is a small React component:
 * state in, a dsviz scene out, controls under it. The scenes come from @dsviz/git, which runs the
 * same first-parent lane walk GitGoose's graph does, so every picture is an algorithm's output,
 * not a drawing.
 */
import { useMemo, useState } from 'react'
import { combine, fitViewBox, rect, text, type Scene, type SceneNode } from '@dsviz/core'
import { array } from '@dsviz/ds'
import { gitLanes, graph, orderCommits, type Commit, type CommitOrder, type GitGraphOptions, type LaneStyle, type Ref } from '@dsviz/git'
import { Diagram, NumberStepper, Segmented, Slider, Switch, Transport, usePlayer } from '@dsviz/react'
import { Figure } from '../Layout'
import * as H from './histories'

type Bend = NonNullable<GitGraphOptions['bend']>
const BENDS = [{ value: 'curve', label: 'Curve' }, { value: 'corner', label: 'Corner' }, { value: 'angle', label: 'Angle' }] as const
const LANES = [{ value: 'straight', label: 'Straight' }, { value: 'compact', label: 'Compact' }] as const
const hashOf = (e: { node: { data?: unknown } }) => (e.node.data as { hash?: string } | undefined)?.hash

/** GitGoose's own graph: the trunk pinned left whatever is checked out, so a checkout does not reshuffle it. */
export function GooseGraph() {
  const [head, setHead] = useState<'main' | 'feature'>('feature')
  const { commits, refs, pin } = H.goose(head)
  const scene = graph(commits, refs, { pin, bend: 'corner', tones: H.LANE_TONES, rowH: 30 })
  return (
    <Figure title="The graph as GitGoose draws it" hint="switch branches: main stays in the left lane">
      <div className="figure-stage"><Diagram scene={scene} camera="fit" label="A commit graph in GitGoose's style, with main pinned to the left lane and the uncommitted changes as a dashed node above HEAD" /></div>
      <p className="status">
        {head === 'main'
          ? <>main is checked out: the dashed line from the uncommitted changes runs straight down the left lane to <b>main</b>.</>
          : <><b>search</b> is checked out: it gets the lane next to main, and the dashed line runs down that lane. main did not move.</>}
      </p>
      <div className="row">
        <Segmented label="Checked out" value={head} onChange={setHead} options={[{ value: 'main', label: 'main' }, { value: 'feature', label: 'search' }]} />
      </div>
    </Figure>
  )
}

/**
 * One row of the walk, for the step-through: the slot array after the row was placed, and a
 * sentence saying what the row did. Reconstructed from the walk's output: an edge whose child is
 * above the row and whose parent is below it is a slot still waiting.
 */
function walkFrames(commits: Commit[]) {
  const placed = gitLanes(commits)
  const slotsAfter = (row: number) => {
    const slots: { hash: string; color: number }[] = []
    for (const p of placed) {
      if (p.row > row) continue
      for (const e of p.edges) {
        if (e.row <= row) continue
        const lane = e.via[row - p.row] ?? e.lane
        slots[lane] = { hash: e.parent, color: e.color }
      }
    }
    return Array.from(slots, (s) => s ?? null)
  }
  return placed.map((p) => {
    const before = p.row ? slotsAfter(p.row - 1) : []
    const waiting = before.filter((s) => s?.hash === p.hash).length
    const parts: string[] = []
    parts.push(waiting
      ? `${waiting === 1 ? 'one slot was' : `${waiting} slots were`} waiting for ${p.hash}, so it lands in column ${p.lane}${waiting > 1 ? ' (the leftmost) and the others end here' : ''}`
      : `nothing was waiting for ${p.hash}: it is a branch tip and takes the first free column, ${p.lane}`)
    p.edges.forEach((e, k) => {
      if (k === 0) parts.push(`its first parent ${e.parent} inherits column ${e.lane}`)
      else parts.push(`its other parent ${e.parent} ${before[e.lane]?.hash === e.parent ? `joins the slot already waiting in column ${e.lane}` : `opens column ${e.lane}`}`)
    })
    return { row: p.row, hash: p.hash, slots: slotsAfter(p.row), text: parts.join('; ') + '.' }
  })
}

/** Step through the lane walk: the graph grows a row at a time, the slot array beside it says what each column waits for. */
export function LaneWalk() {
  const commits = H.walk
  const player = usePlayer(() => walkFrames(commits), [commits], { interval: 1400 })
  const full = useMemo(() => graph(commits, H.walkRefs, { tones: H.LANE_TONES, rowH: 30 }), [commits])
  const frame = player.frame!
  const scene = useMemo(() => {
    // rows placed so far are drawn in full; the rest are faint, so the eye reads the walk top-down
    const rowOf = (n: SceneNode) => {
      const m = /^git:(commit|halo|label|fold):(.+)$/.exec(n.id) ?? /^git:edge:([^-]+)-/.exec(n.id)
      const hash = m ? (m.length === 3 ? m[2] : m[1]) : null
      if (hash) return full.row(hash)
      const ref = /^git:ref:(.+?)(:label)?$/.exec(n.id)
      return ref ? full.row(H.walkRefs.find((r) => r.name === ref[1])!.hash) : -1
    }
    const faded = full.nodes.map((n) => (rowOf(n) > frame.row ? { ...n, opacity: 0.18 } : n))
    const slots = array(frame.slots.map((s) => s?.hash ?? '·'), {
      id: 'slots', x: full.labelX + 150, y: 6, cell: 34, gap: 4,
      keys: frame.slots.map((s, i) => s?.hash ?? `free-${i}`),
      tones: (i) => (frame.slots[i] ? H.LANE_TONES[frame.slots[i]!.color % 8] : 'ghost'),
      showIndices: true,
    })
    return combine(
      { nodes: faded },
      text({ id: 'slots:title', x: full.labelX + 150, y: -14, text: `slots after row ${frame.row}`, anchor: 'start', size: 12, tone: 'muted' }),
      slots,
    )
  }, [full, frame])
  const viewBox = useMemo(() => fitViewBox([full, rect({ id: 'room', x: full.labelX + 150 + 4 * 38, y: 20, w: 2, h: 2 })]), [full])
  return (
    <Figure title="The lane walk, one row at a time" hint="the same walk GitGoose's layout and @dsviz/git run">
      <div className="figure-stage"><Diagram scene={scene} viewBox={viewBox} label="A commit graph being laid out row by row, with the array of waiting slots shown beside it" /></div>
      <p className="status"><b>{frame.hash}</b>: {frame.text}</p>
      <Transport player={player} />
    </Figure>
  )
}

/** The report's figure: the same history with straight lanes (GitKraken) and compact lanes (Git Extensions). */
export function StraightVsCompact() {
  const [lanes, setLanes] = useState<LaneStyle>('compact')
  const [bend, setBend] = useState<Bend>('curve')
  const scene = graph(H.twoFeatures, H.twoFeaturesRefs, { lanes, bend, pin: ['M4'], rowH: 30 })
  return (
    <Figure title="Straight layouts never move a branch sideways" hint="the same eight commits, newest on top, main pinned left in both">
      <div className="figure-stage"><Diagram scene={scene} camera="fit" label="Two features off main; with compact lanes feature-b bends into the column feature-a frees, with straight lanes it keeps its column" /></div>
      <p className="status">
        {lanes === 'compact'
          ? <><b>Compact</b>, like Git Extensions: feature-a's column is removed at its fork point, so feature-b slides one column left and bends.</>
          : <><b>Straight</b>, like GitKraken: feature-a's column stays an empty slot after its fork, so feature-b keeps one column the whole way.</>}
      </p>
      <div className="row">
        <Segmented label="Lanes" value={lanes} onChange={setLanes} options={LANES} />
        <Segmented label="Bend" value={bend} onChange={setBend} options={BENDS} />
      </div>
    </Figure>
  )
}

/** Curves versus corners versus angles: the same lanes, three ways to draw a line changing column. */
export function Bends() {
  const [bend, setBend] = useState<Bend>('corner')
  const scene = graph(H.walk, H.walkRefs, { bend, rowH: 30 })
  return (
    <Figure title="Curves or corners" hint="a matter of taste; the lanes are identical">
      <div className="figure-stage"><Diagram scene={scene} camera="fit" label="A commit graph drawn with S-curves, rounded corners or straight diagonals where lines change column" /></div>
      <p className="status">
        {bend === 'curve' ? 'S-curves, as gitk, Sourcetree and Git Extensions draw them.' : bend === 'corner' ? 'A line leaves its node level with it and turns down with a small radius: GitKraken and GitGoose.' : 'Straight diagonals: VS Code Git Graph\'s angular option.'}
      </p>
      <div className="row"><Segmented label="Bend" value={bend} onChange={setBend} options={BENDS} /></div>
    </Figure>
  )
}

/** Dates lie after a rebase: author date puts a child below its parent; the topological sort never does. */
export function RowOrder() {
  const [order, setOrder] = useState<CommitOrder>('author-date')
  const commits = orderCommits(H.rebased, order)
  const scene = graph(commits, H.rebasedRefs, { rowH: 30, bend: 'corner' })
  const broken = commits.some((c, i) => c.parents.some((p) => commits.findIndex((x) => x.hash === p) < i))
  return (
    <Figure title="Ordering the rows" hint="feature was rebased onto main: old author dates, new commit dates">
      <div className="figure-stage"><Diagram scene={scene} camera="fit" label="Five commits ordered by author date, commit date or a topological sort; by author date the rebased commits sit below their parent and the lines go upwards" /></div>
      <p className="status">
        {order === 'author-date' && <><b>Author date</b>: F1 and F2 keep the dates they were written on, before M3. They sort below their parent and the edges run upwards, which the lane walk cannot lay out.</>}
        {order === 'commit-date' && <><b>Commit date</b>: the rebase gave F1 and F2 new commit dates, so here the order is right. It breaks instead when a parent's clock ran ahead of its child's.</>}
        {order === 'topo' && <><b>Temporal topological</b>: among the commits whose children are all placed, take the newest. Always valid, and equal to date order whenever dates are sane.</>}
        {broken && <> <span className="muted">(parent above child: broken)</span></>}
      </p>
      <div className="row">
        <Segmented label="Order by" value={order} onChange={setOrder} options={[{ value: 'author-date', label: 'Author date' }, { value: 'commit-date', label: 'Commit date' }, { value: 'topo', label: 'Topological' }]} />
      </div>
    </Figure>
  )
}

/** Column assignment: first-parent inheritance alone, or with main pinned to the left. */
export function PinMain() {
  const [pin, setPin] = useState(false)
  const scene = graph(H.lateMain, H.lateMainRefs, { pin: pin ? ['M3'] : [], rowH: 30, bend: 'corner' })
  return (
    <Figure title="Who gets the left column" hint="feature's tip is newer than main's">
      <div className="figure-stage"><Diagram scene={scene} camera="fit" label="A feature whose newest commit is above main's; without pinning the feature takes the left column, with pinning main does" /></div>
      <p className="status">
        {pin
          ? <>main's column is <b>held</b> from the top: feature finds it taken and runs beside it. The line to M3 is a held slot, not an edge, so nothing is drawn above the tip.</>
          : <>By first-parent inheritance alone, the first tip in the list takes column 0: <b>feature</b>, because its tip is newer. main lands wherever is free.</>}
      </p>
      <div className="row"><Switch label="Pin main to the left" checked={pin} onChange={setPin} /></div>
    </Figure>
  )
}

/** GitGoose's cost of reserving a column, and the hint from git that pays it back. */
export function OnTop() {
  const [hint, setHint] = useState(false)
  const scene = graph(H.onTop, H.onTopRefs, { pin: [hint ? 'Z' : 'B'], rowH: 30, bend: 'corner' })
  return (
    <Figure title="A branch on top of main" hint="the price of a reserved column, and how GitGoose pays it">
      <div className="figure-stage"><Diagram scene={scene} camera="fit" label="topic sits straight on main's tip; with only main pinned topic opens a second column and curves in, with git's hint it continues main's line" /></div>
      <p className="status">
        {hint
          ? <>git says topic's first-parent line reaches main's tip, so the layout lets <b>topic continue main's column</b>: one straight line, as Tower draws it.</>
          : <>topic's tip arrives before main's while column 0 is held, so it opens a column to the right and <b>curves back in</b> at B. The walk streams; when Z arrives it cannot know its line will reach B.</>}
      </p>
      <div className="row"><Switch label="Use git's straight-tip hint" checked={hint} onChange={setHint} /></div>
    </Figure>
  )
}

/** The report's "taming a wide graph" figure: all lanes, merges folded, or a lane cap. */
export function ManyBranches() {
  const [mode, setMode] = useState<'all' | 'fold' | 'cap'>('all')
  const [fold, setFold] = useState<string[]>(H.wideMerges)
  const [cap, setCap] = useState(3)
  const opts: GitGraphOptions = { rowH: 28, pin: ['M9'], interactive: true, bend: 'corner' }
  const scene = mode === 'fold' ? graph(H.wide, H.wideRefs, { ...opts, fold }) : mode === 'cap' ? graph(H.wide, H.wideRefs, { ...opts, maxLanes: cap }) : graph(H.wide, H.wideRefs, opts)
  const toggle = (hash: string) => setFold(fold.includes(hash) ? fold.filter((h) => h !== hash) : [...fold, hash])
  return (
    <Figure title="Folding and capping trade detail for width" hint="four features merged into main">
      <div className="figure-stage">
        <Diagram scene={scene} camera="fit" label="Four merged features drawn with every lane, with the merges folded into hollow dots, or with a lane cap marking cut lanes with a tilde"
          onClick={(e) => { const h = hashOf(e); if (mode === 'fold' && h && H.wideMerges.includes(h)) toggle(h) }} />
      </div>
      <p className="status">
        {mode === 'all' && <><b>Everything shown</b>: {scene.lanes} lanes for four branches, and every merge edge crosses the lanes between.</>}
        {mode === 'fold' && <><b>Merges folded</b>, Sublime Merge's default: a hollow dot stands for the whole branch. Click one to unfold it. {fold.length ? `${H.wide.length - scene.rows.length} commits hidden.` : 'Nothing is folded.'}</>}
        {mode === 'cap' && <><b>Lane cap of {cap}</b>, like <code>git log --graph-lane-limit={cap}</code>: lanes past the cap are not drawn, and a <code>~</code> marks each row they cross.</>}
      </p>
      <div className="row">
        <Segmented label="Show" value={mode} onChange={setMode} options={[{ value: 'all', label: 'Everything' }, { value: 'fold', label: 'Merges folded' }, { value: 'cap', label: 'Lane cap' }]} />
        {mode === 'cap' && <NumberStepper label="Cap" value={cap} onChange={setCap} min={1} max={5} />}
      </div>
    </Figure>
  )
}

/** Only the rows in the viewport are rendered: the rest of the history is faint. */
export function Viewport() {
  const commits = useMemo(() => H.tall(30), [])
  const full = useMemo(() => graph(commits, [], { rowH: 22, laneW: 18, r: 4, pin: ['M30'], bend: 'corner' }), [commits])
  const rows = full.rows.length
  const window = 9
  const [top, setTop] = useState(6)
  const scene: Scene = useMemo(() => {
    const inView = new Set(full.rows.slice(top, top + window))
    const g = graph(commits, [], { rowH: 22, laneW: 18, r: 4, pin: ['M30'], bend: 'corner', highlight: inView })
    const y = top * 22, h = window * 22
    return combine(
      rect({ id: 'viewport', x: (full.labelX + 90) / 2, y: y + h / 2, w: full.labelX + 90, h, rx: 6, role: 'zone', tone: 'accent' }),
      text({ id: 'viewport:label', x: full.labelX + 100, y: y + 10, text: `viewport: rows ${top} to ${top + window - 1}`, anchor: 'start', size: 12, tone: 'accent' }),
      text({ id: 'viewport:note', x: full.labelX + 100, y: y + 28, text: `${window} rows in the DOM, ${rows - window} not`, anchor: 'start', size: 12, tone: 'muted' }),
      g,
    )
  }, [commits, full, top])
  const viewBox = useMemo(() => fitViewBox([full, rect({ id: 'room', x: full.labelX + 230, y: 0, w: 2, h: 2 })]), [full])
  return (
    <Figure title="Render only what is on screen" hint="cost follows the viewport, not the history">
      <div className="figure-stage"><Diagram scene={scene} viewBox={viewBox} label="A long commit graph with a viewport box over nine rows; only those rows are drawn in full" /></div>
      <p className="status">Rows outside the box are not in the DOM at all. GitGoose keeps about forty row elements alive for any history, and the layout is a per-row record, so a row can be drawn without looking at its neighbours.</p>
      <Slider label="Scroll" value={top} onChange={setTop} min={0} max={rows - window} />
    </Figure>
  )
}
