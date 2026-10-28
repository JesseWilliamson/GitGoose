import type { AiThread, ThreadAnchor, ThreadBasis } from './ai'

/**
 * Whether a saved conversation still describes the repository.
 *
 * Every AI action is a chat. A chat about a review, a plan, a walkthrough or an
 * impact owns a *result*, and reopening it puts that result back in the middle of the window —
 * but only while the result is still about this repository. A rebase, an amend or a new commit
 * can make a review's line numbers point at code that no longer exists, and showing it then
 * would be a lie that looks exactly like the truth.
 *
 * So each such thread records what its anchor resolved to when it started (`ThreadBasis`, made
 * by main/ai/basis.ts with read-only git), and these pure rules compare it with the same thing
 * worked out now. Out of date, the conversation is still there to read and to follow up — it is
 * marked, and its result is not restored.
 */

/** Anchors that own a view in the middle of the window, and so can go out of date. */
const RESTORABLE = ['review', 'changestack', 'walkthrough', 'impact', 'recompose'] as const

export type RestorableAnchor = (typeof RESTORABLE)[number]

export function isRestorable(anchor: ThreadAnchor): anchor is Extract<ThreadAnchor, { kind: RestorableAnchor }> {
  return (RESTORABLE as readonly string[]).includes(anchor.kind)
}

/** Which middle view a thread reopens into. */
export function centerOf(anchor: ThreadAnchor): 'review' | 'walkthrough' | 'impact' | 'recompose' | null {
  switch (anchor.kind) {
    case 'review':
    case 'changestack': return 'review'
    case 'walkthrough': return 'walkthrough'
    case 'impact': return 'impact'
    case 'recompose': return 'recompose'
    default: return null
  }
}

/**
 * Why a conversation's result can no longer be shown, in one sentence, or '' while it still
 * can. `now` is the basis worked out against the repository as it is; null means the anchor
 * could not be resolved at all (a branch that is gone, commits that were garbage collected).
 *
 * A thread with no basis of its own is one saved before this was recorded, or one whose anchor
 * owns no view: neither is restorable, and neither is called out as stale.
 */
export function staleReason(anchor: ThreadAnchor, was: ThreadBasis | undefined, now: ThreadBasis | null): string {
  if (!isRestorable(anchor) || !was) return ''
  if (!now) return was.ref ? `${shortRef(was.ref.name)} is gone.` : 'Those commits are no longer in the repository.'
  // A plan is for a set of commits on the branch it was made on: either moving is the same
  // thing happening, and it has one name the user will recognise.
  if (anchor.kind === 'recompose') {
    const moved = was.commits.join() !== now.commits.join() || (was.ref?.hash ?? '') !== (now.ref?.hash ?? '')
    return moved ? 'Those commits have been rewritten since.' : ''
  }
  if (was.ref && now.ref && was.ref.hash !== now.ref.hash) return `${shortRef(was.ref.name)} has moved since.`
  // A conversation about uncommitted work is about the index or the working tree *and* the
  // commit under them, and committing moves both: one sentence covers it, and it is the one
  // that describes what the user did.
  if (was.dirty !== undefined) {
    return was.dirty !== (now.dirty ?? '') || was.commits.join() !== now.commits.join() ? 'The uncommitted changes have changed since.' : ''
  }
  if (was.commits.join() !== now.commits.join()) return 'The commits have changed since.'
  return ''
}

/** "origin/main" from "refs/remotes/origin/main". */
function shortRef(name: string): string {
  return name.replace(/^refs\/(heads|remotes|tags)\//, '')
}

/**
 * A thread's result may be put back on screen: it has a view of its own, an answer in it, and
 * nothing has moved underneath. The reason is what the history list and the chat's banner show.
 *
 * A conversation with no basis is one saved before basis was recorded: there is no way to tell
 * whether its answer still holds, and "we do not know" is not "it is fine", so it is read-only
 * like any other old conversation.
 */
export function canRestore(thread: Pick<AiThread, 'anchor' | 'turns' | 'basis'>, stale: string): boolean {
  return !stale && !!thread.basis && !!centerOf(thread.anchor) && thread.turns.some((t) => t.role === 'agent' && t.status === 'done')
}
