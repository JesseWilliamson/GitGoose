# 006: AI features over the Agent Client Protocol

PLAN-2 §9b, PLAN-4 5a (threads). Code: `apps/desktop/src/main/ai/` (acp.ts, service.ts,
prompts.ts, anthropic.ts, keyStore.ts), `packages/shared/src/ai.ts` and `thread.ts`, renderer
`lib/ai.ts`, `lib/thread.ts`, `lib/artifacts.ts`, `lib/markdown.ts`, `components/Thread.tsx`,
`components/AiDialogs.tsx`, `components/AiPanel.tsx`, `components/AiChatPanel.tsx`. Tests:
`main/ai/*.test.ts`, `shared/src/thread.test.ts`, `renderer/src/lib/markdown.test.ts`,
`e2e/ai.spec.ts` and `e2e/thread.spec.ts`, against `e2e/fake-agent.mjs` (a real ACP agent over
stdio, scripted; `FAKE_AGENT_MODELS=1` gives it a model option) and `fakeAnthropic`. No test talks to a real agent or API.

## Settings → AI

- *AI features*: Off (default) · An agent on this computer (ACP) · Anthropic API key.
- *Agent*: Claude (`npx -y @agentclientprotocol/claude-agent-acp`), Codex
  (`npx -y @agentclientprotocol/codex-acp`), Gemini CLI (`gemini --experimental-acp`), or a custom
  command. **Test** starts the agent, runs `initialize`, shows name, version and login methods.
- API key: stored with safeStorage (memory only without a keychain), model setting
  (`claude-opus-5-5` by default), *Longest answer* (`max_tokens`, 8192 by default). Text
  features only: no tools, so a thread in this mode never shows tool cards.
- *Default model*: the model picker for the configured provider. For an agent it is that agent's
  default (blank: the agent's own); for the API key, the `anthropicModel` setting.

## Choosing who answers, per area

Every AI area has the same picker (`components/ModelPicker.tsx`): *who* (Default, any agent
preset, the custom command if set, the Anthropic API if a key is saved) and *model*. Settings →
AI only sets the default. An area's pick is remembered for that area alone (settings
`aiAreaTargets`: commit, explain, review, walkthrough, impact, recompose, ask, chat, conflict,
push-checks, error); Default follows Settings. Thread views show it under the turns, so one
placement covers every chat (Recompose, Review, Walkthrough, Impact, Explain, Ask, AI panel);
Recompose also shows it while the plan is being asked for, and a new pick there restarts the
request on it.

A request carries its `AiTarget` (`{ provider, agent?, agentCommand?, model? }`); main fills the
blanks from settings. `targetKey` (`agent:<command line>` or `anthropic`) names the process: it is
what consent is given to (a model change asks nothing new; another agent does), what cached model
lists are kept under, and which process a session lives in.

- **Models come from the agent.** ACP has no model list outside a session: models are the
  session config option with category `model` in `session/new`'s `configOptions` (flat or
  grouped; we flatten), changed with `session/set_config_option` and by the agent itself
  (`config_option_update`). Main keeps each agent's last list (settings `aiAgentModels`) so a
  picker can show it without starting anything; with none yet, *Load models…* starts the agent
  and opens and closes one session (the user clicked, as with Test). An agent with no model
  option shows "Chosen by the agent".
- **The API's list** is `GET /v1/models`, fetched only when the user picks *Load models…* (it
  sends the key and nothing else), and kept while the app runs.
- **The model is set before the turn.** After opening or loading a session, main switches it to
  the target's model; a model the agent does not offer fails the send with `ai-model` before the
  turn starts. Blank after an earlier pick goes back to the agent's own default.
- **A thread can switch.** A thread records its target (`AiThread.target`, sent as `meta`). The
  same agent with another model keeps the session and switches it in place. Another agent, or
  the API, closes the session and opens one there that is told the conversation so far, exactly
  as after a restart without `session/load` (from the API, its separate system prompt goes in
  front). A send with no pick continues with whoever the thread was last with. Each agent turn
  records who answered (`AiTurn.by`, e.g. "Codex · GPT-5"); the thread shows it where it changes.
