import type { Ref, RepoSnapshot } from '@gitgoose/shared'

/**
 * Drag and drop: **the target and the modifier decide; there is no chooser menu**
 * (ADR-009). A plain drop does the obvious thing straight away and offers Undo; Alt picks the
 * one alternative (rebase instead of merge, revert instead of cherry-pick, fixup instead of
 * squash); only drops that change a remote ask first. While dragging, a badge by the pointer
 * says exactly what will happen (components/DragBadge.tsx).
 *
 * This file is the pure part: what is being dragged (`DragSource`), what it is over
 * (`DropTarget`), and `dropPlan`, which turns the two into a label and an operation, as data.
 * The table in docs/specs/003-branches-and-remotes.md is its specification and dnd.test.ts its
 * test list, one case per row. Running an operation is lib/actions.ts's `performDrop`, which
 * only calls the existing actions.
 */

// ------------------------------------------------------------------ what is dragged

/** A branch or tag (sidebar row or graph pill): the Ref as JSON. */
export const REF_MIME = 'application/x-gitgoose-ref'
/** Commits from the graph: JSON list of hashes, newest first. */
export const COMMITS_MIME = 'application/x-gitgoose-commits'
/** A stash entry: { index, hash, ref }. */
export const STASH_MIME = 'application/x-gitgoose-stash'
/** Files from a commit's or stash's file list, or the changes list: { rev | 'worktree', paths }. */
export const FILE_MIME = 'application/x-gitgoose-file'

export type DragSource =
  | { kind: 'ref'; ref: Ref }
  | { kind: 'commits'; hashes: string[] }
  | { kind: 'stash'; index: number; hash: string; ref: string }
  /** `rev` 'worktree': files from the changes list. `stash`: rev is a stash (untracked files live in its third parent). */
  | { kind: 'files'; rev: string; paths: string[]; stash?: boolean }

const MIME: Record<DragSource['kind'], string> = { ref: REF_MIME, commits: COMMITS_MIME, stash: STASH_MIME, files: FILE_MIME }

/** The payload as it travels in a DataTransfer (under its MIME type). */
export function encodeDrag(source: DragSource): { mime: string; data: string } {
  const data = source.kind === 'ref' ? source.ref : source.kind === 'commits' ? source.hashes
    : source.kind === 'stash' ? { index: source.index, hash: source.hash, ref: source.ref }
    : { rev: source.rev, paths: source.paths, stash: source.stash }
  return { mime: MIME[source.kind], data: JSON.stringify(data) }
}

/** Read a payload back (on drop, when DataTransfer gives up its data). Null for anything else. */
export function decodeDrag(get: (mime: string) => string): DragSource | null {
  try {
    const ref = get(REF_MIME)
    if (ref) return { kind: 'ref', ref: JSON.parse(ref) as Ref }
    const commits = get(COMMITS_MIME)
    if (commits) return { kind: 'commits', hashes: JSON.parse(commits) as string[] }
    const stash = get(STASH_MIME)
    if (stash) return { kind: 'stash', ...(JSON.parse(stash) as { index: number; hash: string; ref: string }) }
    const file = get(FILE_MIME)
    if (file) return { kind: 'files', ...(JSON.parse(file) as { rev: string; paths: string[]; stash?: boolean }) }
  } catch {
    // Not ours, or damaged: not a drop.
  }
  return null
}

/**
 * The drag under way in this window. While dragging, the browser shows a DataTransfer's types
 * but not its data (only the drop gets that), and the badge needs to know what is being dragged
 * on every move, so the source is also kept here from dragstart to dragend.
 */
let current: DragSource | null = null

export function startDrag(dt: DataTransfer, source: DragSource): void {
  const { mime, data } = encodeDrag(source)
  dt.setData(mime, data)
  dt.effectAllowed = 'copyMove'
  current = source
}

export function currentDrag(): DragSource | null {
  return current
}

export function endDrag(): void {
  current = null
}

// ------------------------------------------------------------------ where it is dropped

export type SectionTarget = 'branches' | 'tags' | 'pinned' | 'worktrees'
export type WorkspaceTarget = 'working-copy' | 'stashes' | 'pulls'

export type DropTarget =
  /** A sidebar section header. */
  | { kind: 'section'; section: SectionTarget }
  /** A folder row in Branches ("feature", "feature/ui"). */
  | { kind: 'folder'; folder: string }
  /** A branch or tag: a sidebar row or a graph pill. */
  | { kind: 'ref'; ref: Ref }
  /** A remote's node in Remotes. */
  | { kind: 'remote'; remote: string }
  | { kind: 'workspace'; item: WorkspaceTarget }
  /** A graph row, and where on it (the upper, middle or lower third). */
  | { kind: 'row'; hash: string; where: 'above' | 'onto' | 'below' }
  /** The graph's uncommitted-changes row. */
  | { kind: 'wip' }

