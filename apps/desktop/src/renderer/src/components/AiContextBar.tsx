import type { ReviewScope } from '@gitgoose/shared'
import clsx from 'clsx'
import { Archive, FileText, GitBranch, GitCommitHorizontal, GitCompare, GitMerge, Layers, ListTree, Pencil, Scissors, SearchCheck, Sparkles, Tag, Waypoints, X, type LucideIcon } from 'lucide-react'
import { cherryPick, cherryPickMany, rebase } from '../lib/actions'
import { removeChip, type ChipKind, type ContextChip } from '../lib/aiContext'
import { explainCommit } from '../lib/explain'
import { showImpact } from '../lib/impact'
import { startReview } from '../lib/review'
import { getLog, selectCommit, useStore, type RepoView } from '../lib/store'
import { startWalkthrough } from '../lib/walkthrough'
import { recomposeWithAi } from './RecomposeDialog'
import { Button } from './ui'
import { Badge } from './ui/badge'

/**
 * Under the AI panel's conversation, above its composer: what the next message will carry (the
 * context chips) and what the AI can do with it (the action row).
 *
 * Chips are references; main reads git when the message is sent (lib/aiContext.ts). The buttons
 * only call the starters the menus already call, so a review started here is the same review,
 * and its thread is in the history list like any other.
 */

const ICON: Record<ChipKind, LucideIcon> = {
  commit: GitCommitHorizontal, commits: Layers, branch: GitBranch, tag: Tag, stash: Archive, files: FileText, wip: Pencil, compare: GitCompare,
}

export interface PaneAction {
  name: 'explain' | 'review' | 'walkthrough' | 'impact' | 'recompose' | 'rebase' | 'cherrypick'
  label: string
  icon: LucideIcon
  /** Why it cannot be used now; empty when it can. */
  why: string
  /** What it does, for the tooltip of an enabled button. */
  what: string
  run: () => void
}

/** The commits the chips stand for, once each, in graph order (those the log does not know last). */
export function chipCommits(repoId: string, chips: ContextChip[]): string[] {
  const hashes = [...new Set(chips.flatMap((c) => (c.ref.kind === 'commits' ? c.ref.hashes : [])))]
  const index = getLog(repoId).index
  return hashes.sort((a, b) => (index.get(a) ?? Infinity) - (index.get(b) ?? Infinity))
}

/**
 * The actions for these chips. Dropped chips come before the selection's: what the user put
 * here on purpose wins over what happens to be selected. Pure apart from the log lookup.
 */
