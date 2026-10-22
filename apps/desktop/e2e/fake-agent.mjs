#!/usr/bin/env node
// A fake ACP agent for tests: speaks the real protocol (same SDK as the app), answers from a
// script instead of a model. Each session keeps its history, so a thread's follow-ups can be
// told apart from first messages. Behaviour depends on the prompt text:
//   "commit message for"        streams a conventional commit message in three chunks
//   "Resolve the merge conflict" asks permission to edit, then writes the file through the client
//   "FAKE:crash"                exits mid-turn
//   "FAKE:tools"                a thought, a plan, a tool call with a diff, then "Turn N"
//   "FAKE:permission"           asks twice to run `npm test` (execute, rawInput.command), reports both answers
//   "FAKE:slow"                 streams slowly until session/cancel stops it
//   "FAKE:findings", "FAKE:plan" (follow-ups) revise the review / recompose plan as a json:<kind> block
//   "FAKE:message"              suggests a commit message as a json:commit-message block
//   "FAKE:model"                "Model: <the session's model>" (FAKE_AGENT_MODELS only)
//   a follow-up                 "Turn N. You said: <last line>." (N counts this session's turns,
//                               plus any replayed after a restart: "(replayed K earlier turns)")
//   "Explain"                   asks to read a file in the repo and one outside it, then explains
//   anything else               "Turn 1. You said: <last line>."
// FAKE_AGENT_AUTH=1    session/new fails with auth_required until `authenticate` is called
// FAKE_AGENT_LOG=file  appends every prompt it receives (tests check what was sent)
// FAKE_AGENT_MODELS=1  offers models as an ACP config option (category "model": fast, default
//                      "smart"); session/set_config_option switches them, and an unknown one fails
// FAKE_AGENT_GATE=file an answer waits while that file is missing (until the turn is cancelled),
//                      so a test can do other things while the AI is still working: create the
//                      file to let answers through, delete it to hold the next ones
// FAKE_AGENT_LOAD=1    advertises loadSession; with FAKE_AGENT_STATE=file the sessions survive a
//                      restart (session/load replays their history as session/update)
import * as acp from '@agentclientprotocol/sdk'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'

const STATE = process.env.FAKE_AGENT_LOAD === '1' ? process.env.FAKE_AGENT_STATE : undefined
/** sessionId -> { cwd, history: [{ user, agent }], cancelled } */
const sessions = new Map(STATE && existsSync(STATE) ? Object.entries(JSON.parse(readFileSync(STATE, 'utf8'))).map(([k, v]) => [k, { ...v, cancelled: false }]) : [])
const save = () => STATE && writeFileSync(STATE, JSON.stringify(Object.fromEntries([...sessions].map(([k, v]) => [k, { cwd: v.cwd, history: v.history }]))))
const REPLAY = '<<user>>'
let authed = process.env.FAKE_AGENT_AUTH !== '1'
const log = (s) => process.env.FAKE_AGENT_LOG && appendFileSync(process.env.FAKE_AGENT_LOG, s + '\n---\n')
const tick = () => new Promise((r) => setTimeout(r, 15))
const MODELS = process.env.FAKE_AGENT_MODELS === '1'
  ? [{ group: 'fake', name: 'Fake models', options: [{ value: 'fast', name: 'Fake Fast' }, { value: 'smart', name: 'Fake Smart', description: 'The default' }] }]
  : null
/** A session's config options: the model selector, grouped (as real agents may send it). */
const configOptions = (s) => (MODELS ? [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: MODELS }] : undefined)