// ------------------------------------------------------------------ what happens

/** An operation, as data: lib/actions.ts `performDrop` runs it through the existing actions. */
export type DropOp =
  | { op: 'merge'; ref: string }
  | { op: 'rebase'; onto: string }
  /** Check out `branch`, then merge `ref` into it / rebase it onto `ref`. */
  | { op: 'merge-into'; branch: string; ref: string }
  | { op: 'rebase-onto'; branch: string; onto: string }
  /** `remoteBranch` set: push to that branch on the remote (and track it). */
  | { op: 'push'; branch: string; remote: string; remoteBranch?: string; force: boolean }
  | { op: 'push-tag'; tag: string; remote: string }
  /** Pull a remote branch into HEAD (fetches it from its remote). */
  | { op: 'pull'; remote: string; branch: string; rebase: boolean }
  | { op: 'new-branch'; at: string }
  | { op: 'new-tag'; at: string }
  | { op: 'rename-into'; branch: string; folder: string }
  | { op: 'pin'; branch: string }
  | { op: 'add-worktree'; branch: string }
  | { op: 'create-pr'; branch: string }
  /** Check out a remote branch as a local tracking branch (`checkout`), or only create that branch. */
  | { op: 'track'; ref: string; name: string; checkout: boolean }
  | { op: 'set-upstream'; branch: string; upstream: string }
  | { op: 'cherry-pick'; hashes: string[] }
  | { op: 'revert'; hashes: string[] }
  | { op: 'cherry-pick-onto'; branch: string; hashes: string[] }
  | { op: 'move'; hashes: string[]; target: string; where: 'above' | 'below' }
  | { op: 'squash'; hashes: string[]; target: string; fixup: boolean }
  | { op: 'stash-apply'; index: number; pop: boolean }
  | { op: 'apply-file'; rev: string; paths: string[]; stash: boolean }
  | { op: 'stash-files'; paths: string[] }

export interface DropPlan {
  /** What the badge says: exactly what will happen. */
  label: string
  op: DropOp
  /** Changes a remote: undo cannot reverse it, so it asks first. */
  confirm?: boolean
}

/** What dropPlan needs to know about the repository. */
export interface DropContext {
  snapshot: Pick<RepoSnapshot, 'head' | 'refs'>
  /** Commits drop / move / squash can edit: the current branch back to its last merge (newest first). */
  editable: readonly string[]
  /** Pinned branch names. */
  pinned: readonly string[]
}

