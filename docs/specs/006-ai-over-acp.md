# 006: AI features over the Agent Client Protocol

PLAN-2 §9b. Code: `apps/desktop/src/main/ai/` (acp.ts, service.ts, prompts.ts, anthropic.ts,
keyStore.ts), `packages/shared/src/ai.ts`, renderer `lib/ai.ts`, `components/AiDialogs.tsx`,
`components/AiPanel.tsx`. Tests: `main/ai/*.test.ts` and `e2e/ai.spec.ts`, against
`e2e/fake-agent.mjs` (a real ACP agent over stdio, scripted) and `fakeAnthropic`. No test talks
to a real agent or API.

## Settings → AI

- *AI features*: Off (default) · An agent on this computer (ACP) · Anthropic API key.
- *Agent*: Claude (`npx -y @agentclientprotocol/claude-agent-acp`), Codex
  (`npx -y @agentclientprotocol/codex-acp`), Gemini CLI (`gemini --experimental-acp`), or a custom
  command. **Test** starts the agent, runs `initialize`, shows name, version and login methods.
- API key: stored with safeStorage (memory only without a keychain), model setting
  (`claude-opus-5-5` by default). Text features only.

## Features

| where | what is sent | result |
|---|---|---|
| Commit box → **Write** | staged diff (lockfiles excluded, 60k chars max) and 12 recent subjects | streams into Summary / Description |
| Commit details → **Explain** | `git show` of the commit | streams into a box under the message |
| Attention bar → **Explain** | the failed action and git's output | streams into a modal |
| Conflict file → **Ask AI** (agent only) | the file path; the agent reads the file | a *proposal* dialog: Use this resolution / Discard |

## Rules main enforces

- **Consent before anything.** A request fails with `ai-consent` until the user agreed to this
  provider (for agents: this exact command). The agent process is not started before that.
  The renderer asks first, naming what each feature sends.
- **A fresh session per request** (`session/new` with cwd = the repository; closed afterwards
  when the agent supports `session/close`). Requests are independent: a shared session would
  serialize them and drag every earlier diff along.
- **Permissions.** Every `session/request_permission` becomes a modal (Deny · Allow once · Allow
  for this session), except `read` tool calls whose paths are all inside the repository
  (symlinks resolved). Unanswered questions are dropped when their request ends.
- **Files.** `fs/read_text_file` only inside the session's repository. `fs/write_text_file`
  only for the one file a conflict request names, and the content is captured as a proposal,
  never written; accepting it goes through `resolveConflict` like a hand resolution.
  `terminal: false`: the agent gets no shell from GitGoose.
- **Login.** `auth_required` (-32000) comes back as error code `ai-auth`; the renderer shows
  the agent's login methods: agent-handled ones call `authenticate`, terminal ones show the
  exact command (the agent's own command plus the method's args) with Copy / Open terminal /
  I have logged in. Then the request is retried once.
- **Lifecycle.** Started on first use, kept running, restarted after a crash on the next use
  (the failed request reports the agent's stderr), stopped when the agent command changes and
  on quit.