- **One process per agent.** Main keeps an `AcpAgent` per command line. One with sessions, the
  default, or any area's pick is kept; others are stopped when settings change.

## Features

| where | what is sent | result |
|---|---|---|
| Commit box → **Write** | staged diff (lockfiles excluded, 60k chars max) and 12 recent subjects | streams into Summary / Description |
| Commit details → **Explain** | `git show` of the commit | streams into a box under the message |
| Attention bar → **Explain** | the failed action and git's output | streams into a modal |
| Conflict file → **Ask AI** (agent only) | the file path; the agent reads the file | a *proposal* dialog: Use this resolution / Discard |
| Review, Walkthrough, Impact → **Chat** | the feature's context (the change, numbered) and what you write | a thread in a rail beside the result |
| Explain box → **Ask a follow-up** | what you write (the session has the commit) | the thread grows under the explanation |
| Recompose → **Chat** | what you write (the session has the pieces) | a thread beside the plan; revised plans as cards |
| Diff selection → **Ask** | the lines, their function, definitions, history; then what you write | a thread under the diff (spec 007) |
| **AI panel** (Mod+Shift+A, View → AI Chat) | the repository's name and HEAD, then what you write | a free-standing thread |

## Rules main enforces

- **Consent before anything.** A request fails with `ai-consent` until the user agreed to this
  provider (for agents: this exact command). The agent process is not started before that.
  The renderer asks first, naming what each feature sends.
- **One session per thread.** Every AI feature is a *thread*: an anchor (what it is about:
  `review`, `explain`, `recompose`, `walkthrough`, `impact`, `ask`, `changestack`, `free`, or
  `task` for one-shot requests) and turns. A thread owns one ACP session (`session/new` with
  cwd = the repository) while its view is open, plus a 10-minute idle grace after the view
  closes; then the session is closed (`session/close` where supported) and the thread stays
  saved. Threads are independent of each other, as requests were before: a shared session would
  serialize them and drag every earlier diff along. Within a thread, follow-ups go to the same
  session, so the agent remembers. A one-shot request (commit message, push checks, conflict
  help, `aiRun`) is a thread that is opened, sent and closed; a feature whose view chats on
  (`keepThread`) keeps it, and its own request is the thread's first turn.
- **The first message carries the context.** A feature's thread starts with the feature's own
  prompt; a thread that starts with the user's words starts with the anchor's context (the
  change numbered, the commit, the lines, or for `free` only the repository's name and HEAD),
  then the artifact protocol, then the message. Later turns send only the new text.
- **After a restart.** The agent died, or the thread was reopened after its session closed:
  when the agent advertises `loadSession`, the thread's session is loaded (`session/load`; the
  replayed history it streams is ignored, we have it); otherwise a new session gets the
  conversation so far as text (the answered exchanges, the first carrying the context; a turn
  that failed or was stopped is left out, so a turn that crashed the agent is not resent).
- **Refusals come before the turn.** `aiThreadSend` checks setup, consent, login and the secret
  scan, and opens or loads the session, before the turn starts; only then does it return the
  turn's request id. A refusal therefore never leaves half a turn in the thread.
- **Permissions.** Every `session/request_permission` is a question for the user, except `read`
  tool calls whose paths are all inside the repository (symlinks resolved). One-shot requests
  ask in a modal (their views show no thread); thread turns ask inline, as a card: Deny · Allow
  once · Allow for this session. The tool's raw input (often the real command) is shown above
  its title. "Allow for this session" is remembered per session, for the same tool kind, title
  and input (allowing `npm test` allows nothing else), and GitGoose answers that question itself
  until the session ends. Unanswered questions expire when their turn ends.
