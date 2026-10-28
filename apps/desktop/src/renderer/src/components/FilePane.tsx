import { FileDiff } from 'lucide-react'
import { useShownFile } from '../lib/shownFile'
import type { RepoView } from '../lib/store'
import { FileView } from './DiffView'

/**
 * The file Details shows, given a column (the Diff pane) or the centre (reading wide) of its own:
 * full height, as an editor's main pane is, instead of the lower half of Details.
 */
export function FilePane({ view }: { view: RepoView }) {
  const file = useShownFile(view)
  if (!file) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-hint" data-testid="file-pane-empty">
        <FileDiff size={20} />
        Select a commit or a file to see its changes
      </div>
    )
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-testid="file-pane">
      <FileView view={view} target={file.target} mode={file.mode} />
    </div>
  )
}
