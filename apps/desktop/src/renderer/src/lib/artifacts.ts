import type { AiArtifactResult, ReviewFinding } from '@gitgoose/shared'
import { useAi } from './ai'
import { toast, updateRepo, useStore } from './store'

/**
 * What Apply does with an artifact a conversation sent, once main has checked it with the
 * feature's own verifier (AiService.checkArtifact). Each one changes only the view's state, and
 * each can be taken back: findings and walkthroughs offer Undo, a plan is one step of the
 * recompose editor's own undo, a commit message is one Undo in the commit box. Nothing changes
 * in the repository until the user acts on the result as usual.
 */
export function applyArtifact(repoId: string, a: AiArtifactResult): boolean {
  switch (a.kind) {
    case 'findings': return mergeFindings(repoId, a.review.findings)
    case 'plan': {
      const rc = useAi.getState().recompose
      if (!rc?.proposal || rc.repoId !== repoId || rc.hashes.join() !== a.recompose.hashes.join()) {
        toast({ kind: 'info', title: 'Open the recompose plan for these commits to apply a new one.' })
        return false
      }
      // Shown, in case the user was looking elsewhere: the plan just changed in the editor.
      useAi.setState({ recompose: { ...rc, incoming: { commits: a.recompose.commits, nonce: Date.now() } } })
      updateRepo(repoId, { center: { kind: 'recompose' } })
      return true
    }
    case 'walkthrough': {
      const before = useStore.getState().repos[repoId]?.walkthrough
      if (!before) return false
      updateRepo(repoId, { walkthrough: { ...before, result: a.walkthrough, fromChat: true } })
      toast({ kind: 'success', title: 'Walkthrough updated from the chat', action: { label: 'Undo', run: () => updateRepo(repoId, { walkthrough: before }) } })
      return true
    }
    case 'commit-message':
      // The commit box takes it (and offers Undo); show the box.
      useAi.setState({ draft: { repoId, message: a.message, nonce: Date.now() } })
      updateRepo(repoId, { selected: { kind: 'wip' }, center: { kind: 'graph' } })
      return true
    case 'diagram':
    case 'problem':
      return false
  }
}

/**
 * Findings from a chat join the review on screen, marked "from chat"; one already there (same
 * file, lines and title) is not added twice. Their ids continue the review's (C1, C2, …).
 */
function mergeFindings(repoId: string, incoming: ReviewFinding[]): boolean {
  const before = useStore.getState().repos[repoId]?.review
  if (!before?.result) {
    toast({ kind: 'info', title: 'Open the review these findings belong to first.' })
    return false
  }
  const have = before.result.findings
  const same = (a: ReviewFinding, b: ReviewFinding) => a.path === b.path && a.startLine === b.startLine && a.endLine === b.endLine && a.title === b.title
  const fresh = incoming.filter((f) => !have.some((h) => same(h, f)))
  const taken = have.filter((f) => f.fromChat).length
  const added = fresh.map((f, i) => ({ ...f, id: `C${taken + i + 1}`, fromChat: true }))
  if (!added.length) {
    toast({ kind: 'info', title: 'The review already has these findings.' })
    return false
  }
  updateRepo(repoId, { review: { ...before, result: { ...before.result, findings: [...have, ...added] } } })
  toast({ kind: 'success', title: `Added ${added.length} finding${added.length === 1 ? '' : 's'} from the chat`, action: { label: 'Undo', run: () => updateRepo(repoId, { review: before }) } })
  return true
}
