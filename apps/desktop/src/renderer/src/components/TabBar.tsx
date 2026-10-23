import clsx from 'clsx'
import { Copy, Menu, Minus, Plus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { openRepoDialog } from '../lib/actions'
import { modName } from '../lib/keys'
import { closeTab, useStore } from '../lib/store'

/** Width of the caption buttons Windows draws over the right end of the bar (titleBarOverlay). */
const WIN_CONTROLS_WIDTH = 138

/** Whether the window is maximised, kept current by the main process's window-state events. */
function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let live = true
    void api.windowIsMaximized().then((m) => { if (live) setMaximized(m) }).catch(() => {})
    const off = window.gitgoose.onEvent((e) => { if (e.type === 'window-state') setMaximized(e.maximized) })
    return () => { live = false; off() }
  }, [])
  return maximized
}

const CONTROL = 'no-drag flex w-11 items-center justify-center self-stretch text-muted hover:bg-hover hover:text-fg'

/** Minimise, maximise/restore and close, drawn by the page: Linux has no OS-drawn ones for a frameless window. */
function WindowControls() {
  const maximized = useMaximized()
  return (
    <div className="flex shrink-0 self-stretch" data-testid="window-controls">
      <button className={CONTROL} aria-label="Minimize" title="Minimize" onClick={() => void api.windowMinimize()}><Minus size={14} /></button>
      <button className={CONTROL} aria-label={maximized ? 'Restore' : 'Maximize'} title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void api.windowToggleMaximize()}>
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button className={clsx(CONTROL, 'hover:!bg-[#e81123] hover:!text-white')} aria-label="Close" title="Close" onClick={() => void api.windowClose()}><X size={14} /></button>
    </div>
  )
}

export function TabBar() {
  const tabs = useStore((s) => s.tabs)
  const active = useStore((s) => s.active)
  const repos = useStore((s) => s.repos)
  const platform = window.gitgoose.platform
  const mac = platform === 'darwin'
  return (
    <div className={clsx('drag flex h-(--titlebar-h) shrink-0 items-end gap-px border-b border-line bg-bg', mac ? 'pl-20' : 'pl-1')} data-testid="tabs"
      // The empty part of the bar (not a tab: those are children). macOS does this itself.
      onDoubleClick={(e) => { if (!mac && !(e.target as HTMLElement).closest('button, [data-tab]')) void api.windowToggleMaximize() }}>
      {!mac && (
        <button onClick={() => void api.menuPopup()} aria-label="Menu" title="Menu"
          className="no-drag mr-1 mb-1 shrink-0 rounded p-1 text-muted hover:bg-hover hover:text-fg"><Menu size={15} /></button>
      )}
      {/* The tabs scroll sideways inside their own strip, so the menu button and the window
          controls on either side stay in view however many repositories are open. */}
      <div className="flex min-w-0 flex-1 items-end gap-px self-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
        onWheel={(e) => { if (e.deltaY && !e.deltaX) e.currentTarget.scrollLeft += e.deltaY }}>
      {tabs.map((id) => {
        const r = repos[id]
        if (!r) return null
        return (
          <div key={id} data-tab
            onMouseDown={(e) => { if (e.button === 1) void closeTab(id) }}
            onClick={() => useStore.setState({ active: id })}
            title={r.snapshot.path}
            className={clsx('no-drag group flex h-8 max-w-56 min-w-28 shrink-0 cursor-default items-center gap-2 rounded-t-md border border-b-0 px-3 text-[13px]',
              id === active ? 'border-line bg-panel text-fg' : 'border-transparent text-muted hover:text-fg')}>
            <span className="min-w-0 flex-1 truncate">{r.snapshot.name}</span>
            <button onClick={(e) => { e.stopPropagation(); void closeTab(id) }} title="Close tab"
              className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-hover"><X size={12} /></button>
          </div>
        )
      })}
      <button onClick={() => void openRepoDialog()} title={`Open repository (${modName()}+O)`} className="no-drag mb-1 ml-1 shrink-0 rounded p-1 text-muted hover:bg-hover hover:text-fg">
        <Plus size={15} />
      </button>
      </div>
      {platform === 'linux' && <WindowControls />}
      {platform === 'win32' && <div className="shrink-0 self-stretch" style={{ width: WIN_CONTROLS_WIDTH }} aria-hidden />}
    </div>
  )
}
