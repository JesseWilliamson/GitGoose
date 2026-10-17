import { DEFAULT_LAYOUT, setCollapsed } from '@gitsquid/shared'
import { useEffect } from 'react'
import { applyPatchFile, applyPatchFromClipboard, fetchAll, initRepo, newBranch, openRepoDialog, openTerminal, pop, pull, push, redo, stash, undo } from '../lib/actions'
import { comboOf, keymap } from '../lib/keys'
import { closeTab, onCommand, runCommand, updateRepo, saveSettings, setting, useActiveRepo, useStore } from '../lib/store'
import { AttentionBar } from './AttentionBar'
import { OmniSearch } from './OmniSearch'
import { Dialogs, PromptDialog, Toasts } from './Dialogs'
import { DropMenu } from './menus'
import { SettingsPage } from './SettingsPage'
import { AiDialogs } from './AiDialogs'
import { StatusBar } from './StatusBar'
import { TabBar } from './TabBar'
import { Toolbar } from './Toolbar'
import { Welcome } from './Welcome'
import { toggleSlot } from './Workspace'
import { Workspace } from './Workspace'

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
        case 'toggle-sidebar': return toggleSlot('left')
        case 'toggle-details': return toggleSlot('right')
        case 'layout-default': return void saveSettings({ layout: structuredClone(DEFAULT_LAYOUT) })
        case 'layout-wide-graph': return void saveSettings({ layout: setCollapsed(setCollapsed(setting('layout'), 'left', true), 'right', true) })
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
        case 'reveal': return void window.gitsquid.revealPath(s.repos[id]!.snapshot.path)
        case 'terminal': return void openTerminal(id)
        case 'apply-patch': return void applyPatchFile(id)
        case 'apply-patch-clipboard': return void applyPatchFromClipboard(id)
        case 'reflog': return updateRepo(id, { center: { kind: 'reflog' } })
        case 'command-log': return updateRepo(id, { center: { kind: 'commands' } })
      }
    }
    const off = onCommand(handle)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useStore.getState().page && !useStore.getState().dialog && !useStore.getState().omni) {
        useStore.setState({ page: null })
        return
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
      // In a text field, undo and redo belong to the text field.
      if ((name === 'undo' || name === 'redo') && isTyping()) return
      e.preventDefault()
      // Through the same path as the menu, so components listening for a command hear keys too.
      runCommand(name)
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
  const page = useStore((s) => s.page)
  return (
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
      <DropMenu />
      <Toasts />
    </div>
  )
}
