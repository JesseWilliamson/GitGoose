import { ARTIFACT_KINDS, type AiBlock, type AiThread, type AiTurn, type AiUpdate, type ArtifactKind, type AskThread } from './ai'

/**
 * A thread is a fold over the agent's event stream. ACP's session/update is a stream of typed
 * events (text chunks, thoughts, tool calls, plans, permission questions); main turns each into
 * an AiUpdate and both sides apply it with this one function: main for the copy it keeps and
 * saves, the renderer for the copy it draws. Nothing else changes a thread, so the two copies
 * cannot drift, and every AI feature is "an anchor plus a first message" over the same code.
 *
 * Pure and immutable: a new thread (and new arrays along the changed path) per event, so React
 * sees what changed. Events for a turn the thread does not have are ignored.
 */
export function reduceThread(thread: AiThread, requestId: string, update: AiUpdate): AiThread {
  if (update.kind === 'turn') {
    if (thread.turns.some((t) => t.requestId === requestId)) return thread
    const user: AiTurn = {
      id: `${requestId}:u`, role: 'user', requestId, blocks: [{ type: 'text', text: update.text }], at: update.at,
      ...(update.feature ? { feature: update.feature } : {}), ...(update.sent ? { sent: update.sent } : {}),
    }
    const agent: AiTurn = {
      id: `${requestId}:a`, role: 'agent', requestId, blocks: [], status: 'running', at: update.at,
      ...(update.feature ? { feature: update.feature } : {}), ...(update.by ? { by: update.by } : {}),
    }
    const title = thread.title || update.feature || firstLine(update.text)
    return { ...thread, title, turns: [...thread.turns, user, agent], updatedAt: update.at }
  }
  if (update.kind === 'meta') {
    return {
      ...thread,
      ...(update.mode !== undefined ? { mode: update.mode } : {}),
      ...(update.commands ? { commands: update.commands } : {}),
      ...(update.target ? { target: update.target } : {}),
    }
  }
  const i = thread.turns.findIndex((t) => t.requestId === requestId && t.role === 'agent')
  if (i < 0) return thread
  const turn = thread.turns[i]!
  const next = reduceTurn(turn, update)
  if (next === turn) return thread
  const turns = thread.turns.slice()
  turns[i] = next
  return { ...thread, turns }
}

function reduceTurn(turn: AiTurn, u: Exclude<AiUpdate, { kind: 'turn' } | { kind: 'meta' }>): AiTurn {
  // A finished turn takes no more events (a late chunk after cancel, a duplicate done).
  if (turn.status !== 'running') return turn
  const blocks = turn.blocks
  switch (u.kind) {
    case 'text':
    case 'thought': {
      // Consecutive chunks of the same kind grow one block; text after a tool call starts a new
      // one, so the turn reads in the order things happened.
      const last = blocks.at(-1)
      if (last?.type === u.kind) return { ...turn, blocks: [...blocks.slice(0, -1), { type: u.kind, text: last.text + u.text }] }
      return { ...turn, blocks: [...blocks, { type: u.kind, text: u.text }] }
    }
    case 'tool': {
      const at = blocks.findIndex((b) => b.type === 'tool' && b.tool.id === u.tool.id)
      if (at < 0) return { ...turn, blocks: [...blocks, { type: 'tool', tool: u.tool }] }
      return { ...turn, blocks: replaceAt(blocks, at, { type: 'tool', tool: u.tool }) }
    }
    case 'plan': {
      // The agent sends the whole plan each time: one plan per turn, updated in place.
      const at = blocks.findIndex((b) => b.type === 'plan')
      const block: AiBlock = { type: 'plan', entries: u.entries }
      return { ...turn, blocks: at < 0 ? [...blocks, block] : replaceAt(blocks, at, block) }
    }
    case 'permission':
      return { ...turn, blocks: [...blocks, { type: 'permission', permission: u.permission }] }
    case 'permission-answered': {
      const at = blocks.findIndex((b) => b.type === 'permission' && b.permission.permissionId === u.permissionId)
      if (at < 0) return turn
      const b = blocks[at] as Extract<AiBlock, { type: 'permission' }>
      return { ...turn, blocks: replaceAt(blocks, at, { type: 'permission', permission: { ...b.permission, answer: u.answer } }) }
    }
    case 'done':
      return { ...turn, status: u.stopReason === 'cancelled' ? 'cancelled' : 'done', blocks: finish(blocks) }
    case 'error':
      return { ...turn, status: 'error', error: { message: u.message, ...(u.code ? { code: u.code } : {}) }, blocks: finish(blocks) }
  }
}

