import type { PushCheckPlan, PushCheckResult } from '@gitsquid/shared'
import { api, toUiError } from './api'
import { startAi } from './ai'
import { reportError, setting, updateRepo, useStore } from './store'

/**
 * Pre-push checks, between the Push button and git push. The secret scan runs in main (no AI);
 * the plain-language checks go to the AI as one request. What happens next depends only on the
 * results:
 *   - everything passed (or could not be judged, for checks that only warn): push
 *   - a check failed, or a blocking one could not be judged: show the results; Push / Cancel
 *   - a blocking check failed: show the results; Push anyway / Cancel
 * A check never blocks because the AI was unsure. Inconclusive is not a failure.
 */

/** Same rule as pushCheckOutcome in @gitsquid/git, kept here so the renderer needs no git code. */
export function outcome(results: PushCheckResult[]): 'go' | 'warn' | 'block' {
  if (results.some((r) => r.mode === 'block' && r.verdict === 'fail')) return 'block'
  if (results.some((r) => r.verdict === 'fail' || (r.mode === 'block' && r.verdict === 'inconclusive'))) return 'warn'
  return 'go'
}

const notJudged = (checks: PushCheckPlan['checks'], reason: string): PushCheckResult[] =>
  checks.map((c) => ({ name: c.name, mode: c.mode, source: c.source, verdict: 'inconclusive', reason, evidence: [] }))

async function judge(id: string, branch: string | undefined, plan: PushCheckPlan): Promise<PushCheckResult[]> {
  if (!plan.checks.length) return []
  // With AI off, the plain-language checks are skipped, not failed: a .coderabbit.yaml in a
  // repository must not make every push ask a question for someone who does not use AI.
  if (setting('aiProvider') === 'off') return []
  try {
    const res = await startAi(id, { kind: 'push-checks', branch, checks: plan.checks }).done
    return res?.pushChecks ?? notJudged(plan.checks, 'Not checked: the AI request did not run.')
  } catch (e) {
    return notJudged(plan.checks, `Not checked: ${toUiError(e).message}`)
  }
}

/** Run the checks for a push of `branch` (default: the current branch), then call `push` if they allow it. */
export async function withPushChecks(id: string, branch: string | undefined, push: () => void): Promise<void> {
  updateRepo(id, { busy: 'Running pre-push checks' })
  let plan: PushCheckPlan
  let results: PushCheckResult[]
  try {
    plan = await api.pushCheckPlan(id, branch)
    results = [...plan.local, ...(await judge(id, branch, plan))]
  } catch (e) {
    // A check that cannot even start must not stop the push silently either way: say why, offer it.
    updateRepo(id, { busy: null })
    reportError('Pre-push checks could not run', e, [{ label: 'Push without checks', variant: 'primary', run: push }])
    return
  } finally {
    updateRepo(id, { busy: null })
  }
  const next = outcome(results)
  if (next === 'go') return push()
  useStore.setState({ dialog: { kind: 'push-checks', repoId: id, label: plan.label, results, outcome: next, onPush: push } })
}
