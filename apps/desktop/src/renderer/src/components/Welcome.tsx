import { Download, FolderGit2, FolderOpen, FolderPlus } from 'lucide-react'
import { initRepo, openRepoDialog, reopen } from '../lib/actions'
import { shortcutOf } from '../lib/keys'
import { useStore } from '../lib/store'
import { Button, SectionHeader } from './ui'

/** The no-repository screen: what you opened last is the main thing, starting something new is quiet. */
export function Welcome() {
  const recent = useStore((s) => s.settings?.recentRepos ?? [])
  const keys = useStore((s) => s.settings?.keybindings)
  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 pt-[14vh]" data-testid="welcome">
      <div className="w-full max-w-[520px]">
        <div className="mb-6 flex items-center gap-3 px-3">
          <FolderGit2 size={28} className="text-primary" />
          <h1 className="text-base font-semibold">GitGoose</h1>
        </div>

        <div className="mb-4 flex gap-2 px-3">
          <Button onClick={() => void openRepoDialog()}><FolderOpen size={14} />Open</Button>
          <Button onClick={() => useStore.setState({ dialog: { kind: 'clone' } })}><Download size={14} />Clone</Button>
          <Button onClick={() => void initRepo()}><FolderPlus size={14} />New</Button>
        </div>

        <SectionHeader count={recent.length > 0 ? recent.length : undefined}>Recent repositories</SectionHeader>
        {recent.length === 0 && <p className="px-3 py-2 text-xs text-hint" data-testid="welcome-empty">Nothing opened yet. Open a folder, clone a repository or start a new one.</p>}
        <div className="flex flex-col" data-testid="recent-repos">
          {recent.slice(0, 8).map((p) => (
            <button key={p} onClick={() => reopen(p)} data-testid="recent-repo" title={p}
              className="flex h-8 min-w-0 items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-accent">
              <FolderGit2 size={14} className="shrink-0 text-muted-foreground" />
              <span className="shrink-0">{p.split(/[\\/]/).pop()}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-hint">{p}</span>
            </button>
          ))}
        </div>
      </div>

      <p className="mt-auto py-4 text-xs text-hint" data-testid="welcome-shortcuts">
        {shortcutOf('open-repo', keys)} open · {shortcutOf('search', keys)} search · {shortcutOf('palette', keys)} commands · ? shortcuts
      </p>
    </div>
  )
}
