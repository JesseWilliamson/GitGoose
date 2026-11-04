import { BookOpen, Download, FolderGit2, FolderOpen, FolderPlus, ListChecks, Undo2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { initRepo, openRepoDialog, reopen } from '../lib/actions'
import { shortcutOf } from '../lib/keys'
import { useStore } from '../lib/store'
import { Kbd } from './ui'
import { GooseMark } from './GooseMark'

/**
 * The no-repository screen. Three ways in, each a card that says what it does (a new user
 * should not have to guess what "New" makes), then what was opened last, which is what a
 * returning user came for. One column, centred, so the eye goes straight down it.
 */
export function Welcome() {
  const recent = useStore((s) => s.settings?.recentRepos ?? [])
  const keys = useStore((s) => s.settings?.keybindings)
  const home = recent.find((p) => /^(\/home\/[^/]+|\/Users\/[^/]+|[A-Z]:\\Users\\[^\\]+)/.test(p))?.match(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Z]:\\Users\\[^\\]+)/)?.[0]
  const tidy = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p)
  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto bg-background px-4 pt-[12vh]" data-testid="welcome">
      <div className="w-full max-w-[600px]">
        <div className="mb-8 flex items-center gap-4">
          <GooseMark size={48} className="rounded-lg shadow-lg shadow-primary/20" />
          <div>
            <h1 className="text-base font-semibold">GitGoose</h1>
            <p className="text-sm text-muted-foreground">The history at a glance, every change undoable.</p>
          </div>
        </div>

        <div className="mb-8 grid grid-cols-3 gap-3">
          <Action label="Open" icon={<FolderOpen size={18} />} keys={shortcutOf('open-repo', keys)} onClick={() => void openRepoDialog()}>
            A repository on this computer
          </Action>
          <Action label="Clone" icon={<Download size={18} />} onClick={() => useStore.setState({ dialog: { kind: 'clone' } })}>
            Copy one from GitHub or any URL
          </Action>
          <Action label="New" icon={<FolderPlus size={18} />} onClick={() => void initRepo()}>
            Start a repository in a folder
          </Action>
        </div>

        <div className="mb-2 flex items-baseline justify-between px-1">
          <h2 className="text-xs font-medium text-muted-foreground">Recent repositories</h2>
          {recent.length > 0 && <span className="text-2xs text-hint tabular-nums">{recent.length}</span>}
        </div>
        {recent.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-hint" data-testid="welcome-empty">
            Nothing opened yet. Repositories you open show up here.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card" data-testid="recent-repos">
            {recent.slice(0, 8).map((p) => (
              <button key={p} onClick={() => reopen(p)} data-testid="recent-repo" title={p}
                className="flex h-11 w-full min-w-0 items-center gap-3 border-b border-border px-4 text-left last:border-b-0 hover:bg-accent">
                <FolderGit2 size={16} className="shrink-0 text-muted-foreground" />
                <span className="shrink-0 text-sm font-medium">{p.split(/[\\/]/).pop()}</span>
                <span className="min-w-0 flex-1 truncate text-right text-xs text-hint">{tidy(p)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* What sets the app apart, once, where a new user has the time to read it. */}
      <div className="mt-10 grid w-full max-w-[600px] grid-cols-3 gap-6 px-1" data-testid="welcome-tips">
        <Tip icon={<Undo2 size={16} />} title="Undo anything">Checkout, reset, rebase, drop: {shortcutOf('undo', keys) || 'Ctrl+Z'} takes it back.</Tip>
        <Tip icon={<ListChecks size={16} />} title="Stage single lines">Click the lines you mean; commit just those.</Tip>
        <Tip icon={<BookOpen size={16} />} title="Read a commit">Space opens its whole diff across the window.</Tip>
      </div>

      <p className="mt-auto py-4 text-xs text-hint" data-testid="welcome-shortcuts">
        {shortcutOf('search', keys)} search · {shortcutOf('palette', keys)} commands · ? shortcuts
      </p>
    </div>
  )
}

/** One way in: an icon, a verb, and what it does. The verb alone is its accessible name. */
function Action({ label, icon, keys, onClick, children }: { label: string; icon: ReactNode; keys?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label}
      className="group flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/60 hover:bg-accent">
      <span className="flex w-full items-center justify-between">
        <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">{icon}</span>
        {keys && <Kbd>{keys}</Kbd>}
      </span>
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block text-xs text-muted-foreground">{children}</span>
      </span>
    </button>
  )
}

function Tip({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2 text-sm font-medium text-foreground"><span className="text-primary">{icon}</span>{title}</span>
      <span className="text-xs leading-relaxed text-muted-foreground">{children}</span>
    </div>
  )
}