/** At the end of a turn: tagged blocks become artifacts, and questions nobody answered are moot. */
function finish(blocks: AiBlock[]): AiBlock[] {
  return blocks.flatMap((b): AiBlock[] =>
    b.type === 'text' ? splitArtifacts(b.text)
      : b.type === 'permission' && !b.permission.answer ? [{ type: 'permission', permission: { ...b.permission, answer: 'expired' } }]
      : [b])
}

function replaceAt<T>(list: T[], i: number, value: T): T[] {
  const out = list.slice()
  out[i] = value
  return out
}

const FENCE = /^```(json:[a-z-]+|mermaid)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm

/**
 * Split a reply into text and artifacts: every fenced block tagged ```json:<kind> with a kind we
 * know, and every ```mermaid block (a diagram), becomes an artifact block (its body unchecked:
 * main verifies it when the card asks).
 * Other fences, and unknown tags, stay in the text as code.
 */
export function splitArtifacts(text: string): AiBlock[] {
  const out: AiBlock[] = []
  let from = 0
  for (const m of text.matchAll(FENCE)) {
    const kind = (m[1] === 'mermaid' ? 'diagram' : m[1]!.slice('json:'.length)) as ArtifactKind
    // json:diagram is not a format any more: a diagram is Mermaid.
    if (!ARTIFACT_KINDS.includes(kind) || (kind === 'diagram' && m[1] !== 'mermaid')) continue
    const before = text.slice(from, m.index).trim()
    if (before) out.push({ type: 'text', text: before })
    out.push({ type: 'artifact', artifact: kind, json: m[2]! })
    from = m.index! + m[0].length
  }
  const rest = text.slice(from).trim()
  if (rest || !out.length) out.push({ type: 'text', text: from ? rest : text })
  return out
}

/** A turn's text as the agent wrote it, artifacts put back as their fences. */
export function turnText(turn: AiTurn): string {
  return turn.blocks.map((b) => (b.type === 'text' ? b.text : b.type === 'artifact' ? `\`\`\`${b.artifact === 'diagram' ? 'mermaid' : `json:${b.artifact}`}\n${b.json}\n\`\`\`` : '')).filter(Boolean).join('\n\n')
}

/**
 * The exchanges a new session must be told about, oldest first: each user turn whose answer
 * finished, with that answer. A turn that failed or was stopped is left out: there is no answer
 * to remember, and resending it could fail the same way (an agent that crashed on it).
 */
export function transcript(thread: AiThread): { user: string; agent: string }[] {
  const out: { user: string; agent: string }[] = []
  for (let i = 0; i + 1 < thread.turns.length; i++) {
    const u = thread.turns[i]!
    const a = thread.turns[i + 1]!
    if (u.role !== 'user' || a.role !== 'agent' || a.requestId !== u.requestId || a.status !== 'done') continue
    out.push({ user: turnText(u), agent: turnText(a) })
  }
  return out
}

/** The last agent turn, if it is still streaming. */
export function runningTurn(thread: AiThread): AiTurn | undefined {
  const last = thread.turns.at(-1)
  return last?.role === 'agent' && last.status === 'running' ? last : undefined
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/** The question-and-answer thread of earlier versions, as a thread with an ask anchor (settings v4). */
export function askToThread(t: AskThread, repoId = ''): AiThread {
  const turns: AiTurn[] = []
  t.messages.forEach((m, i) => {
    const requestId = `ask-${t.id}-${m.role === 'user' ? i : i - 1}`
    turns.push({ id: `${requestId}:${m.role === 'user' ? 'u' : 'a'}`, role: m.role === 'user' ? 'user' : 'agent', requestId, blocks: [{ type: 'text', text: m.text }], at: t.updated, ...(m.role === 'ai' ? { status: 'done' as const } : {}) })
  })
  return {
    id: t.id, repoId, anchor: { kind: 'ask', rev: t.rev, path: t.path, lines: [t.startLine, t.endLine], code: t.code },
    title: t.messages.find((m) => m.role === 'user')?.text ?? '', turns, createdAt: t.updated, updatedAt: t.updated, head: t.rev,
  }
}

/** The other way, for the askThreads IPC methods that older callers still use. */
export function threadToAsk(t: AiThread): AskThread | null {
  if (t.anchor.kind !== 'ask') return null
  // Only answered questions: the old shape has no place for a failed one.
  const messages = transcript(t).flatMap((x): AskThread['messages'] => [{ role: 'user', text: x.user }, { role: 'ai', text: x.agent }])
  return { id: t.id, rev: t.anchor.rev, path: t.anchor.path, startLine: t.anchor.lines[0], endLine: t.anchor.lines[1], code: t.anchor.code, messages, updated: t.updatedAt }
}
