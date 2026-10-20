import { commandArgv } from './command'

/**
 * AI features: the shapes that cross IPC. The work happens in the main process
 * (apps/desktop/src/main/ai/): an agent over the Agent Client Protocol, or the Anthropic API as
 * a fallback for people with no agent installed.
 */

export type AiProvider = 'off' | 'agent' | 'anthropic'
export type AgentPreset = 'claude' | 'codex' | 'gemini' | 'custom'

/** The agents GitGoose knows how to start. Each speaks ACP on stdin/stdout. */
export const AGENT_PRESETS: Record<Exclude<AgentPreset, 'custom'>, { label: string; command: string }> = {
  claude: { label: 'Claude', command: 'npx -y @agentclientprotocol/claude-agent-acp' },
  codex: { label: 'Codex', command: 'npx -y @agentclientprotocol/codex-acp' },
  gemini: { label: 'Gemini CLI', command: 'gemini --experimental-acp' },
}

/** The command line for the configured agent ('' for a custom agent with no command yet). */
export function agentCommandLine(preset: AgentPreset, custom: string): string {
  return preset === 'custom' ? custom.trim() : AGENT_PRESETS[preset].command
}

export function agentLabel(preset: AgentPreset, custom: string): string {
  if (preset !== 'custom') return AGENT_PRESETS[preset].label
  // The program's name, or for "node agent.js"-style commands the script's.
  const argv = commandArgv(custom, {})
  const base = (a?: string) => a?.split(/[\\/]/).pop()?.replace(/\.(c|m)?js$|\.exe$/i, '')
  const prog = base(argv[0])
  return (prog && /^(node|bun|deno|python3?|npx)$/i.test(prog) ? base(argv.find((a, i) => i > 0 && !a.startsWith('-'))) : prog) || 'Custom agent'
}

/** Which changes a review covers. */
export type ReviewScope =
  | { kind: 'staged' }
  /** Everything uncommitted (staged and unstaged, against HEAD). */
  | { kind: 'working' }
  /** A branch since it forked from its base (upstream's default branch, or `base`). */
  | { kind: 'branch'; branch: string; base?: string }
  /** Selected commits (graph order): their combined change. */
  | { kind: 'commits'; hashes: string[] }
  /** What a push of the branch (default: the current one) would send: commits its upstream, or no remote, has not got. */
  | { kind: 'outgoing'; branch?: string }

/** How much to say: quiet (only real problems), chill (no nits), assertive (everything). */
export type ReviewProfile = 'quiet' | 'chill' | 'assertive'
export type FindingSeverity = 'critical' | 'major' | 'minor' | 'nit'
export type FindingType = 'bug' | 'security' | 'performance' | 'maintainability' | 'style' | 'docs' | 'tests'

export const SEVERITIES: FindingSeverity[] = ['critical', 'major', 'minor', 'nit']
export const FINDING_TYPES: FindingType[] = ['bug', 'security', 'performance', 'maintainability', 'style', 'docs', 'tests']

export interface ReviewFinding {
  id: string
  path: string
  /** New-side line numbers (as the file is after the change), inclusive. */
  startLine: number
  endLine: number
  type: FindingType
  severity: FindingSeverity
  title: string
  message: string
  /** Replacement text for startLine..endLine, when the fix is local. */
  suggestion?: string
  /** Those lines as they are now (to show the suggestion as a change). */
  original?: string[]
  /** On a re-review: new, or carried over from the last review because its lines are unchanged. */
  status?: 'new' | 'open'
  /** Who found it: absent for the model, 'scan' for the built-in secret scan, 'lint' for a linter. */
  source?: 'scan' | 'lint'
  /** The linter's name (and rule, when it gives one), for source 'lint'. */
  tool?: string
  /** Applied from a conversation about the review (a json:findings artifact), not the review itself. */
  fromChat?: boolean
}

/**
 * A pre-push check: a rule in plain words ("No console.log calls left in src/"), judged by the AI
 * against what a push would send. `block` stops the push when it fails (the user can still push
 * anyway); `warn` only says so. From .coderabbit.yaml (reviews.pre_merge_checks.custom_checks) or
 * the user's own list for the repository.
 */
export interface PushCheck {
  name: string
  instructions: string
  mode: 'warn' | 'block'
}

