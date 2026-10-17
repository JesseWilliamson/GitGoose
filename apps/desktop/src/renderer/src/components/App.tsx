import { useEffect } from 'react'
import { fetchAll, initRepo, newBranch, openRepoDialog, pop, pull, push, stash, undo } from '../lib/actions'
import { closeTab, onCommand, useActiveRepo, useStore } from '../lib/store'
import { CommandPalette } from './CommandPalette'
import { ConflictWizard } from './ConflictWizard'
import { DetailPanel } from './DetailPanel'
import { Dialogs, PromptDialog, Toasts } from './Dialogs'
import { FileView } from './DiffView'
import { Graph } from './Graph'
import { DropMenu } from './menus'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { TabBar } from './TabBar'
import { Toolbar } from './Toolbar'
import { Welcome } from './Welcome'

function isTyping(): boolean {
  const el = document.activeElement
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement | null)?.isContentEditable === true
}

/** Menu commands and shortcuts, in one place. Commands act on the active tab. */
function useCommands() {
  useEffect(() => {
    const handle = (name: string) => {
      const s = useStore.getState()
      const id = s.active
      switch (name) {
        case 'open-repo': return void openRepoDialog()
        case 'clone-repo': return useStore.setState({ dialog: { kind: 'clone' } })
        case 'init-repo': return void initRepo()
        case 'settings': return useStore.setState({ dialog: { kind: 'settings' } })
        case 'palette': return useStore.setState({ palette: !s.palette })
      }
      if (!id) return
      switch (name) {
        case 'undo':
          // Cmd+Z in a text field undoes typing; anywhere else it undoes the last git operation.
          if (isTyping()) document.execCommand('undo')
          else void undo(id)
          return
        case 'close-tab': return void closeTab(id)
        case 'fetch': return void fetchAll(id)
        case 'pull': return void pull(id)
        case 'push': return push(id)
        case 'new-branch': return newBranch(id)
        case 'stash': return stash(id)
        case 'pop': return pop(id)
        case 'reveal': return void window.gitsquid.revealPath(s.repos[id]!.snapshot.path)
      }
    }
    const off = onCommand(handle)
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        handle('palette')
      } else if (mod && /^[1-9]$/.test(e.key)) {
        const t = useStore.getState().tabs[Number(e.key) - 1]
        if (t) {
          e.preventDefault()
          useStore.setState({ active: t })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off()
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}

export function App() {
  useCommands()
  const view = useActiveRepo()
  const ready = useStore((s) => s.settings !== null)
  return (
    <div className="flex h-full flex-col">
      <TabBar />
      {!ready ? null : !view ? (
        <Welcome />
      ) : (
        <>
          <Toolbar view={view} />
          <div className="flex min-h-0 flex-1">
            <Sidebar view={view} />
            <main className="flex min-w-0 flex-1 flex-col">
              {view.center.kind === 'graph' && <Graph view={view} />}
              {view.center.kind === 'file' && <FileView view={view} target={view.center.target} mode={view.center.mode} />}
              {view.center.kind === 'conflicts' && <ConflictWizard view={view} />}
            </main>
            <DetailPanel view={view} />
          </div>
          <StatusBar view={view} />
        </>
      )}
      <CommandPalette />
      <Dialogs />
      <PromptDialog />
      <DropMenu />
      <Toasts />
    </div>
  )
}
