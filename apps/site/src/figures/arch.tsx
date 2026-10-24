/** Figures for the "How it works" page: the process model and the log pipeline. */
import { useState } from 'react'
import { architecture } from '@dsviz/arch'
import { sequence } from '@dsviz/uml'
import { Diagram, Transport, usePlayer } from '@dsviz/react'
import { Figure } from '../Layout'

/** Electron's three processes and what crosses between them. Boxes are placed by the layered layout. */
export function ProcessModel() {
  const [picked, setPicked] = useState<string | null>(null)
  const scene = architecture(
    [
      // placed by hand: three rows, one process per zone, so the zones do not overlap
      { id: 'ui', kind: 'client', label: 'React UI', sub: 'graph, diffs, panes', x: 70, y: 60 },
      { id: 'bridge', kind: 'gateway', label: 'Preload bridge', sub: 'window.gitgoose', x: 230, y: 60 },
      { id: 'ipc', kind: 'service', label: 'IPC router', sub: 'typed, one handler per method', x: 420, y: 60 },
      { id: 'repo', kind: 'service', label: 'RepoManager', sub: 'snapshots, undo journal', x: 600, y: 60 },
      { id: 'runner', kind: 'service', label: 'GitRunner', sub: 'spawn, parse -z output', x: 770, y: 60 },
      { id: 'watcher', kind: 'service', label: 'File watcher', sub: '.git and the worktree', x: 420, y: 150 },
      { id: 'git', kind: 'file', label: 'git', sub: "the user's own binary", x: 940, y: 60 },
      { id: 'indexer', kind: 'service', label: 'Code indexer', sub: 'tree-sitter', x: 600, y: 270 },
      { id: 'db', kind: 'db', label: 'Code graph', sub: 'SQLite', x: 790, y: 270 },
    ],
    [
      { from: 'ui', to: 'bridge', label: 'calls', both: true },
      { from: 'bridge', to: 'ipc', label: 'IPC', both: true },
      { from: 'ipc', to: 'repo' },
      { from: 'repo', to: 'runner' },
      { from: 'runner', to: 'git', label: 'spawn' },
      { from: 'watcher', to: 'repo', label: 'changed', dashed: true },
      { from: 'repo', to: 'indexer', label: 'blob ids', dashed: true },
      { from: 'indexer', to: 'db' },
    ],
    {
      route: 'elbow',
      interactive: true,
      zones: [
        { id: 'renderer', label: 'Renderer process', around: ['ui', 'bridge'], tone: 'accent' },
        { id: 'main', label: 'Main process', around: ['ipc', 'repo', 'runner', 'watcher'], tone: 'success' },
        { id: 'utility', label: 'Utility process', around: ['indexer', 'db'], tone: 'visited' },
      ],
    },
  )
  const notes: Record<string, string> = {
    ui: 'React with a zustand store. The log lives in plain arrays outside React state; rows are virtualized, so about forty exist at a time.',
    bridge: 'The only bridge: contextIsolation on, nodeIntegration off. It builds window.gitgoose from the list of API methods in packages/shared.',
    ipc: 'Every method in the GitGooseApi type needs a handler here, or the build fails. Methods that write mark the repository dirty so the UI gets a fresh snapshot at once.',
    repo: 'One Repo per open repository: it serialises writes, records undo entries, and publishes snapshots (refs, HEAD, status) to the renderer.',
    runner: 'All git goes through GitRunner: fixed environment, NUL-separated plumbing formats only, never human-readable output.',
    watcher: 'Watches .git and the worktree, debounced; held back while one of our own writes runs so a rebase is seen only where it ends.',
    git: "The user's installed git: credential helpers, SSH agent, hooks, LFS and signing all keep working, with no native module to rebuild.",
    indexer: 'Parses files with tree-sitter grammars in a utility process, so a big index never stalls the window.',
    db: 'A per-repository SQLite graph of definitions and references, keyed by blob id so unchanged files are never re-parsed.',
  }
  return (
    <Figure title="Three processes" hint="click a box">
      <div className="figure-stage"><Diagram scene={scene} camera="fit" label="GitGoose's renderer, main and utility processes and the links between them" onClick={(e) => { const c = (e.node.data as { component?: string } | undefined)?.component; if (c) setPicked(c) }} /></div>
      <p className="status">{picked ? notes[picked] : 'The renderer never runs git and never blocks: every command runs in the main process and its result crosses typed IPC.'}</p>
    </Figure>
  )
}

/** How the first screenful appears before git has finished printing the log. */
export function LogPipeline() {
  const participants = [
    { id: 'ui', label: 'Renderer' },
    { id: 'main', label: 'Main process' },
    { id: 'git', label: 'git log' },
  ]
  const messages = [
    { from: 'ui', to: 'main', label: 'open repository' },
    { from: 'main', to: 'git', label: 'spawn: --date-order -z, streamed' },
    { from: 'git', to: 'main', label: 'first records', kind: 'return' as const },
    { from: 'main', to: 'ui', label: 'page 1 (300 commits)', kind: 'return' as const },
    { from: 'ui', to: 'ui', label: 'layout.push(page), paint visible rows' },
    { from: 'git', to: 'main', label: 'keeps printing', kind: 'async' as const },
    { from: 'ui', to: 'main', label: 'next page (user scrolls)' },
    { from: 'main', to: 'ui', label: 'page 2, from the buffer', kind: 'return' as const },
    { from: 'ui', to: 'ui', label: 'layout.push(page): page 1 unchanged' },
  ]
  const notes = [
    'Opening a repository asks the main process for the log.',
    'One git process prints the whole history as NUL-separated records. Main parses as it streams.',
    'Main does not wait for git to finish.',
    'The first page is on its way as soon as 300 records are parsed.',
    'The renderer lays the page out and paints the rows on screen. On a 100k-commit history this is about half a second from launch.',
    'git keeps printing into a buffer in the main process.',
    'Near the end of the loaded rows the renderer asks for more.',
    'The next page is already parsed.',
    'Because the layout carries all its state forward, page 2 appends without touching page 1.',
  ]
  const player = usePlayer(() => messages.map((_, i) => i), [], { interval: 1500 })
  const step = player.frame ?? 0
  return (
    <Figure title="The log streams" hint="first screenful first">
      <div className="figure-stage"><Diagram scene={sequence(participants, messages, { upTo: step, gap: 200 })} camera="fit" label="A sequence diagram: the renderer asks the main process for the log, git streams it, and pages arrive while git is still printing" /></div>
      <p className="status">{notes[step]}</p>
      <Transport player={player} />
    </Figure>
  )
}
