import clsx from 'clsx'
import { Plus, X } from 'lucide-react'
import { openRepoDialog } from '../lib/actions'
import { closeTab, useStore } from '../lib/store'

export function TabBar() {
  const tabs = useStore((s) => s.tabs)
  const active = useStore((s) => s.active)
  const repos = useStore((s) => s.repos)
  const mac = window.gitsquid.platform === 'darwin'
  return (
    <div className={clsx('drag flex h-9 shrink-0 items-end gap-px border-b border-line bg-bg', mac ? 'pl-20' : 'pl-1')} data-testid="tabs">
      {tabs.map((id) => {
        const r = repos[id]
        if (!r) return null
        return (
          <div key={id}
            onMouseDown={(e) => { if (e.button === 1) void closeTab(id) }}
            onClick={() => useStore.setState({ active: id })}
            title={r.snapshot.path}
            className={clsx('no-drag group flex h-8 max-w-56 min-w-28 cursor-default items-center gap-2 rounded-t-md border border-b-0 px-3 text-[13px]',
              id === active ? 'border-line bg-panel text-fg' : 'border-transparent text-muted hover:text-fg')}>
            <span className="min-w-0 flex-1 truncate">{r.snapshot.name}</span>
            <button onClick={(e) => { e.stopPropagation(); void closeTab(id) }} title="Close tab"
              className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-hover"><X size={12} /></button>
          </div>
        )
      })}
      <button onClick={() => void openRepoDialog()} title="Open repository (Ctrl/Cmd+O)" className="no-drag mb-1 ml-1 rounded p-1 text-muted hover:bg-hover hover:text-fg">
        <Plus size={15} />
      </button>
    </div>
  )
}
