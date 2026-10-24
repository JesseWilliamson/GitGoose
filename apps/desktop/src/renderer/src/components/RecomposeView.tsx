import type { RecomposeProposal, RecomposeUnitInfo } from '@gitgoose/shared'
import clsx from 'clsx'
import { ArrowDown, ArrowUp, CircleAlert, GripVertical, MessagesSquare, Plus, Redo2, RotateCcw, Sparkles, Trash2, Undo2 } from 'lucide-react'
import { ContextMenu, DropdownMenu } from 'radix-ui'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { run } from '../lib/actions'
import { cancelAi, openInPanel, useAi } from '../lib/ai'
import { dropFinishedJob, parkJob } from '../lib/aiJobs'
import { api, toUiError } from '../lib/api'
import { recomposeWithAi, showingRecompose, showRecompose } from '../lib/recompose'
import { splitPath } from '../lib/format'
import { history, push, redo, undo, type History } from '../lib/history'
import { addCommit, draftProblems, editMessage, moveCommit, moveUnit, removeEmpty, squashCommits, type Draft } from '../lib/recomposeDraft'
import { toast, updateRepo, useStore, type RepoView } from '../lib/store'
import { AiTargetButton } from './AiTargetButton'
import { Button, CM, DM, SectionHeader, Spinner } from './ui'

/**
 * Recompose with AI: the AI proposes a new set of commits for the selected
 * ones, and you shape it before anything changes. The proposed commits are a list on the left,
 * newest at the top and oldest at the bottom like the graph; the selected one's message and
 * hunks on the right. Drag a commit to reorder (the list makes room as you go), drag a hunk onto
 * a commit to move it there or into the space above the newest commit to start a new one; Shift-click several commits and right-click to squash them.
 *
 * However the plan is edited, every change stays in exactly one commit (lib/recomposeDraft.ts),
 * so the new commits add up to the same final code; main checks that again, and Undo puts the
 * old commits back.
 */

/**
 * The plan, in the middle of the window (ADR-010), where the review and the walkthrough are:
 * it is a result you work in, not a question to answer, and keeping it there is what lets the
 * chat's history put it back on screen later.
 */
