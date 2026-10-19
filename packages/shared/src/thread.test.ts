import { describe, expect, it } from 'vitest'
import type { AiThread, AiToolCall, AiUpdate } from './ai'
import { askToThread, reduceThread, splitArtifacts, threadToAsk, transcript, turnText } from './thread'

const empty = (): AiThread => ({ id: 't1', repoId: 'r', anchor: { kind: 'free' }, title: '', turns: [], createdAt: 0, updatedAt: 0, head: 'abc' })
const fold = (t: AiThread, requestId: string, updates: AiUpdate[]) => updates.reduce((acc, u) => reduceThread(acc, requestId, u), t)
const tool = (patch: Partial<AiToolCall> = {}): AiToolCall => ({ id: 'c1', title: 'Edit a.ts', kind: 'edit', status: 'pending', locations: [], content: [], ...patch })

describe('reduceThread', () => {
  it('a turn adds the user message and a running agent turn; chunks grow one text block', () => {
    const t = fold(empty(), 'r1', [{ kind: 'turn', text: 'Why?\nmore', at: 5 }, { kind: 'text', text: 'Because ' }, { kind: 'text', text: 'it is.' }])
    expect(t.title).toBe('Why?')
    expect(t.turns.map((x) => [x.role, x.status])).toEqual([['user', undefined], ['agent', 'running']])
    expect(t.turns[1]!.blocks).toEqual([{ type: 'text', text: 'Because it is.' }])
  })

  it('keeps the order things happened in: text, a tool call, more text', () => {
    const t = fold(empty(), 'r1', [
      { kind: 'turn', text: 'go', at: 1 },
      { kind: 'thought', text: 'hmm' },
      { kind: 'text', text: 'Looking.' },
      { kind: 'tool', tool: tool() },
      { kind: 'tool', tool: tool({ status: 'completed', content: [{ type: 'diff', path: 'a.ts', oldText: 'a', newText: 'b' }] }) },
      { kind: 'text', text: 'Done.' },
    ])
    const blocks = t.turns[1]!.blocks
    expect(blocks.map((b) => b.type)).toEqual(['thought', 'text', 'tool', 'text'])
    // The tool update replaced the call in place rather than adding a second card.
    expect(blocks[2]).toMatchObject({ type: 'tool', tool: { status: 'completed' } })
  })

  it('one plan per turn, replaced as the agent revises it', () => {
    const t = fold(empty(), 'r1', [
      { kind: 'turn', text: 'go', at: 1 },
      { kind: 'plan', entries: [{ content: 'a', priority: 'high', status: 'pending' }] },
      { kind: 'plan', entries: [{ content: 'a', priority: 'high', status: 'completed' }, { content: 'b', priority: 'low', status: 'pending' }] },
    ])
    expect(t.turns[1]!.blocks).toEqual([{ type: 'plan', entries: [{ content: 'a', priority: 'high', status: 'completed' }, { content: 'b', priority: 'low', status: 'pending' }] }])
  })

  it('permission cards record the answer; unanswered ones expire when the turn ends', () => {
    const ask = (permissionId: number) => ({ permissionId, title: 'Run tests', kind: 'execute', paths: [], options: [] })
    const t = fold(empty(), 'r1', [
      { kind: 'turn', text: 'go', at: 1 },
      { kind: 'permission', permission: ask(1) },
      { kind: 'permission-answered', permissionId: 1, answer: 'session' },
      { kind: 'permission', permission: ask(2) },
      { kind: 'done', stopReason: 'end_turn' },
    ])
    expect(t.turns[1]!.blocks.map((b) => b.type === 'permission' && b.permission.answer)).toEqual(['session', 'expired'])
  })

  it('done splits artifacts out of the text; cancel and error end the turn; late events are ignored', () => {
    const reply = 'Here is the revised plan.\n\n```json:plan\n{"commits": []}\n```\n\nApply it if you like.'
    const done = fold(empty(), 'r1', [{ kind: 'turn', text: 'go', at: 1 }, { kind: 'text', text: reply }, { kind: 'done', stopReason: 'end_turn' }, { kind: 'text', text: 'late' }])
    expect(done.turns[1]!.status).toBe('done')
    expect(done.turns[1]!.blocks).toEqual([
      { type: 'text', text: 'Here is the revised plan.' },
      { type: 'artifact', artifact: 'plan', json: '{"commits": []}' },
      { type: 'text', text: 'Apply it if you like.' },
    ])
    expect(turnText(done.turns[1]!)).toBe(reply)
    const stopped = fold(empty(), 'r1', [{ kind: 'turn', text: 'go', at: 1 }, { kind: 'done', stopReason: 'cancelled' }])
    expect(stopped.turns[1]!.status).toBe('cancelled')
    const failed = fold(empty(), 'r1', [{ kind: 'turn', text: 'go', at: 1 }, { kind: 'error', message: 'The agent stopped.', code: 'x' }])
    expect(failed.turns[1]).toMatchObject({ status: 'error', error: { message: 'The agent stopped.', code: 'x' } })
  })

  it('ignores events for turns it does not have, and a repeated turn event', () => {
    const t = fold(empty(), 'r1', [{ kind: 'turn', text: 'go', at: 1 }])
    expect(reduceThread(t, 'other', { kind: 'text', text: 'x' })).toBe(t)
    expect(reduceThread(t, 'r1', { kind: 'turn', text: 'go', at: 1 })).toBe(t)
  })

  it('folding the same events gives the same thread wherever it runs (main and renderer)', () => {
    const events: AiUpdate[] = [{ kind: 'turn', text: 'a', at: 1 }, { kind: 'text', text: 'x' }, { kind: 'tool', tool: tool() }, { kind: 'done', stopReason: 'end_turn' }]
    expect(fold(empty(), 'r1', events)).toEqual(fold(empty(), 'r1', events))
  })
})