export type PushCheckVerdict = 'pass' | 'fail' | 'inconclusive'

export interface PushCheckResult {
  name: string
  mode: PushCheck['mode']
  /** builtin: GitGoose's own (no AI); repo: .coderabbit.yaml; settings: the user's list. */
  source: 'builtin' | 'repo' | 'settings'
  verdict: PushCheckVerdict
  /** One or two sentences on why, in plain words. */
  reason: string
  /** Lines in the outgoing change that show it (checked to be in the change). */
  evidence: { path: string; line: number }[]
}

/** The checks for one push, before the AI has judged them. Local and cheap. */
export interface PushCheckPlan {
  /** "2 commits to origin/main"; empty when there is nothing to push. */
  label: string
  commits: number
  /** Checks the AI judges, in order: the ids sent are C1, C2, …. */
  checks: (PushCheck & { source: 'repo' | 'settings' })[]
  /** Results that need no AI (the secret scan). */
  local: PushCheckResult[]
}

/** A linter a review can run: detected from the repository's config, or a command from Settings. */
export interface LinterInfo {
  name: string
  /** Exactly what runs (argv joined); `{files}` stands for the changed files. Approval is per this text. */
  command: string
  /** File extensions it takes (".ts"); null for any file. */
  extensions: string[] | null
  source: 'detected' | 'settings'
  /** The user's answer for this repository: run it, never run it, or not asked yet. */
  decision: 'allow' | 'deny' | null
}

/** What happened to one linter during a review. */
export interface LinterRun {
  name: string
  command: string
  status: 'ran' | 'failed' | 'skipped'
  /** Files it was given. */
  files: number
  /** Its reports on changed lines (the ones that became findings). */
  findings: number
  /** Why it failed or was skipped, or how many reports were outside the change. */
  note?: string
}

/** A summary of what a review was told besides the diff. */
export interface ReviewContextInfo {
  guidelines: string[]
  pathInstructions: string[]
  learnings: number
  linters?: LinterRun[]
  /** Commit messages sent as the change's intent (commit, branch and outgoing scopes). */
  commits?: number
  /** What the code graph added (see CodeContext); absent when the change defines nothing and uses nothing known. */
  code?: { source: CodeContext['source']; symbols: number; uses: number; used: number; tests: number; truncated: boolean }
}

/**
 * What the code graph adds to a review or walkthrough besides the diff: the definitions the
 * change touches and who uses them outside it, the definitions of names its added lines use,
 * and the tests that cover it. Built locally by Repo.codeContext; the model only reads it.
 */
export interface CodeContext {
  /** 'graph': parsed by tree-sitter (ADR-008). 'patterns': line patterns and git grep, while the graph is not ready. */
  source: 'graph' | 'patterns'
  symbols: {
    name: string
    kind: string
    path: string
    line: number
    change: 'changed' | 'added' | 'removed'
    /** The defining line now (before the change, for a removed definition). */
    signature: string
    /** The defining line before the change, when it differs. */
    oldSignature?: string
    /** Uses outside the change, in all and in tests, and a sample of them (non-test first). */
    uses: number
    testUses: number
    callers: { path: string; line: number; text: string; within?: string; test: boolean }[]
  }[]
  /** Definitions, outside the change, of names the added lines use; most used first. */
  used: { name: string; kind: string; path: string; line: number; endLine: number; preview: string[]; uses: number }[]
  /** Tests for the changed files (by name) or using the changed definitions. */
  tests: { path: string; inChange: boolean }[]
}

export interface ReviewResult {
  scope: ReviewScope
  profile: ReviewProfile
  /** "Uncommitted changes", "feature since main", "3 commits". */
  label: string
  /**
   * The revision the line numbers refer to: 'worktree', 'index', or a commit. Diffs whose new side
   * is this revision show the findings in their gutter.
   */
  head: string
  /** What it is compared with ('HEAD', a fork point, a parent); absent for staged (HEAD → index). */
  base?: string
  summary: string
  findings: ReviewFinding[]
  /** What verification threw out, and why (a path not in the change, lines outside it, …). */
  dropped: { title: string; reason: string }[]
  /** Files that were in the change but not sent (over the size budget). */
  skipped: string[]
  /** What the model was told besides the diff (shown, so a review is never a black box). */
  context: ReviewContextInfo
  /** Keys of the hunks reviewed (and of unchanged ones carried over): what a re-review can skip. */
  hunkKeys: string[]
  /** A key of what the model was told besides the diff: a re-review with other guidance starts over. */
  contextKey: string
  /** On a re-review: pieces sent again vs. unchanged, and earlier findings whose lines changed. */
  incremental?: { sent: number; unchanged: number; addressed: { title: string; path: string }[] }
}