export function paneActions(view: Pick<RepoView, 'id' | 'snapshot' | 'editable'>, chips: ContextChip[], aiOn: boolean): PaneAction[] {
  const id = view.id
  const ordered = [...chips.filter((c) => !c.fromSelection), ...chips.filter((c) => c.fromSelection)]
  const hashes = chipCommits(id, ordered)
  const refChip = ordered.find((c) => c.ref.kind === 'ref')
  const branchChip = ordered.find((c) => c.ref.kind === 'ref' && !c.ref.name.startsWith('refs/tags/'))
  const need = 'Select commits or drop a branch here'
  const noAi = aiOn ? '' : 'Turn on AI in Settings → AI'

  // What a review, walkthrough or impact covers: the first of commits, branch, working copy that the chips hold.
  const first = ordered.find((c) => c.ref.kind === 'commits' || (c.ref.kind === 'ref' && !c.ref.name.startsWith('refs/tags/')) || c.ref.kind === 'wip')
  let scope: ReviewScope | null = null
  if (first?.ref.kind === 'commits') scope = { kind: 'commits', hashes }
  else if (first?.ref.kind === 'ref') scope = { kind: 'branch', branch: first.ref.name.replace(/^refs\/(heads|remotes)\//, '') }
  else if (first?.ref.kind === 'wip') scope = { kind: 'working' }
  const what = scope ? (scope.kind === 'commits' ? (hashes.length === 1 ? 'this commit' : `${hashes.length} commits`) : scope.kind === 'branch' ? scope.branch : 'the uncommitted changes') : ''

  const editable = hashes.length > 0 && hashes.every((h) => view.editable.includes(h))
  const headBranch = view.snapshot.head.branch
  const refName = refChip?.ref.kind === 'ref' ? refChip.ref.name : ''
  const refShort = refName.replace(/^refs\/(heads|remotes|tags)\//, '')

  return [
    {
      name: 'explain', label: 'Explain', icon: Sparkles, what: `Explain commit ${hashes[0]?.slice(0, 7)} in the Details panel`,
      why: noAi || (hashes.length === 1 ? '' : 'Select one commit, or drop one here'),
      run: () => {
        selectCommit(id, hashes[0]!)
        explainCommit(id, hashes[0]!)
      },
    },
    { name: 'review', label: 'Review', icon: SearchCheck, what: `Review ${what}`, why: noAi || (scope ? '' : need), run: () => startReview(id, scope!) },
    { name: 'walkthrough', label: 'Walk through', icon: Waypoints, what: `Walk through ${what}`, why: noAi || (scope ? '' : need), run: () => startWalkthrough(id, scope!) },
    { name: 'impact', label: 'Impact', icon: ListTree, what: `Find what ${what} could affect`, why: scope ? '' : need, run: () => showImpact(id, scope!) },
    {
      name: 'recompose', label: hashes.length === 1 ? 'Split' : 'Recompose', icon: Scissors,
      what: hashes.length === 1 ? 'Split this commit into smaller ones' : `Recompose ${hashes.length} commits`,
      why: noAi || (!hashes.length ? 'Select commits or drop them here' : editable ? '' : 'Recompose needs non-merge commits on the current branch'),
      run: () => recomposeWithAi(id, hashes),
    },
    {
      name: 'rebase', label: 'Rebase onto…', icon: GitMerge, what: `Rebase ${headBranch ?? 'HEAD'} onto ${refShort}`,
      why: !refChip ? 'Drop a branch here' : refShort === headBranch ? 'That is the current branch' : !headBranch ? 'HEAD is not on a branch' : '',
      run: () => void rebase(id, refName),
    },
    {
      name: 'cherrypick', label: 'Cherry-pick onto HEAD', icon: GitCommitHorizontal,
      what: `Cherry-pick ${hashes.length === 1 ? hashes[0]?.slice(0, 7) : `${hashes.length} commits`} onto ${headBranch ?? 'HEAD'}`,
      why: hashes.length ? '' : 'Select commits or drop them here',
      run: () => void (hashes.length === 1 ? cherryPick(id, hashes[0]!) : cherryPickMany(id, hashes)),
    },
  ]
}

export function AiContextBar({ view, chips, sentKeys }: { view: RepoView; chips: ContextChip[]; sentKeys: string[] }) {
  const aiOn = useStore((s) => (s.settings?.aiProvider ?? 'off') !== 'off')
  const actions = paneActions(view, chips, aiOn)
  const pending = chips.filter((c) => !sentKeys.includes(c.key)).length
  return (
    <div className="shrink-0 border-t border-line px-2 pt-1.5 pb-0.5 text-2xs" data-testid="ai-context">
      <div className="flex flex-wrap items-center gap-1">
        {chips.map((c) => {
          const Icon = ICON[c.kind]
          const sent = sentKeys.includes(c.key)
          return (
            <Badge key={c.key} variant="outline" data-testid="ai-context-chip" data-kind={c.kind} data-selection={c.fromSelection || undefined} data-sent={sent ? 'true' : undefined}
              title={sent ? `${c.title} (already in this conversation, not sent again)` : c.title}
              className={clsx('max-w-full rounded-md border-line bg-bg py-0.5 pr-0.5 pl-1.5 text-2xs font-normal', sent ? 'text-muted' : 'text-fg')}>
              <Icon size={11} className={clsx('shrink-0', sent ? 'text-faint' : 'text-accent')} />
              <span className="min-w-0 truncate" data-testid="ai-context-chip-label">{c.label}</span>
              <button onClick={() => removeChip(view.id, c)} aria-label={`Remove ${c.label}`} title="Do not send this" data-testid="ai-context-chip-remove"
                className="shrink-0 rounded p-0.5 text-muted hover:bg-hover hover:text-fg"><X size={10} /></button>
            </Badge>
          )
        })}
        <span className="text-faint" data-testid="ai-context-hint">
          {pending ? 'Sent with your next message' : chips.length ? 'In this conversation already' : 'Drop commits, branches, stashes or files here to add them'}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1" data-testid="ai-actions">
        {actions.map((a) => (
          // A disabled button takes no pointer events, so the tooltip is on a wrapper too.
          <span key={a.name} title={a.why || a.what}>
            <Button size="sm" disabled={!!a.why} onClick={a.run} title={a.why || a.what} data-testid={`ai-action-${a.name}`}>
              <a.icon size={11} className="shrink-0" />{a.label}
            </Button>
          </span>
        ))}
      </div>
    </div>
  )
}
