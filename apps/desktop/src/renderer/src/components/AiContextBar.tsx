import type { ReviewScope } from '@gitgoose/shared'
import clsx from 'clsx'
import { Archive, ChevronDown, FileText, GitBranch, GitCommitHorizontal, GitCompare, GitMerge, Layers, ListTree, Pencil, Scissors, SearchCheck, Sparkles, Tag, Waypoints, X, Zap, type LucideIcon } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { cherryPick, cherryPickMany, rebase } from '../lib/actions'
import { removeChip, type ChipKind, type ContextChip } from '../lib/aiContext'
import { explainCommit } from '../lib/explain'
import { showImpact } from '../lib/impact'
import { startReview } from '../lib/review'
import { getLog, selectCommit, useStore, type RepoView } from '../lib/store'
import { startWalkthrough } from '../lib/walkthrough'
import { recomposeWithAi } from './RecomposeDialog'
import { DM } from './ui'
import { Badge } from './ui/badge'

/**
 * Two parts of the AI panel's composer, both inside its one box: the chips at its top (what the
 * next message will carry) and, at the left of its footer, the actions menu (what the AI can do
 * with them).
 *
 * Chips are references; main reads git when the message is sent (lib/aiContext.ts). The actions
 * only call the starters the menus already call, so a review started here is the same review,
 * and its thread is in the history list like any other. They are a menu, not seven buttons: they
 * are things you do now and then, so they should not take a third of the pane all the time.
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

/** The chips of the next message, and what the hint beside them says about them. Sits at the top of the composer's box. */
export function AiContextChips({ view, chips, sentKeys }: { view: RepoView; chips: ContextChip[]; sentKeys: string[] }) {
  const pending = chips.filter((c) => !sentKeys.includes(c.key)).length
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 pt-2 text-2xs" data-testid="ai-context">
      {chips.map((c) => {
        const Icon = ICON[c.kind]
        const sent = sentKeys.includes(c.key)
        return (
          <Badge key={c.key} variant="outline" data-testid="ai-context-chip" data-kind={c.kind} data-selection={c.fromSelection || undefined} data-sent={sent ? 'true' : undefined}
            title={sent ? `${c.title} (already in this conversation, not sent again)` : c.title}
            className={clsx('h-row max-w-full rounded-sm border-border bg-card py-0 pr-0.5 pl-1.5 text-2xs font-normal', sent ? 'text-muted-foreground' : 'text-foreground')}>
            <Icon size={11} className={clsx('shrink-0', sent ? 'text-muted-foreground/70' : 'text-primary')} />
            <span className="min-w-0 truncate" data-testid="ai-context-chip-label">{c.label}</span>
            <button onClick={() => removeChip(view.id, c)} aria-label={`Remove ${c.label}`} title="Do not send this" data-testid="ai-context-chip-remove"
              className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"><X size={10} /></button>
          </Badge>
        )
      })}
      <span className="text-muted-foreground/70" data-testid="ai-context-hint">
        {pending ? 'Sent with your next message' : chips.length ? 'In this conversation already' : 'Drop commits, branches, stashes or files here to add them'}
      </span>
    </div>
  )
}

/**
 * What the AI can do with the chips, in one menu at the left of the composer's footer. An action
 * that cannot run now stays in the list, greyed, with the reason on hover (Select commits or drop
 * a branch here): a missing item would leave the user guessing what is possible.
 */
export function AiActionsMenu({ view, chips }: { view: RepoView; chips: ContextChip[] }) {
  const aiOn = useStore((s) => (s.settings?.aiProvider ?? 'off') !== 'off')
  const actions = paneActions(view, chips, aiOn)
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button data-testid="ai-actions" title="What the AI can do with the attached context"
          className="inline-flex h-row shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground">
          <Zap size={12} /> Actions <ChevronDown size={10} className="text-muted-foreground/70" />
        </button>
      </DropdownMenu.Trigger>
      <DM.Content align="start">
        {actions.map((a) => (
          <DM.Item key={a.name} testId={`ai-action-${a.name}`} reason={a.why || undefined} title={a.what} onSelect={a.run}>
            <a.icon size={13} className="shrink-0 text-muted-foreground" />{a.label}
          </DM.Item>
        ))}
      </DM.Content>
    </DropdownMenu.Root>
  )
}