/** Where a hunk sits in a reading order: read contracts first, then what implements them, then tests. */
export type ReadingLayer = 'contract' | 'implementation' | 'tests' | 'config' | 'docs'

export interface WalkthroughHunk {
  id: string
  path: string
  layer: ReadingLayer
  /** New-side lines (old side for deletions). */
  startLine: number
  endLine: number
  added: number
  removed: number
  /** Whitespace, imports or a one-line tweak: folded in the reading order. */
  trivial: boolean
  /** The definition it is in, when known. */
  within?: string
  /** The model's one-line summary. */
  summary?: string
}

export interface SequenceDiagram {
  participants: string[]
  messages: { from: string; to: string; label: string }[]
}

export interface WalkthroughResult {
  scope: ReviewScope
  label: string
  head: string
  base?: string
  summary: string
  /** 1 (trivial) to 5 (needs a long, careful review), with the reason. */
  effort: number
  effortWhy: string
  groups: { title: string; description: string; files: string[] }[]
  /** Hunks in reading order. */
  hunks: WalkthroughHunk[]
  sequence: SequenceDiagram | null
  /** Recent commits (before this change) that touched the same files. */
  history: { hash: string; subject: string; author: string; date: number }[]
  skipped: string[]
}

/** What a change could affect beyond itself (see Repo.impact). */
export interface ImpactResult {
  scope: ReviewScope
  label: string
  head: string
  base?: string
  /** Definitions the change touches, adds or removes. */
  symbols: { name: string; kind: string; path: string; line: number; change: 'changed' | 'added' | 'removed' }[]
  /** Uses of those symbols outside the change, numbered for the model to cite. */
  callers: { id: string; symbol: string; path: string; line: number; text: string; within?: string; test: boolean }[]
  /** Test files that cover the changed files or use the changed symbols. */
  tests: string[]
  /** Files that usually change with these but are not in the change. */
  coChange: { path: string; with: string; together: number; total: number }[]
  /** Set by "Assess impact": which call sites the model thinks are at risk, and why. */
  assessment?: { summary: string; risks: { id: string; why: string }[]; dropped: number }
}

/** A question-and-answer thread about some lines, pinned to the commit they were asked at. */
export interface AskThread {
  id: string
  /** The commit the lines were read at, or 'worktree'. */
  rev: string
  path: string
  startLine: number
  endLine: number
  /** The lines asked about, as they were. */
  code: string
  messages: { role: 'user' | 'ai'; text: string }[]
  updated: number
}

/** A team preference learned from a dismissed finding, sent with later reviews. */
export interface ReviewLearning {
  text: string
  /** Only for files matching this glob (empty: everywhere). */
  path?: string
  added: number
}

/** What the user asked the AI to do. Each builds its own prompt in main/ai/prompts.ts. */
export interface AiRunOptions {
  /** Send even though the secret scan found something, with each hit replaced by "[REDACTED kind]". */
  redact?: boolean
  /**
   * Keep the conversation open after the answer (AiResult.threadId): the view that shows the
   * result chats on in the same session. Without it the session is closed straight away.
   */
  keepThread?: boolean
}

export type AiTask =
  | { kind: 'commit-message' }
  | { kind: 'explain-commit'; hash: string }
  | { kind: 'explain-error'; title: string; detail: string }
  | { kind: 'resolve-conflict'; path: string }
  /** Rebuild these commits (graph order) as a better-structured set. */
  | { kind: 'recompose'; hashes: string[] }
  /** Review a change: findings tied to lines, checked against the diff before they are shown. */
  | { kind: 'push-checks'; branch?: string; checks: PushCheckPlan['checks'] }
  | { kind: 'review'; scope: ReviewScope; profile: ReviewProfile; previous?: { findings: ReviewFinding[]; hunkKeys: string[]; contextKey: string } }
  /** Explain a change: summary, grouped files, effort, reading order, a sequence diagram. */
  | { kind: 'walkthrough'; scope: ReviewScope }
  /** Which of the call sites found by Repo.impact are at risk (it may cite only those). */
  | { kind: 'assess-impact'; scope: ReviewScope }
  /** A question about lines of a file, with their function, definitions and history as context. */
  | { kind: 'ask'; rev: string | null; path: string; startLine: number; endLine: number; question: string; earlier: { role: 'user' | 'ai'; text: string }[] }
  /** Fix one review finding: the agent proposes the whole file (nothing is written until accepted). */
  | { kind: 'fix-finding'; finding: ReviewFinding }