const short = (ref: Ref | string) => (typeof ref === 'string' ? ref : ref.name).replace(/^refs\/(heads|remotes|tags)\//, '')
const sha = (h: string) => h.slice(0, 7)
const commits = (hashes: string[]) => (hashes.length === 1 ? sha(hashes[0]!) : `${hashes.length} commits`)
/** "origin/feature/x" → ["origin", "feature/x"]. */
const splitRemote = (r: Ref): [string, string] => {
  const s = r.shortName
  const i = s.indexOf('/')
  return [s.slice(0, i), s.slice(i + 1)]
}

/**
 * What dropping `source` on `target` does, with Alt held or not, or null when the target does not
 * take that source (then the target shows nothing and the pointer says "no"). Rows without an
 * alternative do the same with Alt as without.
 */
export function dropPlan(ctx: DropContext, source: DragSource, target: DropTarget, { alt = false } = {}): DropPlan | null {
  switch (source.kind) {
    case 'ref':
      return source.ref.kind === 'local' ? localBranch(ctx, source.ref, target, alt)
        : source.ref.kind === 'remote' ? remoteBranch(ctx, source.ref, target, alt)
        : source.ref.kind === 'tag' ? tag(source.ref, target)
        : null
    case 'commits':
      return commitDrop(ctx, source.hashes, target, alt)
    case 'stash':
      if (!isWorkingCopy(target)) return null
      return alt ? { label: `Pop ${source.ref}`, op: { op: 'stash-apply', index: source.index, pop: true } }
        : { label: `Apply ${source.ref}`, op: { op: 'stash-apply', index: source.index, pop: false } }
    case 'files':
      return fileDrop(source, target)
  }
}

/** The places that stand for "the working copy": the Workspace item and the graph's WIP row. */
function isWorkingCopy(t: DropTarget): boolean {
  return (t.kind === 'workspace' && t.item === 'working-copy') || t.kind === 'wip'
}

function headRef(ctx: DropContext): Ref | undefined {
  const b = ctx.snapshot.head.branch
  return b ? ctx.snapshot.refs.find((r) => r.name === `refs/heads/${b}`) : undefined
}

/** HEAD's branch (sidebar row or pill), the Working Copy item, or the WIP row. */
function isHeadTarget(ctx: DropContext, t: DropTarget): boolean {
  if (isWorkingCopy(t)) return true
  const head = headRef(ctx)
  return t.kind === 'ref' && !!head && t.ref.name === head.name
}

function localBranch(ctx: DropContext, src: Ref, t: DropTarget, alt: boolean): DropPlan | null {
  const head = headRef(ctx)
  const headName = ctx.snapshot.head.branch ?? 'HEAD'
  const name = src.shortName
  const isHead = head?.name === src.name

  // Onto HEAD: bring it in. HEAD's own row in the graph counts too (it is where HEAD is).
  if (isHeadTarget(ctx, t) || (t.kind === 'row' && t.hash === ctx.snapshot.head.hash)) {
    if (isHead || !ctx.snapshot.head.hash) return null
    return alt ? { label: `Rebase ${headName} onto ${name}`, op: { op: 'rebase', onto: src.name } }
      : { label: `Merge ${name} into ${headName}`, op: { op: 'merge', ref: src.name } }
  }
  switch (t.kind) {
    case 'ref': {
      if (t.ref.name === src.name) return null
      if (t.ref.kind === 'local') {
        const target = t.ref.shortName
        return alt ? { label: `Rebase ${target} onto ${name} (checks out ${target})`, op: { op: 'rebase-onto', branch: target, onto: src.name } }
          : { label: `Merge ${name} into ${target} (checks out ${target})`, op: { op: 'merge-into', branch: target, ref: src.name } }
      }
      if (t.ref.kind === 'remote' && !t.ref.name.endsWith('/HEAD')) {
        const [remote, remoteBranch] = splitRemote(t.ref)
        return alt ? { label: `Force push ${name} to ${t.ref.shortName} (with lease)`, op: { op: 'push', branch: name, remote, remoteBranch, force: true }, confirm: true }
          : { label: `Push ${name} to ${t.ref.shortName}`, op: { op: 'push', branch: name, remote, remoteBranch, force: false }, confirm: true }
      }
      return null
    }
    case 'remote': {
      // Its own upstream on that remote: a plain push; otherwise publish it there, with tracking.
      const tracked = !!src.upstream && !src.upstreamGone && short(src.upstream).startsWith(`${t.remote}/`)
      if (alt) return { label: `Force push ${name} to ${t.remote} (with lease)`, op: { op: 'push', branch: name, remote: t.remote, force: true }, confirm: true }
      return { label: tracked ? `Push ${name} to ${short(src.upstream!)}` : `Publish ${name} to ${t.remote}`, op: { op: 'push', branch: name, remote: t.remote, force: false }, confirm: true }
    }
    case 'section':
      if (t.section === 'branches') return { label: `Create a branch from ${name}…`, op: { op: 'new-branch', at: src.name } }
      if (t.section === 'tags') return { label: `Create a tag at ${name}…`, op: { op: 'new-tag', at: src.hash } }
      if (t.section === 'pinned') return ctx.pinned.includes(name) ? null : { label: `Pin ${name}`, op: { op: 'pin', branch: name } }
      // git refuses to check out the branch this worktree has.
      if (t.section === 'worktrees') return isHead ? null : { label: `Check out ${name} in a new worktree…`, op: { op: 'add-worktree', branch: name } }
      return null
    case 'folder': {
      const base = name.slice(name.lastIndexOf('/') + 1)
      const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''
      if (parent === t.folder) return null
      return { label: `Rename ${name} to ${t.folder}/${base}`, op: { op: 'rename-into', branch: name, folder: t.folder } }
    }
    case 'workspace':
      return t.item === 'pulls' ? { label: `Create a pull request for ${name}…`, op: { op: 'create-pr', branch: name } } : null
    default:
      return null
  }
}

function remoteBranch(ctx: DropContext, src: Ref, t: DropTarget, alt: boolean): DropPlan | null {
  if (src.name.endsWith('/HEAD')) return null
  const [remote, branch] = splitRemote(src)
  const headName = ctx.snapshot.head.branch ?? 'HEAD'
  if (t.kind === 'section' && t.section === 'branches') {
    const exists = ctx.snapshot.refs.some((r) => r.name === `refs/heads/${branch}`)
    if (alt) return exists ? null : { label: `Create ${branch} tracking ${src.shortName}`, op: { op: 'track', ref: src.name, name: branch, checkout: false } }
    return { label: exists ? `Check out ${branch}` : `Check out ${src.shortName} as ${branch}`, op: { op: 'track', ref: src.name, name: branch, checkout: true } }
  }
  if (isHeadTarget(ctx, t)) {
    if (!ctx.snapshot.head.hash) return null
    return alt ? { label: `Pull ${src.shortName} into ${headName} with rebase`, op: { op: 'pull', remote, branch, rebase: true } }
      : { label: `Pull ${src.shortName} into ${headName}`, op: { op: 'pull', remote, branch, rebase: false } }
  }
  if (t.kind === 'ref' && t.ref.kind === 'local') {
    if (t.ref.upstream === src.name) return null
    return { label: `Make ${t.ref.shortName} track ${src.shortName}`, op: { op: 'set-upstream', branch: t.ref.shortName, upstream: src.name } }
  }
  return null
}

function tag(src: Ref, t: DropTarget): DropPlan | null {
  if (t.kind !== 'remote') return null
  return { label: `Push tag ${src.shortName} to ${t.remote}`, op: { op: 'push-tag', tag: src.shortName, remote: t.remote }, confirm: true }
}

function commitDrop(ctx: DropContext, hashes: string[], t: DropTarget, alt: boolean): DropPlan | null {
  if (!hashes.length) return null
  const headName = ctx.snapshot.head.branch ?? 'HEAD'
  if (isHeadTarget(ctx, t)) {
    if (!ctx.snapshot.head.hash) return null
    // Reverting works on any commit, HEAD's own included; picking HEAD onto itself does nothing.
    if (alt) return { label: `Revert ${commits(hashes)}`, op: { op: 'revert', hashes } }
    if (hashes.includes(ctx.snapshot.head.hash)) return null
    return { label: `Cherry-pick ${commits(hashes)} onto ${headName}`, op: { op: 'cherry-pick', hashes } }
  }
  switch (t.kind) {
    case 'section':
      if (hashes.length !== 1) return null
      if (t.section === 'branches') return { label: `Create a branch at ${sha(hashes[0]!)}…`, op: { op: 'new-branch', at: hashes[0]! } }
      if (t.section === 'tags') return { label: `Create a tag at ${sha(hashes[0]!)}…`, op: { op: 'new-tag', at: hashes[0]! } }
      return null
    case 'ref':
      if (t.ref.kind !== 'local') return null
      return { label: `Cherry-pick ${commits(hashes)} onto ${t.ref.shortName} (stays on ${headName})`, op: { op: 'cherry-pick-onto', branch: t.ref.shortName, hashes } }
    case 'row': {
      // Reordering and squashing edit the current branch: both ends must be on its editable part.
      const editable = new Set(ctx.editable)
      if (hashes.includes(t.hash) || !editable.has(t.hash) || !hashes.every((h) => editable.has(h))) return null
      if (t.where === 'onto') {
        return alt ? { label: `Fixup ${commits(hashes)} into ${sha(t.hash)} (keeps its message)`, op: { op: 'squash', hashes, target: t.hash, fixup: true } }
          : { label: `Squash ${commits(hashes)} into ${sha(t.hash)}`, op: { op: 'squash', hashes, target: t.hash, fixup: false } }
      }
      return { label: `Move ${commits(hashes)} ${t.where} ${sha(t.hash)}`, op: { op: 'move', hashes, target: t.hash, where: t.where } }
    }
    default:
      return null
  }
}

function fileDrop(src: Extract<DragSource, { kind: 'files' }>, t: DropTarget): DropPlan | null {
  if (!src.paths.length) return null
  const what = src.paths.length === 1 ? src.paths[0]! : `${src.paths.length} files`
  if (src.rev === 'worktree') {
    if (t.kind !== 'workspace' || t.item !== 'stashes') return null
    return { label: `Stash ${what}`, op: { op: 'stash-files', paths: src.paths } }
  }
  if (!isWorkingCopy(t)) return null
  return { label: `Apply ${src.paths.length === 1 ? `${what}'s change` : `the changes to ${what}`} from ${src.stash ? 'the stash' : sha(src.rev)} to the working copy`, op: { op: 'apply-file', rev: src.rev, paths: src.paths, stash: !!src.stash } }
}