export function RecomposeView({ view }: { view: RepoView }) {
  const state = useAi((s) => s.recompose)
  const leave = () => updateRepo(view.id, { center: { kind: 'graph' } })
  /** What Esc does, as of this render (the listener below is registered once). */
  const hideRef = useRef<() => void>(leave)
  // Esc leaves the view, as it leaves a diff. From inside a field it only leaves the field
  // first, so typing a message is never one key away from losing the screen; a drag has already
  // taken the key in the capture phase (it cancels itself).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const a = document.activeElement
      if (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) return a.blur()
      hideRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (!state || state.repoId !== view.id) {
    hideRef.current = leave
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground" data-testid="recompose-empty">
        <p>No plan here. Select commits and ask for a recompose in the AI chat.</p>
        <Button onClick={leave}>Back to the graph</Button>
      </div>
    )
  }
  /** Explicit: stop the request, or throw the plan away. */
  const discard = () => {
    if (state.requestId) cancelAi(state.requestId)
    useAi.setState({ recompose: null })
    dropFinishedJob('recompose')
    leave()
  }
  const n = state.hashes.length
  const title = `Recompose ${n === 1 ? '1 commit' : `${n} commits`}`
  // Leaving the view keeps the request (its job is running) or the plan and its edits (back on
  // the jobs list). An error has been read: leaving ends it.
  const hide = () => {
    if (state.error) return discard()
    leave()
    const plan = state.proposal
    if (plan) {
      parkJob({
        id: crypto.randomUUID(), repoId: state.repoId, key: 'recompose', title, open: showRecompose,
        showing: () => useAi.getState().recompose?.proposal === plan && showingRecompose(state.repoId),
      })
    }
  }
  // A new pick while it is still asking: ask the new pick instead (recomposeWithAi stops the old request and its job).
  const restart = () => {
    recomposeWithAi(state.repoId, state.hashes, state.threadId ? { thread: state.threadId } : {})
  }
  hideRef.current = hide
  return (
    <div data-testid="recompose-view" className="flex min-h-0 flex-1 flex-col p-3 text-sm">
      {state.proposal ? (
        <Review key={state.requestId ?? 'review'} repoId={state.repoId} proposal={state.proposal} close={discard} threadId={state.threadId} incoming={state.incoming} />
      ) : state.error ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 text-destructive" data-testid="recompose-error"><CircleAlert size={15} className="mt-px shrink-0" /> {state.error}</div>
          <div className="flex items-center gap-2">
            <AiTargetButton area="recompose" className="mr-auto" />
            <Button onClick={discard}>Close</Button>
            <Button variant="primary" onClick={restart}>Try again</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-muted-foreground"><Spinner /> {title}: asking the AI how to split these changes into commits…</div>
          <p className="text-xs text-hint">You can look at something else; the plan waits in the status bar.</p>
          <div className="flex items-center gap-2">
            <AiTargetButton area="recompose" onPicked={restart} className="mr-auto" />
            <Button onClick={discard} data-testid="recompose-stop">Stop</Button>
            <Button variant="primary" onClick={hide} data-testid="recompose-hide">Close</Button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The editor's work on each proposal, so hiding the dialog (Esc, a click outside) and opening it
 * again later keeps every edit. Keyed by the proposal object: a new plan starts fresh.
 */
const edits = new WeakMap<RecomposeProposal, { hist: History<Draft>; nonce?: number }>()

type Over = number | 'new' | null

/** What is being dragged, for rendering: the empty slot it left, and (for a hunk) where it would land. */
type DragView = { kind: 'commit'; index: number } | { kind: 'unit'; id: string; over: Over }

/** The imperative side of a drag: the pressed element, the pointer offset, the floating clone. */
interface Lift {
  kind: 'commit' | 'unit'
  /** A commit's index (kept up to date as it is reordered live), or a unit's id. */
  key: number | string
  /** For a unit, the commit it comes from: dropping it back there is not a move. */
  from: number
  el: HTMLElement
  startX: number
  startY: number
  offsetX: number
  offsetY: number
  left: number
  top: number
  ghost: HTMLElement | null
  over: Over
}

const isMac = window.gitgoose?.platform === 'darwin'
const TIMING: KeyframeAnimationOptions = { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' }
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const ROW = '[data-testid="recompose-commit"]'
const NEW_ZONE = '[data-testid="recompose-new-commit"]'
/** The commits column is w-80. */
const UNIT_GHOST_W = 304

/** Fly the floating clone to where its content landed (or back where it came from), then remove it. */
function settle(ghost: HTMLElement, from: { left: number; top: number }, to: DOMRect | null, fade: boolean, done: () => void) {
  const cleanup = () => { ghost.remove(); done() }
  if (!to || reducedMotion()) return cleanup()
  const motion = ghost.animate(
    [{ transform: `translate3d(${from.left}px,${from.top}px,0)`, opacity: 1 }, { transform: `translate3d(${to.left}px,${to.top}px,0)`, opacity: fade ? 0.3 : 1 }],
    { ...TIMING, fill: 'forwards' },
  )
  motion.finished.then(cleanup, cleanup)
}

function Review({ repoId, proposal, close, threadId, incoming }: {
  repoId: string; proposal: RecomposeProposal; close: () => void
  /** The conversation the proposal came from: the AI pane carries on in it. */
  threadId?: string
  /** A plan applied from the chat. */
  incoming?: { commits: RecomposeProposal['commits']; nonce: number }
}) {
  /** The plan, with everything done to it so far (Ctrl+Z / Ctrl+Shift+Z step through); as it was if the dialog was hidden. */
  // A restored history starts a fresh burst: its last drag's key must not merge with the next
  // drag (the drag counter starts again from 0), or one undo would take back both.
  const [hist, setHist] = useState<History<Draft>>(() => {
    const saved = edits.get(proposal)?.hist
    return saved ? { ...saved, key: null } : history(structuredClone(proposal.commits))
  })
  /** The proposal `hist` started from, and the last plan taken from the chat: a remount must not apply either again. */
  const base = useRef(proposal)
  const taken = useRef(edits.get(proposal)?.nonce)
  const draft = hist.present
  useEffect(() => void edits.set(proposal, { hist, nonce: taken.current }), [proposal, hist])
  /** The commit shown on the right. */
  const [cursor, setCursor] = useState(0)
  /** The selected commits (Shift-click a range, Ctrl/Cmd-click to add); the cursor is one of them. */
  const [picked, setPicked] = useState<number[]>([0])
  const [anchor, setAnchor] = useState(0)
  const [drag, setDrag] = useState<DragView | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const lift = useRef<Lift | null>(null)
  /** Row tops before a live reorder, so the other rows can slide into their new places. */
  const slide = useRef<{ tops: number[]; from: number; to: number } | null>(null)
  const drags = useRef(0)
  /**
   * Set when a drag ends: the click that follows the release is not a click on a row. (The rows
   * around the dropped one are still sliding into place, so it can land on a different one.)
   */
  const dropped = useRef(false)
  /** Clear the drag view once a clone has settled, unless a newer drag has started since. */
  const settled = (token: number) => () => { if (drags.current === token) setDrag(null) }
  const busy = useStore((s) => !!s.repos[repoId]?.busy)
  // Recompose rewrites the checked-out branch. A plan put aside can come back after a checkout:
  // then it is for another branch, and applying it here would rewrite the wrong one.
  const headBranch = useStore((s) => s.repos[repoId]?.snapshot.head.branch ?? null)
  const wrongBranch = headBranch !== proposal.branch
  useEffect(() => {
    if (base.current === proposal) return
    base.current = proposal
    setHist(history(structuredClone(proposal.commits)))
  }, [proposal])
  // A plan from the chat replaces the editor's plan as one step: Undo goes back to what you had.
  useEffect(() => {
    if (!incoming || incoming.nonce === taken.current) return
    taken.current = incoming.nonce
    setHist((h) => push(h, structuredClone(incoming.commits)))
    setCursor(0)
    setPicked([0])
    setAnchor(0)
  }, [incoming?.nonce])
  const units = useMemo(() => new Map(proposal.units.map((u) => [u.id, u])), [proposal])
  const order = useMemo(() => proposal.units.map((u) => u.id), [proposal])
  const problems = draftProblems(draft)
  const sel = Math.min(cursor, draft.length - 1)
  const current = draft[sel]
  const pickedSet = useMemo(() => new Set(picked.filter((i) => i < draft.length)), [picked, draft.length])

  /** Change the plan, as one undo step; edits sharing a `key` (typing, a drag) collapse into one. */
  const update = (f: (d: Draft) => Draft, key?: string) => setHist((h) => push(h, f(h.present), key))
  const stepBack = () => setHist(undo)
  const stepForward = () => setHist(redo)
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!(isMac ? e.metaKey : e.ctrlKey)) return
    const k = e.key.toLowerCase()
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); stepBack() }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); e.stopPropagation(); stepForward() }
  }
  /** Select just commit `i` and show it. */
  const focus = (i: number) => { setCursor(i); setPicked([i]); setAnchor(i) }
  const select = (i: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    if (e.shiftKey) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)]
      setPicked(Array.from({ length: b - a + 1 }, (_, k) => a + k))
      setCursor(i)
    } else if (e.ctrlKey || e.metaKey) {
      setPicked((p) => (p.includes(i) ? (p.length > 1 ? p.filter((x) => x !== i) : p) : [...p, i]))
      setCursor(i)
      setAnchor(i)
    } else focus(i)
  }
  const squashPicked = () => {
    const first = Math.min(...pickedSet)
    update((d) => squashCommits(d, [...pickedSet], order))
    focus(first)
  }

  const apply = async () => {
    if (wrongBranch) return
    const ok = await run(repoId, 'Recompose', () => api.recomposeApply(repoId, proposal.hashes, draft), { quiet: true })
    if (ok) {
      close()
      toast({ kind: 'success', title: `Recomposed into ${draft.length} ${draft.length === 1 ? 'commit' : 'commits'}` })
      const head = useStore.getState().repos[repoId]?.snapshot.head.hash
      if (head) updateRepo(repoId, { selected: { kind: 'commit', hash: head } })
    }
  }

  // ---- Drag and drop, with the pointer rather than HTML5 drag events, so the dragged card can
  // stay in the list as an empty slot while a clone of it follows the pointer, and the other
  // rows slide out of its way. A press that moves less than 5px is a click.
  // The list shows the plan newest at the top, oldest at the bottom, the way the graph does; the
  // draft itself stays oldest first (the order the commits are made in). rows() is in draft order,
  // so rows()[i] is commit i wherever it is drawn.
  const rows = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>(ROW) ?? []).sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
  const rowRect = (i: number) => rows()[i]?.getBoundingClientRect() ?? null

  const endLift = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    window.removeEventListener('keydown', onKey, true)
    document.body.classList.remove('sorting')
    lift.current = null
  }
  // Unmounting mid-drag (Esc closes the dialog): no clone or listeners left behind.
  useEffect(() => () => { lift.current?.ghost?.remove(); endLift() }, [])

  const beginLift = (e: ReactPointerEvent<HTMLElement>, kind: Lift['kind'], key: number | string, from: number) => {
    // Buttons and the diff text inside a card do their own thing.
    if (e.button !== 0 || lift.current || (e.target as HTMLElement).closest('button, pre, textarea')) return
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    lift.current = { kind, key, from, el, startX: e.clientX, startY: e.clientY, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top, left: rect.left, top: rect.top, ghost: null, over: null }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('keydown', onKey, true)
  }

  /** Esc mid-drag: the clone flies back, a live reorder is undone, and the dialog stays open. */
  const onKey = (e: KeyboardEvent) => {
    const l = lift.current
    if (e.key !== 'Escape' || !l) return
    e.preventDefault()
    e.stopPropagation()
    endLift()
    if (!l.ghost) return
    if (l.kind === 'commit') {
      setHist((h) => (h.key === `drag:${drags.current}` ? undo(h) : h))
      focus(l.from)
      // The rows are back where they were once React has rendered the undone plan.
      requestAnimationFrame(() => settle(l.ghost!, l, rowRect(l.from), false, settled(drags.current)))
    } else settle(l.ghost, l, l.el.getBoundingClientRect(), false, settled(drags.current))
  }

  const onMove = (e: PointerEvent) => {
    const l = lift.current
    if (!l) return
    if (!l.ghost) {
      if (Math.hypot(e.clientX - l.startX, e.clientY - l.startY) < 5) return
      const ghost = document.createElement('div')
      ghost.className = 'drag-float'
      ghost.setAttribute('aria-hidden', 'true')
      const clone = l.el.cloneNode(true) as HTMLElement
      clone.removeAttribute('data-testid')
      if (l.kind === 'unit') {
        // Only the header travels (not a screenful of diff), as wide as the commit it will land on.
        while (clone.children.length > 1) clone.lastElementChild!.remove()
        ghost.style.width = `${Math.min(l.el.offsetWidth, UNIT_GHOST_W)}px`
        l.offsetX = Math.min(l.offsetX, UNIT_GHOST_W - 24)
      } else ghost.style.width = `${l.el.offsetWidth}px`
      ghost.appendChild(clone)
      document.body.appendChild(ghost)
      document.body.classList.add('sorting')
      l.ghost = ghost
      drags.current++
      if (l.kind === 'commit') { focus(l.key as number); setDrag({ kind: 'commit', index: l.key as number }) }
      else setDrag({ kind: 'unit', id: l.key as string, over: null })
    }
    l.left = e.clientX - l.offsetX
    l.top = e.clientY - l.offsetY
    l.ghost.style.transform = `translate3d(${l.left}px,${l.top}px,0)`
    if (l.kind === 'commit') {
      // The slot moves to wherever the clone's middle is, live; the rows in between slide over.
      // Positions on screen run the other way from the draft: work in screen order, top to bottom.
      const all = rows()
      const last = all.length - 1
      const from = l.key as number
      const center = l.top + l.ghost.offsetHeight / 2
      let at = [...all].reverse().findIndex((r) => { const b = r.getBoundingClientRect(); return center < b.top + b.height / 2 })
      if (at < 0) at = last
      else if (at > last - from) at--
      const to = last - at
      if (to !== from) {
        slide.current = { tops: all.map((r) => r.getBoundingClientRect().top), from, to }
        l.key = to
        update((d) => moveCommit(d, from, to), `drag:${drags.current}`)
        focus(to)
        setDrag({ kind: 'commit', index: to })
      }
    } else {
      // A hunk lands on the commit under the pointer, or in the open space below the list.
      const under = document.elementFromPoint(e.clientX, e.clientY)
      const row = under?.closest<HTMLElement>(ROW)
      let over: Over = row ? Number(row.dataset.index) : under?.closest(NEW_ZONE) ? 'new' : null
      if (over === l.from) over = null
      if (over !== l.over) { l.over = over; setDrag({ kind: 'unit', id: l.key as string, over }) }
    }
  }

  const onUp = () => {
    const l = lift.current
    if (!l) return
    endLift()
    if (!l.ghost) return // a click
    dropped.current = true
    setTimeout(() => { dropped.current = false })
    let dest: DOMRect | null
    let fade = false
    if (l.kind === 'commit') dest = rowRect(l.key as number)
    else {
      const id = l.key as string
      if (typeof l.over === 'number') { const to = l.over; dest = rowRect(to); fade = true; update((d) => moveUnit(d, id, to, order)) }
      else if (l.over === 'new') { dest = listRef.current?.querySelector(NEW_ZONE)?.getBoundingClientRect() ?? null; fade = true; update((d) => moveUnit(d, id, d.length, order)) }
      else dest = l.el.getBoundingClientRect() // nowhere: back to its slot
    }
    settle(l.ghost, l, dest, fade, settled(drags.current))
  }

  // FLIP: after a live reorder, every other row starts where it was and slides to where it is now.
  useLayoutEffect(() => {
    const s = slide.current
    if (!s) return
    slide.current = null
    if (reducedMotion()) return
    rows().forEach((row, n) => {
      if (n === s.to) return
      const lo = Math.min(s.from, s.to)
      const hi = Math.max(s.from, s.to)
      const was = n < lo || n > hi ? n : s.from < s.to ? n + 1 : n - 1
      const dy = (s.tops[was] ?? 0) - row.getBoundingClientRect().top
      if (dy) row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], TIMING)
    })
  }, [draft])

  const draggingUnit = drag?.kind === 'unit'
  const empties = draft.filter((c) => !c.units.length).length

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-drag={drag?.kind} onKeyDown={onKeyDown}>
      <div className="mb-2 flex items-center gap-1 text-xs">
        <Button size="sm" variant="ghost" disabled={!hist.past.length} onClick={stepBack} title={`Undo (${isMac ? '⌘' : 'Ctrl+'}Z)`} data-testid="recompose-undo"><Undo2 size={12} /> Undo</Button>
        <Button size="sm" variant="ghost" disabled={!hist.future.length} onClick={stepForward} title={`Redo (${isMac ? '⌘⇧' : 'Ctrl+Shift+'}Z)`} data-testid="recompose-redo"><Redo2 size={12} /> Redo</Button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={!hist.past.length} onClick={() => { update(() => structuredClone(proposal.commits)); focus(0) }} data-testid="recompose-reset"
          title="Back to what the AI proposed"><RotateCcw size={12} /> Reset to proposal</Button>
        {threadId && (
          <Button size="sm" variant="ghost" onClick={() => openInPanel(repoId, threadId)} data-testid="open-chat"
            title='Ask the AI to change the plan in the AI pane ("put the tests in their own commit")'><MessagesSquare size={12} /> Chat</Button>
        )}
      </div>
      {proposal.onRemote.length > 0 && (
        <p className="mb-2 flex items-start gap-1.5 rounded bg-warn/10 px-2 py-1.5 text-xs text-warn" data-testid="recompose-remote">
          <CircleAlert size={13} className="mt-px shrink-0" />
          {proposal.onRemote.join(', ')} already {proposal.onRemote.length === 1 ? 'has' : 'have'} these commits. After recomposing, pushing {proposal.branch} needs a force-push, which GitGoose will not do for you.
        </p>
      )}
      {proposal.unplaced.length > 0 && (
        <p className="mb-2 text-xs text-muted-foreground">The AI left {proposal.unplaced.length} {proposal.unplaced.length === 1 ? 'change' : 'changes'} out; {proposal.unplaced.length === 1 ? 'it was' : 'they were'} added to the last commit.</p>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border border-border">
        {/* The proposed commits, applied bottom to top (oldest at the bottom, as in the graph). While a hunk is in the air this column is
            the only place it can go, so everything else dims. */}
        <div className="flex w-80 shrink-0 flex-col border-r border-border bg-card" data-testid="recompose-commits-column">
          {/* One line, never wrapping: a hint that changed the header's height would move the rows
              under the pointer mid-drag and flip the drop target back and forth. */}
          <SectionHeader className="whitespace-nowrap"
            right={<span className="min-w-0 truncate font-normal text-hint">
              {draggingUnit ? <span className="text-primary">drop on a commit, or above for a new one</span> : `${draft.length}, oldest at the bottom`}
            </span>}>Commits</SectionHeader>
          <ContextMenu.Root>
            <ContextMenu.Trigger asChild>
              {/* Focusable, so a click or drag on a row keeps focus in the dialog and Ctrl+Z still reaches it. */}
              <ol ref={listRef} tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2 outline-none" data-testid="recompose-commits">
                {/* Above the newest commit: drop a hunk here to start a new commit with it. */}
                {draggingUnit && (
                  <li data-testid="recompose-new-commit" data-target={drag.over === 'new' || undefined}
                    className={clsx('mt-1 flex min-h-16 shrink-0 items-center justify-center gap-1.5 rounded-md border border-dashed text-xs',
                      drag.over === 'new' ? 'border-primary bg-primary/15 text-foreground' : 'border-muted-foreground/70 text-muted-foreground')}>
                    <Plus size={12} /> New commit
                  </li>
                )}
                {draft.map((c, i) => ({ c, i })).reverse().map(({ c, i }) => {
                  const stats = c.units.reduce((s, id) => ({ add: s.add + (units.get(id)?.added ?? 0), del: s.del + (units.get(id)?.removed ?? 0) }), { add: 0, del: 0 })
                  const files = new Set(c.units.map((id) => units.get(id)?.path)).size
                  const isSlot = drag?.kind === 'commit' && drag.index === i
                  const target = drag?.kind === 'unit' && drag.over === i
                  return (
                    <li key={i} data-testid="recompose-commit" data-index={i} data-selected={pickedSet.has(i) || undefined} data-target={target || undefined}
                      onPointerDown={(e) => beginLift(e, 'commit', i, i)}
                      onClick={(e) => { if (!dropped.current) select(i, e) }}
                      onContextMenu={() => { if (!pickedSet.has(i)) focus(i) }}
                      className={clsx('group relative mt-1 flex shrink-0 cursor-grab gap-2 rounded-md border px-2 py-1.5 select-none',
                        isSlot && 'drag-placeholder',
                        target ? 'border-primary bg-primary/15' : pickedSet.has(i) ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-accent',
                        !c.units.length && !target && 'border-dashed border-destructive/50')}>
                      <GripVertical size={13} className="mt-0.5 shrink-0 text-hint opacity-0 group-hover:opacity-100" />
                      <span className="mt-px w-4 shrink-0 text-right font-mono text-2xs text-hint">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className={clsx('truncate', !c.message.trim() && 'text-hint italic')} data-testid="recompose-title">{c.message.split('\n')[0] || 'No message yet'}</div>
                        <div className="mt-0.5 flex gap-2 text-2xs text-hint">
                          {c.units.length ? <><span>{files} {files === 1 ? 'file' : 'files'}</span><span className="text-add">+{stats.add}</span><span className="text-destructive">−{stats.del}</span></>
                            : <span className="text-destructive">No changes</span>}
                        </div>
                      </div>
                      <div className={clsx('flex shrink-0 flex-col opacity-0 group-hover:opacity-100 group-data-[selected]:opacity-100', draggingUnit && 'hidden')}>
                        {/* Up is later (newer), as in the graph. */}
                        <button title="Later" disabled={i === draft.length - 1} onClick={(e) => { e.stopPropagation(); update((d) => moveCommit(d, i, i + 1)); focus(i + 1) }}
                          className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30" data-testid="recompose-up"><ArrowUp size={12} /></button>
                        <button title="Earlier" disabled={i === 0} onClick={(e) => { e.stopPropagation(); update((d) => moveCommit(d, i, i - 1)); focus(i - 1) }}
                          className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30" data-testid="recompose-down"><ArrowDown size={12} /></button>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </ContextMenu.Trigger>
            <CM.Content>
              <CM.Label>{pickedSet.size === 1 ? `Commit ${sel + 1}: ${current?.message.split('\n')[0] || 'no message'}` : `${pickedSet.size} commits selected`}</CM.Label>
              <CM.Item disabled={pickedSet.size < 2} onSelect={squashPicked}>
                {pickedSet.size < 2 ? 'Squash… (Shift-click to select more)' : `Squash ${pickedSet.size} commits into one`}
              </CM.Item>
              <CM.Item disabled={!empties} onSelect={() => { update(removeEmpty); focus(0) }}>Remove {empties === 1 ? 'the empty commit' : 'empty commits'}</CM.Item>
            </CM.Content>
          </ContextMenu.Root>
          <div className="flex gap-1 border-t border-border p-2">
            <Button size="sm" variant="ghost" onClick={() => { update(addCommit); focus(draft.length) }} data-testid="recompose-add"><Plus size={12} /> New commit</Button>
            {empties > 0 && (
              <Button size="sm" variant="ghost" onClick={() => { update(removeEmpty); focus(0) }} data-testid="recompose-remove-empty"><Trash2 size={12} /> Remove empty</Button>
            )}
          </div>
        </div>

        {/* The selected commit: its message, and its hunks in full. Dimmed while a hunk is being
            dragged: nothing here takes a drop. */}
        {current && (
          <div className={clsx('flex min-w-0 flex-1 flex-col transition-opacity', draggingUnit && 'opacity-40')} data-testid="recompose-hunks-column">
            <SectionHeader right={<span className="font-normal text-hint">{current.units.length} in commit {sel + 1}</span>}>Hunks</SectionHeader>
            <div className="border-b border-border px-3 pb-3">
              <textarea key={sel} value={current.message} onChange={(e) => update((d) => editMessage(d, sel, e.target.value), `message:${sel}`)}
                rows={Math.max(2, Math.min(6, current.message.split('\n').length))} placeholder={`Message for commit ${sel + 1} (first line is the summary)`}
                className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-primary"
                data-testid="recompose-message" />
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="recompose-units">
              {current.units.length === 0 && (
                <div className="rounded-md border border-dashed border-border p-6 text-center text-xs text-hint">
                  No hunks yet. Open another commit and drag its hunks onto this one in the list, or use "Move to" on a hunk.
                </div>
              )}
              {current.units.map((id) => {
                const u = units.get(id)
                return u ? (
                  <UnitCard key={id} unit={u} draft={draft} here={sel} slot={drag?.kind === 'unit' && drag.id === id}
                    onPointerDown={(e) => beginLift(e, 'unit', id, sel)} onMove={(to) => update((d) => moveUnit(d, id, to, order))} />
                ) : null
              })}
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <p className="flex min-w-0 flex-1 items-center gap-1 text-xs text-hint">
          {wrongBranch ? (
            <span className="flex items-center gap-1 text-destructive" data-testid="recompose-wrong-branch"><CircleAlert size={12} className="shrink-0" /> This plan is for {proposal.branch}, but {headBranch ?? 'no branch'} is checked out. Check out {proposal.branch} to create these commits.</span>
          ) : problems.length ? (
            <span className="flex items-center gap-1 text-destructive" data-testid="recompose-problems"><CircleAlert size={12} className="shrink-0" /> {problems[0]}{problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}</span>
          ) : (
            <><Sparkles size={11} className="shrink-0" /> Replaces {proposal.hashes.length === 1 ? 'the commit' : `the ${proposal.hashes.length} commits`} on {proposal.branch}. Every change stays in exactly one commit, so the final code is the same; your working tree is not touched, and Undo puts the old commits back.</>
          )}
        </p>
        <Button onClick={close} data-testid="recompose-discard">Discard</Button>
        <Button variant="primary" onClick={() => void apply()} disabled={busy || wrongBranch || problems.length > 0} data-testid="recompose-apply">
          Create {draft.length} {draft.length === 1 ? 'commit' : 'commits'}
        </Button>
      </div>
    </div>
  )
}

/** One hunk (or a whole file): its diff, dragged by its header onto a commit, or moved with "Move to". */
function UnitCard({ unit, draft, here, slot, onPointerDown, onMove }: {
  unit: RecomposeUnitInfo; draft: Draft; here: number; slot: boolean; onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void; onMove: (to: number) => void
}) {
  const { dir, name } = splitPath(unit.path)
  return (
    <div className={clsx('overflow-hidden rounded-md border border-border bg-background', slot && 'drag-placeholder')} data-testid="recompose-unit" data-unit={unit.id}
      onPointerDown={onPointerDown}>
      <div className="flex cursor-grab items-center gap-2 border-b border-border bg-card px-2 py-1 text-xs select-none">
        <GripVertical size={12} className="shrink-0 text-hint" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs"><span className="text-hint">{dir}</span>{name}</span>
        {unit.binary ? <span className="text-hint">binary</span> : <><span className="text-add">+{unit.added}</span><span className="text-destructive">−{unit.removed}</span></>}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" data-testid="recompose-move">Move to…</button>
          </DropdownMenu.Trigger>
          <DM.Content align="end">
            {/* Newest first, like the list. */}
            <DM.Item onSelect={() => onMove(draft.length)}>A new commit</DM.Item>
            <DM.Separator />
            {draft.map((c, i) => ({ c, i })).reverse().map(({ c, i }) => i === here ? null : (
              <DM.Item key={i} onSelect={() => onMove(i)}>{i + 1}. {c.message.split('\n')[0] || '(no message)'}</DM.Item>
            ))}
          </DM.Content>
        </DropdownMenu.Root>
      </div>
      {unit.preview ? (
        <pre className="selectable max-h-72 overflow-auto py-1 font-mono text-2xs leading-[1.45]">
          {unit.preview.split('\n').map((l, i) => (
            <div key={i} className={clsx('px-2', l.startsWith('+') ? 'bg-add-bg text-add' : l.startsWith('-') ? 'bg-del-bg text-destructive' : l.startsWith('@@') ? 'text-primary' : l.startsWith('…') ? 'text-hint italic' : 'text-muted-foreground')}>
              {l || ' '}
            </div>
          ))}
        </pre>
      ) : <div className="px-2 py-1.5 text-xs text-hint">{unit.binary ? 'A binary file.' : 'The whole file (a mode change, or an empty file).'}</div>}
    </div>
  )
}