async function say(cx, sessionId, text) {
  await update(cx, sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  const s = sessions.get(sessionId)
  if (s) s.reply += text
}

async function update(cx, sessionId, u) {
  await cx.notify(acp.methods.client.session.update, { sessionId, update: u })
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
  const session = sessions.get(params.sessionId)
  session.reply = ''
  session.cancelled = false
  const gate = process.env.FAKE_AGENT_GATE
  while (gate && !existsSync(gate) && !session.cancelled) await new Promise((r) => setTimeout(r, 25))
  if (session.cancelled) return { stopReason: 'cancelled' }
  const res = await answer(params.sessionId, session, text, cx)
  session.history.push({ user: text, agent: session.reply })
  save()
  return res
}

async function answer(id, session, text, cx) {
  const { cwd, history } = session
  // Turns in this conversation: earlier ones in the session, plus any replayed after a restart.
  const replayed = text.split(REPLAY).length - 1
  const n = history.length + replayed + 1
  const lastLine = text.trim().split('\n').at(-1)
  const first = history[0]?.user ?? (replayed ? text : '')

  // The new message only: a replay carries earlier "FAKE:model" turns that must not answer again.
  if (lastLine.includes('FAKE:model')) {
    await say(cx, id, `Model: ${session.model ?? 'none'}`)
    return { stopReason: 'end_turn' }
  }
  if (text.includes('FAKE:crash')) {
    await say(cx, id, 'Thinking')
    process.exit(3)
  }
  if (text.includes('FAKE:slow')) {
    for (let i = 0; i < 200 && !session.cancelled; i++) {
      await say(cx, id, `chunk ${i} `)
      await new Promise((r) => setTimeout(r, 30))
    }
    return { stopReason: session.cancelled ? 'cancelled' : 'end_turn' }
  }
  if (text.includes('FAKE:tools')) {
    const path = `${cwd}/README.md`
    await update(cx, id, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact the conversation' }] })
    await update(cx, id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'The README needs a line.' } })
    await update(cx, id, { sessionUpdate: 'plan', entries: [{ content: 'Read the README', priority: 'high', status: 'completed' }, { content: 'Add a line', priority: 'medium', status: 'in_progress' }] })
    await update(cx, id, { sessionUpdate: 'tool_call', toolCallId: 'edit-readme', title: 'Edit README.md', kind: 'edit', status: 'in_progress', locations: [{ path }], rawInput: { path, line: 1 } })
    await update(cx, id, { sessionUpdate: 'tool_call_update', toolCallId: 'edit-readme', status: 'completed', content: [{ type: 'diff', path, oldText: 'old line\n', newText: 'new line\n' }] })
    await say(cx, id, `Turn ${n}. Edited README.md.`)
    return { stopReason: 'end_turn' }
  }
  if (text.includes('FAKE:permission')) {
    const run = () => cx.request(acp.methods.client.session.requestPermission, {
      sessionId: id,
      toolCall: { toolCallId: `run-${Math.random()}`, title: 'Run a command', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } },
      options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
    }).then((r) => (r.outcome.outcome === 'selected' && r.outcome.optionId === 'yes' ? 'allowed' : 'denied'))
    const a = await run()
    const b = await run()
    await say(cx, id, `Turn ${n}. First: ${a}, second: ${b}.`)
    return { stopReason: 'end_turn' }
  }
  if (text.includes('FAKE:message')) {
    const json = JSON.stringify({ message: 'docs: say what the widgets are for\n\nThe README did not say.' })
    await say(cx, id, `Turn ${n}. Try this:\n\n\`\`\`json:commit-message\n${json}\n\`\`\`\n`)
    return { stopReason: 'end_turn' }
  }
  if (history.length || replayed) {
    if (text.includes('FAKE:findings')) {
      // A finding on the first added line of the change the review was about.
      const path = /^=== (.+?) \(/m.exec(first)?.[1]
      const line = Number(/^\s*(\d+)\+\| /m.exec(first)?.[1] ?? 1)
      const json = JSON.stringify({ summary: 'One more thing.', findings: [
        { path, startLine: line, endLine: line, type: 'docs', severity: 'minor', title: 'Found in chat', message: 'Say why in a comment.' },
        { path: 'invented/chat.ts', startLine: 1, endLine: 1, type: 'bug', severity: 'major', title: 'Invented in chat', message: 'Not real.' },
      ] })
      await say(cx, id, `Turn ${n}. Here is the revised review:\n\n\`\`\`json:findings\n${json}\n\`\`\`\n`)
      return { stopReason: 'end_turn' }
    }
    if (text.includes('FAKE:plan')) {
      // The opposite of the first plan: the first piece alone, last.
      const ids = [...first.matchAll(/^\[(U\d+)\] (\S+)/gm)].map((m) => m[1])
      const plan = { commits: [{ message: 'feat: everything else first', units: ids.slice(1) }, { message: 'test: the first piece on its own', units: ids.slice(0, 1) }] }
      await say(cx, id, `Turn ${n}. Revised:\n\n\`\`\`json:plan\n${JSON.stringify(plan)}\n\`\`\`\n`)
      return { stopReason: 'end_turn' }
    }
    if (first.includes('Answer the question about the selected lines')) {
      await say(cx, id, `You asked "${lastLine}". Following up.`)
      return { stopReason: 'end_turn' }
    }
    await say(cx, id, `Turn ${n}. You said: ${lastLine}.${replayed ? ` (replayed ${replayed} earlier turns)` : ''}`)
    return { stopReason: 'end_turn' }
  }
  if (text.includes('Uses outside the change')) {
    // Flags the first non-test use, and one id that was never sent (must be ignored).
    const site = /^\[(C\d+)\] [^\n]*?(?<!\(test\)): /m.exec(text)?.[1] ?? 'C1'
    const json = JSON.stringify({ summary: 'One caller relies on the old rounding.', risks: [{ id: site, why: 'It expects unrounded totals.' }, { id: 'C99', why: 'invented' }] })
    for (let i = 0; i < json.length; i += 40) await say(cx, id, json.slice(i, i + 40))
    return { stopReason: 'end_turn' }
  }
  if (text.includes('Answer the question about the selected lines')) {
    // Echo what it was given, so tests can see the context arrived.
    const within = /They are inside (\w+ \w+)/.exec(text)?.[1] ?? 'no definition'
    const used = [...text.matchAll(/^(\w+), ([^:\n]+):(\d+):$/gm)].map((m) => `${m[1]} (${m[2]})`).join(', ') || 'nothing'
    const q = /^Question: (.+)$/m.exec(text)?.[1]
    const earlier = text.includes('The conversation so far') ? ' Following up.' : ''
    for (const chunk of [`You asked "${q}".`, ` The lines are in ${within}; they use ${used}.`, earlier]) await say(cx, id, chunk)
    return { stopReason: 'end_turn' }
  }
  if (text.includes('Write a walkthrough')) {
    const pieces = [...text.matchAll(/^\[(H\d+)\] ([^:\s]+):/gm)].map((m) => ({ id: m[1], path: m[2] }))
    const files = [...new Set(pieces.map((p) => p.path))]
    const answer = {
      summary: `Changes ${files.length} files to make totals right.`,
      effort: 2, effortWhy: 'small and well tested',
      groups: [{ title: 'The fix', description: 'Corrects the arithmetic.', files: [files[0], 'invented.ts'] }],
      hunks: Object.fromEntries(pieces.map((p) => [p.id, `Piece ${p.id} of ${p.path}`])),
      sequence: { participants: ['Caller', 'total'], messages: [{ from: 'Caller', to: 'total', label: 'total(a, b)' }, { from: 'total', to: 'Caller', label: 'a + b' }] },
    }
    const json = JSON.stringify(answer)
    for (let i = 0; i < json.length; i += 50) await say(cx, id, json.slice(i, i + 50))
    return { stopReason: 'end_turn' }
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
  if (text.includes('Judge whether this push')) {
    // A rule mentioning console.log fails on the first added line that has one; a rule that says
    // "elsewhere" fails citing a line that is not in the push (verification must not believe it);
    // everything else passes. Plus an answer for a check that was never sent.
    const rules = [...text.matchAll(/^\[(C\d+)\] ([^:]+): (.*)$/gm)].map((m) => ({ id: m[1], rule: m[3] }))
    const hit = /^\s*(\d+)\+\| .*console\.log\(/m.exec(text)
    const hitPath = hit && [...text.slice(0, hit.index).matchAll(/^=== (.+?) \(/gm)].at(-1)?.[1]
    const results = rules.map(({ id, rule }) =>
      rule.includes('console.log') && hit ? { id, verdict: 'fail', reason: 'A console.log call was added.', evidence: [{ path: hitPath, line: Number(hit[1]) }] }
        : rule.includes('elsewhere') ? { id, verdict: 'fail', reason: 'Broken in another file.', evidence: [{ path: 'not/in/push.ts', line: 3 }] }
        : { id, verdict: 'pass', reason: 'Nothing in this push breaks it.' })
    results.push({ id: 'C99', verdict: 'fail', reason: 'Invented.' })
    await say(cx, id, JSON.stringify({ results }))
    return { stopReason: 'end_turn' }
  }
  if (text.includes('Review this change')) {
    // One finding on the first added line (with a suggestion), and one about a file that is not
    // in the change: verification must drop that one.
    const path = /^=== (.+?) \(/m.exec(text)?.[1]
    const m = /^\s*(\d+)\+\| (.*)$/m.exec(text)
    // A team learning that covers this finding: say nothing about it.
    const learned = /^Learnings:[\s\S]*possible bug here/im.test(text)
    const answer = learned ? { summary: 'Fine by the team\'s rules.', findings: [] } : {
      summary: 'Adds a small change; one thing to fix.',
      findings: [
        { path, startLine: Number(m?.[1] ?? 1), endLine: Number(m?.[1] ?? 1), type: 'bug', severity: 'major', title: 'Possible bug here', message: `This line looks wrong: ${m?.[2] ?? ''}`, suggestion: (m?.[2] ?? '').replace(' - ', ' + ') || 'fixed line' },
        { path: 'invented/file.ts', startLine: 1, endLine: 1, type: 'bug', severity: 'critical', title: 'Hallucinated', message: 'Not real.' },
      ],
    }
    // A model that sees a redacted secret flags the marker: the scan's own finding should win.
    const redacted = /^\s*(\d+)\+\| .*\[REDACTED/m.exec(text)
    const redactedPath = redacted && [...text.slice(0, redacted.index).matchAll(/^=== (.+?) \(/gm)].at(-1)?.[1]
    if (redacted && !learned) answer.findings.push({ path: redactedPath, startLine: Number(redacted[1]), endLine: Number(redacted[1]), type: 'security', severity: 'critical', title: 'Hard-coded credential', message: 'A secret was removed from this line.' })
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
  if (text.includes('commit message for')) {
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
  if (!/\bExplain\b|A git operation in a desktop git client failed/.test(text)) {
    await say(cx, id, `Turn ${n}. You said: ${lastLine}.`)
    return { stopReason: 'end_turn' }
  }
  // Explanations: a read inside the repository (GitGoose allows it silently) and one outside
  // (GitGoose must ask the user).
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
    agentCapabilities: { loadSession: process.env.FAKE_AGENT_LOAD === '1' },
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
    // Unique across restarts, so a loaded session is never confused with a new one.
    const sessionId = `s${process.pid}-${sessions.size + 1}`
    const s = { cwd: ctx.params.cwd, history: [], cancelled: false, reply: '', model: MODELS ? 'smart' : undefined }
    sessions.set(sessionId, s)
    save()
    return { sessionId, configOptions: configOptions(s) }
  })
  .onRequest(acp.methods.agent.session.load, async (ctx) => {
    const s = sessions.get(ctx.params.sessionId)
    if (process.env.FAKE_AGENT_LOAD !== '1' || !s) throw acp.RequestError.resourceNotFound(ctx.params.sessionId)
    // ACP: the agent replays the whole conversation before answering.
    for (const h of s.history) {
      await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: h.user } } })
      await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: h.agent } } })
    }
    return {}
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
    const s = sessions.get(ctx.params.sessionId)
    const known = MODELS?.flatMap((g) => g.options).some((o) => o.value === ctx.params.value)
    if (!s || ctx.params.configId !== 'model' || !known) throw acp.RequestError.invalidParams(undefined, `no such model: ${ctx.params.value}`)
    s.model = ctx.params.value
    log(`set model ${s.model}`)
    return { configOptions: configOptions(s) }
  })
  .onRequest(acp.methods.agent.session.prompt, (ctx) => prompt(ctx.params, ctx.client))
  .onNotification(acp.methods.agent.session.cancel, (ctx) => {
    const s = sessions.get(ctx.params.sessionId)
    if (s) s.cancelled = true
  })
  .connect(stream)
