import type { AskThread } from '@gitgoose/shared'
import { updateRepo } from './store'

/**
 * Ask about lines: a thread with an ask anchor (the lines, at the commit they were read at),
 * docked under the diff. Its first message is Ask's own prompt with the question in it; the
 * follow-ups go to the same agent session. Answered threads are listed with their commit.
 */

/** Open a new question thread about these lines. */
export function askAbout(id: string, rev: string | null, path: string, startLine: number, endLine: number, code: string): void {
  updateRepo(id, { ask: { anchor: { kind: 'ask', rev: rev ?? 'worktree', path, lines: [startLine, endLine], code }, path, threadId: null } })
}

/** Reopen a saved thread (from the commit's question list). */
export function openAsk(id: string, thread: AskThread): void {
  updateRepo(id, { ask: { anchor: { kind: 'ask', rev: thread.rev, path: thread.path, lines: [thread.startLine, thread.endLine], code: thread.code }, path: thread.path, threadId: thread.id } })
}

export function closeAsk(id: string): void {
  updateRepo(id, { ask: null })
}
