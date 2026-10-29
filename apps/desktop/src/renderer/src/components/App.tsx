import { DEFAULT_LAYOUT, wideGraph, type Settings } from '@gitgoose/shared'
import { useEffect } from 'react'
import { applyPatchFile, applyPatchFromClipboard, reviewBranch, fetchAll, initRepo, newBranch, openRepoDialog, openTerminal, pop, pull, push, redo, showHistory, showWorkingCopy, stash, undo } from '../lib/actions'
import { comboOf, keymap } from '../lib/keys'
import { goBack, goForward, installMouseNavigation, installNavigation } from '../lib/navigation'
import { sonnerPresenter } from '../lib/toasts'
import { closeTab, setToastPresenter, onCommand, runCommand, updateRepo, saveSettings, setting, toggleLine, useActiveRepo, useStore } from '../lib/store'
import { AttentionBar } from './AttentionBar'
import { OmniSearch } from './OmniSearch'
import { Dialogs, PromptDialog } from './Dialogs'
import { CheckoutMenu } from './menus'
import { DragBadge } from './DragBadge'
import { SettingsPage } from './SettingsPage'
import { AiDialogs } from './AiDialogs'
import { StatusBar } from './StatusBar'
import { TabBar } from './TabBar'
import { Toolbar } from './Toolbar'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Welcome } from './Welcome'
import { togglePane } from '../lib/panes'
import { Workspace } from './Workspace'
import { toggleChat } from '../lib/thread'
import { readSelection, SCENES, setFace, setScene, type Scene } from '../lib/scenes'

