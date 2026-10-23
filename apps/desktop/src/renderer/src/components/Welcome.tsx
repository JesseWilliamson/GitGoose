import { FolderGit2, FolderOpen, FolderPlus, Download } from 'lucide-react'
import { initRepo, openRepoDialog, reopen } from '../lib/actions'
import { useStore } from '../lib/store'
import { Button } from './ui'

export function Welcome() {
  const recent = useStore((s) => s.settings?.recentRepos ?? [])
  return (
    <div className="flex flex-1 items-center justify-center" data-testid="welcome">
      <div className="w-[460px]">
        <div className="mb-6 flex items-center gap-3">
          <FolderGit2 size={34} className="text-primary" />
          <h1 className="text-xl font-semibold">GitGoose</h1>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Button className="h-16 flex-col" onClick={() => void openRepoDialog()}><FolderOpen size={18} />Open</Button>
          <Button className="h-16 flex-col" onClick={() => useStore.setState({ dialog: { kind: 'clone' } })}><Download size={18} />Clone</Button>
          <Button className="h-16 flex-col" onClick={() => void initRepo()}><FolderPlus size={18} />New</Button>
        </div>
        {recent.length > 0 && (
          <div className="mt-8">
            <div className="mb-2 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">Recent</div>
            {recent.slice(0, 8).map((p) => (
              <button key={p} onClick={() => reopen(p)} className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-accent">
                <span className="text-sm">{p.split(/[\\/]/).pop()}</span>
                <span className="truncate text-xs text-hint">{p}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
