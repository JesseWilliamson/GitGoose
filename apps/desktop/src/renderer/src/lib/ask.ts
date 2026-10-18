import type { AskThread } from '@gitsquid/shared'
import { api, toUiError } from './api'
import { startAi } from './ai'
import { updateRepo } from './store'

/** Open a thread under the diff (a new one, or one from the commit's question list). */
export function openAsk(id: string, thread: AskThread): void {
  updateRepo(id, { ask: thread })
}

export function closeAsk(id: string): void {
  updateRepo(id, { ask: null })
}

export function newThread(rev: string | null, path: string, startLine: number, endLine: number, code: string): AskThread {
  return { id: crypto.randomUUID(), rev: rev ?? 'worktree', path, startLine, endLine, code, messages: [], updated: Date.now() }
}

/**
 * Ask a question in a thread: the answer streams into the thread, which is saved (pinned to its
 * commit) once answered. Earlier messages go along, so follow-ups work.
 */
export async function askInThread(id: string, thread: AskThread, question: string, onUpdate: (t: AskThread) => void): Promise<void> {
  const asked: AskThread = { ...thread, messages: [...thread.messages, { role: 'user', text: question }], updated: Date.now() }
  onUpdate({ ...asked, messages: [...asked.messages, { role: 'ai', text: '' }] })
  const run = startAi(id, {
    kind: 'ask', rev: thread.rev === 'worktree' ? null : thread.rev, path: thread.path, startLine: thread.startLine, endLine: thread.endLine,
    question, earlier: thread.messages,
  }, (text) => onUpdate({ ...asked, messages: [...asked.messages, { role: 'ai', text }] }))
  try {
    const res = await run.done
    if (!res) return onUpdate(thread)
    const done: AskThread = { ...asked, messages: [...asked.messages, { role: 'ai', text: res.text }], updated: Date.now() }
    onUpdate(done)
    await api.saveAskThread(id, done)
    updateRepo(id, (v) => ({ askThreads: [done, ...v.askThreads.filter((t) => t.id !== done.id)] }))
  } catch (e) {
    onUpdate({ ...asked, messages: [...asked.messages, { role: 'ai', text: `(${toUiError(e).message})` }] })
  }
}