setToastPresenter(sonnerPresenter)

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
        case 'settings': return useStore.setState({ page: s.page === 'settings' ? null : 'settings' })
        case 'palette': return useStore.setState({ omni: s.omni ? null : { query: '> ' } })
        case 'search': return useStore.setState({ omni: { query: '' } })
        case 'zoom-in': return void saveSettings({ uiScale: setting('uiScale') + 0.1 })
        case 'zoom-out': return void saveSettings({ uiScale: setting('uiScale') - 0.1 })
        case 'zoom-reset': return void saveSettings({ uiScale: 1 })
        case 'commit-order-date': return void saveSettings({ commitOrder: 'date' })
        case 'commit-order-topo': return void saveSettings({ commitOrder: 'topo' })
        case 'sidebar-tags-50': case 'sidebar-tags-100': case 'sidebar-tags-250': case 'sidebar-tags-all':
          return void saveSettings({ sidebarTags: name.slice('sidebar-tags-'.length) as Settings['sidebarTags'] })
        case 'toggle-sidebar': return togglePane('branches')
        case 'toggle-details': return togglePane('details')
        // The View menu's checkbox: show or hide, unlike the key, which also focuses.
        case 'toggle-ai-pane': {
          const v = id ? s.repos[id] : undefined
          if (v && v.scene !== 'browse') return setFace(v.id, v.read.face === 'ai' ? 'around' : 'ai')
          return togglePane('ai')
        }
        case 'layout-default': return void saveSettings({ layout: structuredClone(DEFAULT_LAYOUT) })
        case 'layout-wide-graph': return void saveSettings({ layout: wideGraph(setting('layout')) })
        case 'scene-browse': case 'scene-read': case 'scene-changes': case 'scene-resolve': {
          const scene = name.slice('scene-'.length) as Scene
          if (!id) return
          if (scene === 'read' && s.repos[id]?.scene !== 'read') return readSelection(id)
          return setScene(id, scene)
        }
        case 'branch-table': {
          if (!id) return
          const v = s.repos[id]!
          if (v.scene !== 'browse') setScene(id, 'browse')
          return updateRepo(id, { branchTable: !(v.scene === 'browse' && v.branchTable), center: { kind: 'graph' } })
        }
        case 'back': return goBack()
        case 'forward': return goForward()
      }
      if (!id) return
      switch (name) {
        case 'undo':
          // From the menu: in a text field undo typing; anywhere else undo the last git operation.
          if (isTyping()) document.execCommand('undo')
          else void undo(id)
          return
        case 'redo':
          if (isTyping()) document.execCommand('redo')
          else void redo(id)
          return
        case 'close-tab': return void closeTab(id)
        case 'fetch': return void fetchAll(id)
        case 'pull': return void pull(id)
        case 'push': return push(id)
        case 'new-branch': return newBranch(id)
        case 'stash': return stash(id)
        case 'pop': return pop(id)
        case 'reveal': return void window.gitgoose.revealPath(s.repos[id]!.snapshot.path)
        case 'terminal': return void openTerminal(id)
        case 'apply-patch': return void applyPatchFile(id)
        case 'apply-patch-clipboard': return void applyPatchFromClipboard(id)
        case 'reflog': return updateRepo(id, { center: { kind: 'reflog' } })
        case 'command-log': return updateRepo(id, { center: { kind: 'commands' } })
        case 'line-view': return toggleLine(id)
        case 'ai-chat': {
          // In a reading scene the AI is the left column's other face; in Browse, its pane.
          const v = s.repos[id]
          if (v && v.scene !== 'browse') return setFace(id, v.read.face === 'ai' ? 'around' : 'ai')
          return toggleChat()
        }
        // Workspace items (the sidebar handles Stashes, Pull Requests and the current branch itself).
        case 'ws-working-copy': return showWorkingCopy(id)
        case 'ws-history': return showHistory(id)
        case 'ws-reflog': return updateRepo(id, { center: { kind: 'reflog' } })
      }
    }
    const off = onCommand(handle)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useStore.getState().page && !useStore.getState().dialog && !useStore.getState().omni) {
        useStore.setState({ page: null })
        return
      }
      // 1–4 switch scenes (ADR-012), when nothing else has the keyboard.
      if (/^[1-4]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping() && !useStore.getState().dialog && !useStore.getState().omni && !useStore.getState().page) {
        const id = useStore.getState().active
        const scene = SCENES[Number(e.key) - 1]!
        if (id) {
          e.preventDefault()
          if (scene === 'read' && useStore.getState().repos[id]?.scene !== 'read') readSelection(id)
          else setScene(id, scene)
        }
        return
      }
      // Space in Browse reads the selection, when focus is nowhere in particular (the graph's
      // own list handles it while it has focus; a button with focus would click).
      if (e.key === ' ' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (document.activeElement === document.body || document.activeElement === null)
        && !useStore.getState().dialog && !useStore.getState().omni && !useStore.getState().page) {
        const id = useStore.getState().active
        if (id && useStore.getState().repos[id]?.scene === 'browse') {
          e.preventDefault()
          readSelection(id)
          return
        }
      }
      // B in Browse: the branch table beside the graph.
      if (e.key === 'b' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping() && !useStore.getState().dialog && !useStore.getState().omni && !useStore.getState().page) {
        const v = useStore.getState().repos[useStore.getState().active ?? '']
        if (v?.scene === 'browse') {
          e.preventDefault()
          return runCommand('branch-table')
        }
      }
      // R in Browse: review the current branch in Read.
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping() && !useStore.getState().dialog && !useStore.getState().omni && !useStore.getState().page) {
        const v = useStore.getState().repos[useStore.getState().active ?? '']
        const ref = v && v.scene === 'browse' && v.snapshot.head.branch ? v.snapshot.refs.find((x) => x.name === `refs/heads/${v.snapshot.head.branch}`) : undefined
        if (v && ref) {
          e.preventDefault()
          void reviewBranch(v.id, ref)
          return
        }
      }
      if (e.key === '?' && !isTyping() && !useStore.getState().dialog) {
        e.preventDefault()
        useStore.setState({ dialog: { kind: 'shortcuts' } })
        return
      }
      const combo = comboOf(e)
      if (!combo) return
      const tab = /^mod\+([1-9])$/.exec(combo)
      if (tab) {
        const t = useStore.getState().tabs[Number(tab[1]) - 1]
        if (t) {
          e.preventDefault()
          useStore.setState({ active: t })
        }
        return
      }
      const name = keymap(setting('keybindings')).get(combo)
      if (!name) return
      // In a text field, undo and redo belong to the text field. So do back and forward, and any
      // Alt shortcut without mod: on macOS Option+Arrow moves by word, Option+letter types a letter.
      if ((name === 'undo' || name === 'redo' || name === 'back' || name === 'forward' || !combo.startsWith('mod+')) && isTyping()) return
      e.preventDefault()
      // Through the same path as the menu, so components listening for a command hear keys too.
      runCommand(name)
    }
    window.addEventListener('keydown', onKey)
    installNavigation()
    const offMouse = installMouseNavigation()
    return () => {
      off()
      offMouse()
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}

export function App() {
  useCommands()
  const view = useActiveRepo()
  const ready = useStore((s) => s.settings !== null)
  const page = useStore((s) => s.page)
  return (
    <TooltipProvider delayDuration={400}>
    <div className="flex h-full flex-col">
      <TabBar />
      <AttentionBar />
      {!ready ? null : page === 'settings' ? (
        <SettingsPage />
      ) : !view ? (
        <Welcome />
      ) : (
        <>
          <Toolbar view={view} />
          <Workspace view={view} />
          <StatusBar view={view} />
        </>
      )}
      <OmniSearch />
      <Dialogs />
      <AiDialogs />
      <PromptDialog />
      <DragBadge />
      <CheckoutMenu />
      {/* Bottom centre, over the graph: bottom right would cover the Commit button for 5 seconds. */}
      <Toaster position="bottom-center" offset={32} expand visibleToasts={5} containerAriaLabel="Notifications" />
    </div>
    </TooltipProvider>
  )
}