describe('splitArtifacts', () => {
  it('only known tags become artifacts; other fences stay code', () => {
    expect(splitArtifacts('```ts\nconst a = 1\n```')).toEqual([{ type: 'text', text: '```ts\nconst a = 1\n```' }])
    expect(splitArtifacts('```json:recipe\n{}\n```')).toEqual([{ type: 'text', text: '```json:recipe\n{}\n```' }])
    expect(splitArtifacts('```json:findings\n{"findings": []}\n```')).toEqual([{ type: 'artifact', artifact: 'findings', json: '{"findings": []}' }])
    expect(splitArtifacts('')).toEqual([{ type: 'text', text: '' }])
  })
})

describe('transcript', () => {
  it('lists answered exchanges only', () => {
    let t = fold(empty(), 'r1', [{ kind: 'turn', text: 'one', at: 1 }, { kind: 'text', text: 'first' }, { kind: 'done', stopReason: 'end_turn' }])
    t = fold(t, 'r2', [{ kind: 'turn', text: 'FAKE:crash', at: 2 }, { kind: 'error', message: 'stopped' }])
    t = fold(t, 'r3', [{ kind: 'turn', text: 'two', at: 3 }, { kind: 'text', text: 'half' }, { kind: 'done', stopReason: 'cancelled' }])
    t = fold(t, 'r4', [{ kind: 'turn', text: 'three', at: 4 }, { kind: 'text', text: 'third' }, { kind: 'done', stopReason: 'end_turn' }])
    expect(transcript(t)).toEqual([{ user: 'one', agent: 'first' }, { user: 'three', agent: 'third' }])
  })
})

describe('ask threads', () => {
  it('converts both ways', () => {
    const old = { id: 'a1', rev: 'abc1234', path: 'src/a.ts', startLine: 3, endLine: 4, code: 'x\ny', updated: 9,
      messages: [{ role: 'user' as const, text: 'Why?' }, { role: 'ai' as const, text: 'Because.' }, { role: 'user' as const, text: 'Really?' }, { role: 'ai' as const, text: 'Yes.' }] }
    const t = askToThread(old, 'repo')
    expect(t).toMatchObject({ id: 'a1', repoId: 'repo', title: 'Why?', anchor: { kind: 'ask', rev: 'abc1234', path: 'src/a.ts', lines: [3, 4], code: 'x\ny' } })
    expect(transcript(t)).toEqual([{ user: 'Why?', agent: 'Because.' }, { user: 'Really?', agent: 'Yes.' }])
    expect(threadToAsk(t)).toEqual(old)
    expect(threadToAsk(empty())).toBeNull()
  })
})