export interface AiStatus {
  provider: AiProvider
  /** "Claude", "Anthropic API", … */
  label: string
  /** Something to talk to is configured (an agent command, or an API key). */
  ready: boolean
  /** The user agreed to send content to this provider (asked once per provider + agent). */
  consented: boolean
  hasApiKey: boolean
  /** The key is kept in memory only (no OS keychain). */
  keyInMemoryOnly: boolean
}

export interface AgentAuthMethod {
  id: string
  name: string
  description?: string
  /** For terminal logins: the command to run in a terminal. Otherwise GitGoose asks the agent. */
  terminalCommand?: string
}

export interface AgentInfo {
  name: string
  version: string
  protocolVersion: number
  authMethods: AgentAuthMethod[]
}

/** An agent wants to run a tool: shown as a modal, answered with one of its options or nothing. */
export interface AiPermissionRequest {
  permissionId: number
  /** The AI request this belongs to. */
  requestId: string
  title: string
  kind: string
  paths: string[]
  options: { optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }[]
}

/** One piece of a recompose: a hunk, or a whole file when it has no hunks. */
export interface RecomposeUnitInfo {
  id: string
  path: string
  added: number
  removed: number
  binary: boolean
  /** The hunk (cut after 200 lines), for the review dialog. */
  preview: string
}

export interface RecomposeProposal {
  /** The commits being replaced, graph order (newest first). */
  hashes: string[]
  branch: string
  units: RecomposeUnitInfo[]
  /** The proposed commits, oldest first. */
  commits: { message: string; units: string[] }[]
  /** Units the model left out; they were added to the last commit. */
  unplaced: string[]
  /** Remote branches that already have these commits (rewriting them means a force-push later). */
  onRemote: string[]
}

export interface AiResult {
  text: string
  /** recompose: the proposed commits, for review before anything changes. */
  recompose?: RecomposeProposal
  /** assess-impact: the impact, with the checked assessment. */
  impact?: ImpactResult
  /** walkthrough: the checked walkthrough. */
  walkthrough?: WalkthroughResult
  /** review: the verified findings. */
  review?: ReviewResult
  /** push-checks: one checked verdict per check sent, in the same order. */
  pushChecks?: PushCheckResult[]
  /** resolve-conflict: the file the agent wrote, captured instead of written, for review. */
  proposal?: { path: string; content: string }
  /** With keepThread: the thread the answer is the first turn of. */
  threadId?: string
}

/** The error code an AI request fails with when the agent needs the user to log in first. */
export const AI_AUTH_REQUIRED = 'ai-auth'

// ------------------------------------------------------------------ threads (spec 006, PLAN-4 5a)

/**
 * What a thread is about. The anchor decides the context the agent gets first (a system
 * preamble per anchor in main/ai/prompts.ts) and which artifacts it may send back.
 */
export type ThreadAnchor =
  | { kind: 'review'; scope: ReviewScope }
  | { kind: 'explain'; hash: string }
  | { kind: 'recompose'; hashes: string[] }
  | { kind: 'walkthrough'; scope: ReviewScope }
  | { kind: 'impact'; scope: ReviewScope }
  /** Lines of a file at a commit ('worktree' for the working tree); `code` is the lines as they were. */
  | { kind: 'ask'; rev: string; path: string; lines: [number, number]; code: string }
  | { kind: 'changestack'; scope: ReviewScope }
  /** The AI panel: only the repository's name and HEAD go along. */
  | { kind: 'free' }
  /** A one-shot request (aiRun) with no view of its own: commit message, push checks, conflict help. Never kept. */
  | { kind: 'task'; task: AiTask['kind'] }

