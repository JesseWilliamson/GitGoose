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
  (`config_option_update`). Main keeps each agent's last list (settings `aiAgentModels`, by
  `targetKey`, so the custom command has its own) so a picker can show it without starting
  anything; with none yet, *Load models…* starts the agent and opens and closes one session (the
  user clicked, as with Test). An agent with no model option shows "Chosen by the agent". Test
  only initializes the agent (no session), so it learns no models.
- **The API's list** is `GET /v1/models`, fetched only when the user picks *Load models…* (it
  sends the key and nothing else). Main keeps it in settings (`aiApiModels`, with the time) like
  the agents' lists, so a restart does not lose it, and `aiModels` returns it with no request.
  Nothing refreshes a list on its own (no call the user did not ask for): an old one (over 24
  hours) is still shown, and the select says so in its entry.
- **Refresh, and one load at a time.** Once a list is known the select's entry reads *Refresh
  models…* and loads again. One load runs per target key: the renderer shares a promise among
  all pickers on screen, and main does the same so two windows do not start two agents or two
  requests. A failed refresh keeps the list there was.
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
| Attention bar → **Explain** | the failed action and git's output | a kept thread, streamed into the AI panel (a modal only with no repository open) |
| Conflict file → **Ask AI** (agent only) | the file path; the agent reads the file | a *proposal* dialog: Use this resolution / Discard; with no proposal, its note as a thread in the AI panel |
| Review, Walkthrough, Impact → **Chat** | the feature's context (the change, numbered) and what you write | a thread in a rail beside the result |
| Explain box → **Ask a follow-up** | what you write (the session has the commit) | the thread grows under the explanation |
| Recompose → **Chat** | what you write (the session has the pieces) | a thread beside the plan; revised plans as cards |
| Diff selection → **Ask** | the lines, their function, definitions, history; then what you write | a thread under the diff (spec 007) |
| **AI panel** (Mod+Shift+A, View → AI Chat) | the repository's name and HEAD, the **context chips** (git output for each, below), then what you write | a free-standing thread; its history lists every kept thread of the repository, by day |

### Context chips (the AI panel)

Above the panel's composer is a row of chips: what the next message will carry. The **selection**
is a chip by itself (`commit a1b2c3d subject`, `3 commits`, `uncommitted changes`, `a..b`);
× removes it and it stays removed while the selection is the same, then comes back with the next
one. A **drop** on the panel adds chips: a branch or tag, commits, a stash, files. The panel is
a drop target of kind `ai` in the window's drag handling (ADR-009), so the badge says "Add branch
x to the AI conversation" and nothing in the repository changes. The same thing twice is one
chip. A message sends the chips and uses up the dropped ones; the selection's chip stays while
the selection does. A line under the chips says "Sent with your next message".

Chips are **references**, not text (`AiContextRef` in `packages/shared/src/ai.ts`): the renderer
never reads git. `aiThreadSend(threadId, text, { context })` is an additive change to the
contract (`AiRunOptions.context`; no method removed or renamed). Main renders each reference
(`main/ai/context.ts`, read-only git) and puts the text **in front of** the user's words, so the
question is the last thing the model reads:

| chip | what is rendered |
|---|---|
| commits | per commit (20 at most; the rest by hash): `git show --stat` with the full message, and the patch for the newest 8 |
| branch / tag | `git log --oneline -20`, and `git diff --stat` from the merge base with HEAD |
| stash | its message, `git stash show --stat` and `-p` |
| files | the patch of those paths in that commit (against the first parent for a merge or stash); from the changes list, the staged and the unstaged diff |
| uncommitted changes | `git status --porcelain=v2` as a short list (staged, not staged, conflicted, untracked), and both diffs |
| compare | the log between, `git diff --stat` and the patch (or against the working tree) |

**The cap** is the commit message's: 60,000 characters for everything the chips add, lockfiles
(`*.lock`, `package-lock.json`, `pnpm-lock.yaml`) and `*.min.js` left out of every diff and stat
(files you drag yourself are not excluded). Each chip's overview (message, stat, log) is kept; the patches share
what is left equally, so small ones are whole and the largest are cut with a "… truncated"
marker. A name that is gone or not valid is said in the text, never an error. The whole message,
context included, goes through the secret scan, and the turn's `sent` keeps exactly what went
out (saved threads keep 20k characters of it, as for every feature). Consent names it:
"…and the git output for the context chips you attached".

**Actions.** Under the chips, buttons enabled by what is attached (`data-testid="ai-action-<name>"`;
a disabled one says why in its tooltip): *Explain* (one commit), *Review*, *Walk through*, *Impact*
(commits, a branch, or the uncommitted changes; chips you dropped win over the selection),
*Recompose* / *Split* (editable commits of the current branch), *Rebase onto…* (a dropped
branch), *Cherry-pick onto HEAD* (commits). They call the same starters as the menus, so their
threads are in the history list at once; the list refreshes while it is open.

**History.** Grouped by the day a conversation was last used (Today, Yesterday, dates); each line
shows the kind (Chat, Review, Explain, …) and its title, a spinner while its turn runs, a check
on the open one. A turn saved as running with nothing answering it (the app quit mid-answer) is
listed as stopped.