- **Files.** `fs/read_text_file` only inside the session's repository. `fs/write_text_file`
  only for the one file a conflict request names, and the content is captured as a proposal,
  never written; accepting it goes through `resolveConflict` like a hand resolution.
  `terminal: false`: the agent gets no shell from GitGoose.
- **Login.** `auth_required` (-32000) comes back as error code `ai-auth`; the renderer shows
  the agent's login methods: agent-handled ones call `authenticate`, terminal ones show the
  exact command (the agent's own command plus the method's args) with Copy / Open terminal /
  I have logged in. Then the request is retried once.
- **Secrets on every turn.** The secret scan runs on exactly the text each turn sends (the
  replay too), not only the first message. With hits the turn is refused, or sent with each hit
  replaced by `[REDACTED kind]` when the user chooses; the thread shows the redacted text.
- **Lifecycle.** Started on first use, kept running, restarted after a crash on the next use
  (the failed turn reports the agent's stderr), stopped when the agent command changes and on
  quit. Closing a repository ends its threads' sessions at once.

## Threads: the update stream

ACP's `session/update` is a stream of typed events, and a thread is a fold over it. Main turns
each event into an `AiUpdate` and sends it as `ai-update { threadId, requestId, update }`; main
and the renderer apply it with the same pure `reduceThread` (`packages/shared/src/thread.ts`),
main for the copy it keeps and saves, the renderer for the copy it draws.

| `AiUpdate` | from | the thread |
|---|---|---|
| `turn { text, feature? }` | a send | a user turn, and a running agent turn |
| `text { text }` | `agent_message_chunk` | appended to the turn's last text block, or a new one after a tool call |
| `thought { text }` | `agent_thought_chunk` | a thought block, folded when drawn |
| `tool { tool }` | `tool_call`, `tool_call_update` (merged by main) | the call's card, replaced in place: title, kind, status, rawInput, locations, text and diffs |
| `plan { entries }` | `plan` | one plan per turn, replaced as it changes |
| `permission { permission }` | `session/request_permission` | a card |
| `permission-answered { permissionId, answer }` | the user | the card's answer |
| `meta { mode?, commands? }` | `current_mode_update`, `available_commands_update` | on the thread |
| `done { stopReason }` | the prompt's end | done or cancelled; artifacts split out of the text, unanswered cards expire |
| `error { message, code? }` | a failure | the turn fails with the message (Try again sends it once more) |

Threads are saved per repository (settings `aiThreads`, 100 most recent; Ask's earlier
question threads were migrated into it in settings v4).

## Artifacts in chat

Features with structured results keep producing them in a conversation. Each anchor's first
message states the protocol: when revising the findings (review), the plan (recompose), the
walkthrough, or when writing a commit message (AI panel) or a diagram, send the whole thing as
one fenced block tagged ```` ```json:findings ```` (`json:plan`, `json:walkthrough`,
`json:commit-message`, `json:diagram`); otherwise answer in prose (Markdown, no HTML).

When the turn ends, the tagged blocks become artifact blocks. The card asks main to check one
(`aiThreadArtifact`) with **the same verifier as the feature's first answer**, against what the
feature saw: `verifyFindings` (findings on lines of the change; the rest listed as thrown out),
`repairPlan`, `verifyWalkthrough`, the commit-message cleaner, the sequence-diagram check. An
anchor only takes its own kinds. **Apply** is the user's: findings join the review marked "from
chat" (Undo), a plan becomes the recompose editor's plan as one undo step, a walkthrough is
replaced (Undo), a commit message replaces the draft in the commit box (Undo), a diagram is drawn
inline. Nothing changes behind the user.

## Markdown

Answers are drawn by an in-house subset (`lib/markdown.ts`): paragraphs, headings, lists,
emphasis, inline code, links, fenced code (highlighted by the diff view's highlighter), quotes,
rules. It produces data, drawn as React elements: there is no HTML passthrough at all, so there
is nothing to sanitise, and links open in the browser through main, which takes only http,
https and mailto.