/**
 * Structured results an agent may send inside a conversation, each as one fenced block tagged
 * ```json:<kind>. The renderer parses them and main checks them with the same verifier as the
 * feature's first answer (findings, plan, walkthrough) before anything can be applied.
 */
export type ArtifactKind = 'findings' | 'plan' | 'diagram' | 'commit-message' | 'walkthrough'
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['findings', 'plan', 'diagram', 'commit-message', 'walkthrough']

export interface AiToolCall {
  id: string
  title: string
  /** ACP's tool kind: read, edit, delete, move, search, execute, think, fetch, switch_mode, other. */
  kind: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  /** The tool's input as the agent sent it (JSON, cut for size): often the real command where the title is prose. */
  rawInput?: string
  locations: string[]
  content: AiToolContent[]
}

export type AiToolContent =
  | { type: 'text'; text: string }
  /** oldText null: a new file. */
  | { type: 'diff'; path: string; oldText: string | null; newText: string }

export interface AiPlanEntry {
  content: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
}

/** How the user answered a permission card. 'expired': the turn ended before anyone answered. */
export type PermissionAnswer = 'deny' | 'once' | 'session' | 'expired'

/** A tool call waiting for the user, shown inline in the thread (see AiService.answerPermission). */
export interface AiPermissionAsk {
  permissionId: number
  title: string
  kind: string
  paths: string[]
  rawInput?: string
  /** Which of the three answers the agent's options allow (Allow for this session always works: GitGoose remembers it). */
  options: AiPermissionRequest['options']
  answer?: PermissionAnswer
}

export type AiBlock =
  /** Markdown. */
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool'; tool: AiToolCall }
  | { type: 'plan'; entries: AiPlanEntry[] }
  | { type: 'permission'; permission: AiPermissionAsk }
  /** A tagged block split out of the text when the turn finished; `json` is the block's body, unchecked. */
  | { type: 'artifact'; artifact: ArtifactKind; json: string }

export interface AiTurn {
  /** `${requestId}:u` or `${requestId}:a`. */
  id: string
  role: 'user' | 'agent'
  requestId: string
  blocks: AiBlock[]
  /**
   * The feature's own exchange (the review request and its JSON answer): the view shows the
   * result itself, so the thread shows this one line instead.
   */
  feature?: string
  /** Agent turns: streaming, finished, stopped, or failed. */
  status?: 'running' | 'done' | 'cancelled' | 'error'
  error?: { message: string; code?: string }
  at: number
}

export interface AiThread {
  id: string
  repoId: string
  anchor: ThreadAnchor
  /** For lists: the question, the feature, or the first message. */
  title: string
  turns: AiTurn[]
  createdAt: number
  updatedAt: number
  /** HEAD when the thread started (a thread is pinned to what the repository was then). */
  head: string
  /** The agent's session mode, and the slash commands it offers (ACP current_mode_update, available_commands_update). */
  mode?: string
  commands?: string[]
}

/**
 * One event of a thread, from main. A thread is a fold of these (reduceThread, ./thread.ts),
 * run by main for the copy it keeps and by the renderer for the copy it shows.
 */
export type AiUpdate =
  /** A user turn was sent (and the agent's turn begins). */
  | { kind: 'turn'; text: string; feature?: string; at: number }
  /** Streamed text, appended. */
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  /** A tool call, whole (main merges tool_call_update into it): replaces the one with the same id. */
  | { kind: 'tool'; tool: AiToolCall }
  | { kind: 'plan'; entries: AiPlanEntry[] }
  | { kind: 'permission'; permission: AiPermissionAsk }
  | { kind: 'permission-answered'; permissionId: number; answer: PermissionAnswer }
  | { kind: 'meta'; mode?: string; commands?: string[] }
  | { kind: 'done'; stopReason: string }
  | { kind: 'error'; message: string; code?: string }

/** A checked artifact: what Apply would do. Errors are reported as `problem`, never thrown at the card. */
export type AiArtifactResult =
  | { kind: 'findings'; review: ReviewResult }
  | { kind: 'plan'; recompose: RecomposeProposal }
  | { kind: 'walkthrough'; walkthrough: WalkthroughResult }
  | { kind: 'commit-message'; message: string }
  | { kind: 'diagram'; sequence: SequenceDiagram }
  | { kind: 'problem'; message: string }