**Waiting never blocks, and answers are not lost.** Every long request (explain, review,
walkthrough, impact, recompose, fix, conflict help) is an *AI job* (`lib/aiJobs.ts`): a chip in
the status bar shows what is running and how many answers are ready, with Open / Stop / Dismiss,
and a toast with Open says when an answer arrives while its view is not on screen. Closing the
Fix, Recompose or proposal dialog only hides it (the request, or the result and its edits, wait
on the chip); Stop and Discard are the explicit ways to throw one away. A commit's explanation
belongs to the commit, not to the panel showing it (`lib/explain.ts`): selecting another commit
and coming back, or restarting, shows it again from the kept `explain` thread. The commit
message and push checks are short inline waits and are not jobs.

## The prompts, shown and editable

The words of every prompt are data (`packages/shared/src/prompts.ts`, `DEFAULT_PROMPTS`), one
per AI task plus `chat` (the AI panel's opening). A prompt is four parts, sent in this order:

| part | editable | what |
|---|---|---|
| system | yes | who the model is (the API takes it separately; an agent gets it on top) |
| instructions | yes | what to do and how to say it; a template: `{label}`, `{commits}`, `{profile}` are filled per request, unknown names stay as typed |
| answer format | **no** | the JSON shape or "the message only": the checker that reads the answer (verifyFindings, repairPlan, …) depends on these exact words, so they never come from the user (`PromptText` has no field for them) and are not shown |
| context | no | the diff, commits, code around the change: built fresh for each request; not shown |

- **Where the words come from**, part by part (a blank part falls through): the area's edit
  (settings `aiPromptEdits`, made in its Prompt panel), else Settings → AI → Prompts
  (`aiPrompts`), else the built-in words. `effectivePrompt` decides, in shared, so the panel
  and main agree.
- **The Prompt panel** (`components/PromptPanel.tsx`) is a button beside every model picker. It
  shows only what the user can change: the system prompt and instructions (remembered for that
  area, *Reset*) and the names the instructions may use. The fixed answer format and the context
  are not shown; a chat's *Sent* (below) shows what went out after the fact. (`aiPromptPreview`
  still exists in the API but the panel no longer calls it.)
- **What you edit is what goes.** `startAi` sends the area's words with the request
  (`AiRunOptions.prompt`).
- **Chats show what was sent.** Each user turn keeps exactly what went out when that is more
  than what was typed (`AiTurn.sent`: the opening with its context, a replay, a feature's
  request; for the API the first turn shows its separate system prompt first). The thread
  shows it under *Sent*. Saved threads keep 20k characters of it.
- The built-in instructions keep their first lines word for word: the fake agent tells
  requests apart by them.

## Rules main enforces

- **Consent before anything.** A request fails with `ai-consent` until the user agreed to this
  provider (for agents: this exact command). The agent process is not started before that.
  The renderer asks first, naming what each feature sends.
- **One session per thread.** Every AI feature is a *thread*: an anchor (what it is about:
  `review`, `explain`, `recompose`, `walkthrough`, `impact`, `ask`, `changestack`, `free`,
  `error` (why an action failed), `conflict` (the conflict agent's work on a file), or `task` for
  one-shot requests that are never kept) and turns. A thread owns one ACP session (`session/new` with
  cwd = the repository) while its view is open, plus a 10-minute idle grace after the view
  closes; then the session is closed (`session/close` where supported) and the thread stays
  saved. Threads are independent of each other, as requests were before: a shared session would
  serialize them and drag every earlier diff along. Within a thread, follow-ups go to the same
  session, so the agent remembers. A one-shot request (commit message, push checks, a fix for
  a finding, `aiRun`) is a thread that is opened, sent and closed; a feature whose view chats on
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
`json:commit-message`; a diagram is a ```` ```mermaid ```` block); otherwise answer in prose
(Markdown, no HTML).

When the turn ends, the tagged blocks become artifact blocks. The card asks main to check one
(`aiThreadArtifact`) with **the same verifier as the feature's first answer**, against what the
feature saw: `verifyFindings` (findings on lines of the change; the rest listed as thrown out),
`repairPlan`, `verifyWalkthrough`, the commit-message cleaner, `mermaid.parse` for a diagram (in the renderer, which has a DOM). An
anchor only takes its own kinds. **Apply** is the user's: findings join the review marked "from
chat" (Undo), a plan becomes the recompose editor's plan as one undo step, a walkthrough is
replaced (Undo), a commit message replaces the draft in the commit box (Undo), a diagram is drawn
inline (an invalid one shows the parser's message). Nothing changes behind the user.

## Markdown

Answers are drawn by an in-house subset (`lib/markdown.ts`): paragraphs, headings, lists,
emphasis, inline code, links, fenced code (highlighted by the diff view's highlighter), quotes,
rules. It produces data, drawn as React elements: there is no HTML passthrough at all, so there
is nothing to sanitise, and links open in the browser through main, which takes only http,
https and mailto.
