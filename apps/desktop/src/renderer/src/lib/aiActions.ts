import type { ReviewScope, ThreadAnchor } from '@gitgoose/shared'
import { scopeLabel } from './ai'
import { explainCommit } from './explain'
import { showImpact } from './impact'
import { focusAiComposer, showAiPane } from './panes'
import { recomposeWithAi } from './recompose'
import { startReview } from './review'
import { updateRepo } from './store'
import { startWalkthrough } from './walkthrough'

/**
 * Every AI action, in one place, and every one of them is a chat.
 *
 * A menu item does not send anything. It *composes*: the AI pane comes forward with a new
 * conversation about the right thing and its request already written in the message box, and
 * nothing leaves the machine until the user presses Enter. That one rule is what makes the
 * feature honest — you always see what you are about to ask for, and you can change it first
 * ("review this, but only the error handling") — and it is also what makes the conversation
 * and the result one thing instead of two: the feature's request is the chat's first turn, so
 * the chat's history is a log of everything the AI has ever been asked here.
 *
 * `prompt` is the seed for the message box, so it reads as something a person would write.
 * `run` is what pressing Enter does: the feature's own request (with its JSON answer format and
 * its verifier), carrying the user's words and running inside the conversation already open.
 */

export type AiActionName = 'explain' | 'review' | 'walkthrough' | 'impact' | 'recompose'

export interface AiAction {
  name: AiActionName
  /** The conversation this action starts: the chat opens with this anchor, not a free one. */
  anchor: ThreadAnchor
  /** The pill above the composer, and the menu item's own words. */
  label: string
  /** Seeded into the message box, editable, and sent as the user's own words. */
  prompt: string
  /** Send it: the feature's request, in `threadId`, with whatever the user wrote. */
  run: (repoId: string, threadId: string, ask: string) => void
}

export function reviewAction(scope: ReviewScope): AiAction {
  const what = scopeLabel(scope)
  return {
    name: 'review',
    anchor: { kind: 'review', scope },
    label: `Review ${what}`,
    prompt: `Review ${what} and tell me what is wrong with it.`,
    run: (repoId, thread, ask) => startReview(repoId, scope, { thread, ask }),
  }
}

export function walkthroughAction(scope: ReviewScope): AiAction {
  const what = scopeLabel(scope)
  return {
    name: 'walkthrough',
    anchor: { kind: 'walkthrough', scope },
    label: `Walk through ${what}`,
    prompt: `Walk me through ${what}, in the order it makes sense to read.`,
    run: (repoId, thread, ask) => startWalkthrough(repoId, scope, { thread, ask }),
  }
}

export function impactAction(scope: ReviewScope): AiAction {
  const what = scopeLabel(scope)
  return {
    name: 'impact',
    anchor: { kind: 'impact', scope },
    label: `What could ${what} affect?`,
    prompt: `What could ${what} affect? Find the code elsewhere that uses what it changes.`,
    // Impact finds the call sites locally first (no AI); the view asks for the assessment.
    run: (repoId, thread, ask) => showImpact(repoId, scope, { thread, ask }),
  }
}

export function recomposeAction(hashes: string[]): AiAction {
  const what = hashes.length === 1 ? 'this commit' : `these ${hashes.length} commits`
  return {
    name: 'recompose',
    anchor: { kind: 'recompose', hashes },
    label: hashes.length === 1 ? 'Split this commit' : `Recompose ${hashes.length} commits`,
    prompt: hashes.length === 1
      ? 'Split this commit into the smallest commits that each stand on their own.'
      : `Propose a better series of commits for ${what}.`,
    run: (repoId, thread, ask) => recomposeWithAi(repoId, hashes, { thread, ask }),
  }
}

export function explainAction(hash: string): AiAction {
  return {
    name: 'explain',
    anchor: { kind: 'explain', hash },
    label: `Explain ${hash.slice(0, 7)}`,
    prompt: `Explain commit ${hash.slice(0, 7)}: what it changes and why.`,
    run: (repoId, thread, ask) => explainCommit(repoId, hash, { thread, ask }),
  }
}

/**
 * Put an action in the AI pane's composer, ready to send. Nothing is sent, no agent is started
 * and no request goes out: the pane comes forward with a new conversation about this, the words
 * in the box and the cursor in it.
 */
export function composeAction(repoId: string, action: AiAction): void {
  updateRepo(repoId, { chat: { threadId: null, nonce: Date.now(), pending: action } })
  showAiPane()
  focusAiComposer()
}

/**
 * The action that would ask this conversation's question again, for the "out of date" banner's
 * Ask again. Null for a conversation with nothing to re-run (a chat, an error, a conflict).
 */
export function actionForAnchor(anchor: ThreadAnchor): AiAction | null {
  switch (anchor.kind) {
    case 'review':
    case 'changestack': return reviewAction(anchor.scope)
    case 'walkthrough': return walkthroughAction(anchor.scope)
    case 'impact': return impactAction(anchor.scope)
    case 'recompose': return recomposeAction(anchor.hashes)
    case 'explain': return explainAction(anchor.hash)
    default: return null
  }
}
