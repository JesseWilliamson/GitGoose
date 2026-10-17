#!/usr/bin/env node
// A fake ACP agent for tests: speaks the real protocol (same SDK as the app), answers from a
// script instead of a model. Behaviour depends on the prompt text:
//   "commit message"            streams a conventional commit message in three chunks
//   "Resolve the merge conflict" asks permission to edit, then writes the file through the client
//   "FAKE:crash"                exits mid-turn
//   anything else               asks to read a file in the repo and one outside it, then explains
// FAKE_AGENT_AUTH=1   session/new fails with auth_required until `authenticate` is called
// FAKE_AGENT_LOG=file  appends every prompt it receives (tests check what was sent)
import * as acp from '@agentclientprotocol/sdk'
import { appendFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'

const sessions = new Map()
let authed = process.env.FAKE_AGENT_AUTH !== '1'
const log = (s) => process.env.FAKE_AGENT_LOG && appendFileSync(process.env.FAKE_AGENT_LOG, s + '\n---\n')
const tick = () => new Promise((r) => setTimeout(r, 15))

async function say(cx, sessionId, text) {
  await cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  })
  await tick()
}

async function ask(cx, sessionId, toolCallId, kind, title, path) {
  const res = await cx.request(acp.methods.client.session.requestPermission, {
    sessionId,
    toolCall: { toolCallId, title, kind, status: 'pending', locations: [{ path }] },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  })
  return res.outcome.outcome === 'selected' && res.outcome.optionId === 'allow'
}

async function prompt(params, cx) {
  const text = params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('')
  log(text)
  const { cwd } = sessions.get(params.sessionId)
  const id = params.sessionId

  if (text.includes('FAKE:crash')) {
    await say(cx, id, 'Thinking')
    process.exit(3)
  }
  if (text.includes('Fix this code review finding')) {
    // Writes the file with the finding's lines replaced (by the suggestion, if there is one).
    const path = /^File: (.+)$/m.exec(text)?.[1]
    const [, start, end] = /at lines (\d+)-(\d+)/.exec(text) ?? []
    const suggestion = /A suggested replacement for those lines:\n([\s\S]*?)\n\nChange only/.exec(text)?.[1]
    if (!(await ask(cx, id, 'edit-fix', 'edit', `Edit ${path}`, path))) {
      await say(cx, id, 'Left the file as it was.')
      return { stopReason: 'end_turn' }
    }
    const { content } = await cx.request(acp.methods.client.fs.readTextFile, { sessionId: id, path })
    const lines = content.split('\n')
    lines.splice(Number(start) - 1, Number(end) - Number(start) + 1, ...(suggestion ?? 'fixed').split('\n'))
    await cx.request(acp.methods.client.fs.writeTextFile, { sessionId: id, path, content: lines.join('\n') })
    await say(cx, id, 'Applied the suggested fix.')
    return { stopReason: 'end_turn' }
  }
  if (text.includes('Review this change')) {
    // One finding on the first added line (with a suggestion), and one about a file that is not
    // in the change: verification must drop that one.
    const path = /^=== (.+?) \(/m.exec(text)?.[1]
    const m = /^\s*(\d+)\+\| (.*)$/m.exec(text)
    const answer = {
      summary: 'Adds a small change; one thing to fix.',
      findings: [
        { path, startLine: Number(m?.[1] ?? 1), endLine: Number(m?.[1] ?? 1), type: 'bug', severity: 'major', title: 'Possible bug here', message: `This line looks wrong: ${m?.[2] ?? ''}`, suggestion: (m?.[2] ?? '').replace(' - ', ' + ') || 'fixed line' },
        { path: 'invented/file.ts', startLine: 1, endLine: 1, type: 'bug', severity: 'critical', title: 'Hallucinated', message: 'Not real.' },
      ],
    }
    const json = JSON.stringify(answer)
    for (let i = 0; i < json.length; i += 50) await say(cx, id, json.slice(i, i + 50))
    return { stopReason: 'end_turn' }
  }
  if (text.includes('Reorganise')) {
    // A plan in JSON, streamed in pieces: the last piece listed becomes its own first commit.
    const ids = [...text.matchAll(/^\[(U\d+)\] (\S+)/gm)].map((m) => ({ id: m[1], path: m[2] }))
    const last = ids[ids.length - 1]
    const plan = { commits: [
      { message: `chore: ${last.path} first`, units: [last.id] },
      { message: 'feat: everything else', units: ids.slice(0, -1).map((u) => u.id) },
    ] }
    const json = JSON.stringify(plan)
    for (let i = 0; i < json.length; i += 40) await say(cx, id, json.slice(i, i + 40))
    return { stopReason: 'end_turn' }
  }
  if (text.includes('commit message')) {
    for (const chunk of ['feat: add the widget ', 'registry\n\n', 'Registers widgets by name so plugins can add their own.']) await say(cx, id, chunk)
    return { stopReason: 'end_turn' }
  }
  if (text.includes('Resolve the merge conflict')) {
    const path = /^File: (.+)$/m.exec(text)?.[1]
    if (!(await ask(cx, id, 'edit-1', 'edit', `Edit ${path}`, path))) {
      await say(cx, id, 'Left the file as it was.')
      return { stopReason: 'end_turn' }
    }
    const { content } = await cx.request(acp.methods.client.fs.readTextFile, { sessionId: id, path })
    const resolved = content.split('\n').filter((l) => !/^(<{7}|={7}|>{7}|\|{7})/.test(l)).join('\n')
    await cx.request(acp.methods.client.fs.writeTextFile, { sessionId: id, path, content: resolved })
    await say(cx, id, 'Kept both sides, ours first.')
    return { stopReason: 'end_turn' }
  }
  // Explanations: a read inside the repository (GitSquid allows it silently) and one outside
  // (GitSquid must ask the user).
  const inside = await ask(cx, id, 'read-1', 'read', 'Read README', `${cwd}/README.md`)
  const outside = await ask(cx, id, 'read-2', 'read', 'Read /etc/hostname', '/etc/hostname')
  await say(cx, id, `This change explains itself. `)
  await say(cx, id, `(inside: ${inside ? 'allowed' : 'denied'}, outside: ${outside ? 'allowed' : 'denied'})`)
  return { stopReason: 'end_turn' }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
acp
  .agent({ name: 'fake-agent' })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: 'fake-agent', title: 'Fake Agent', version: '1.2.3' },
    authMethods: [
      { id: 'fake-login', name: 'Log in to Fake' },
      ...(ctx.params.clientCapabilities?.auth?.terminal ? [{ id: 'fake-terminal', name: 'Log in in a terminal', type: 'terminal', args: ['--login'] }] : []),
    ],
  }))
  .onRequest(acp.methods.agent.authenticate, () => {
    authed = true
    return {}
  })
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    if (!authed) throw acp.RequestError.authRequired()
    const sessionId = `s${sessions.size + 1}`
    sessions.set(sessionId, { cwd: ctx.params.cwd })
    return { sessionId }
  })
  .onRequest(acp.methods.agent.session.prompt, (ctx) => prompt(ctx.params, ctx.client))
  .onNotification(acp.methods.agent.session.cancel, () => {})
  .connect(stream)
