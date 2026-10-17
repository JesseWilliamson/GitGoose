import { commandArgv } from './command'

/**
 * AI features: the shapes that cross IPC. The work happens in the main process
 * (apps/desktop/src/main/ai/): an agent over the Agent Client Protocol, or the Anthropic API as
 * a fallback for people with no agent installed.
 */

export type AiProvider = 'off' | 'agent' | 'anthropic'
export type AgentPreset = 'claude' | 'codex' | 'gemini' | 'custom'

/** The agents GitSquid knows how to start. Each speaks ACP on stdin/stdout. */
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
  context: { guidelines: string[]; pathInstructions: string[]; learnings: number }
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
export type AiTask =
  | { kind: 'commit-message' }
  | { kind: 'explain-commit'; hash: string }
  | { kind: 'explain-error'; title: string; detail: string }
  | { kind: 'resolve-conflict'; path: string }
  /** Rebuild these commits (graph order) as a better-structured set. */
  | { kind: 'recompose'; hashes: string[] }
  /** Review a change: findings tied to lines, checked against the diff before they are shown. */
  | { kind: 'review'; scope: ReviewScope; profile: ReviewProfile }
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
  /** For terminal logins: the command to run in a terminal. Otherwise GitSquid asks the agent. */
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
  /** The first lines of the hunk, for the review dialog. */
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
  /** resolve-conflict: the file the agent wrote, captured instead of written, for review. */
  proposal?: { path: string; content: string }
}

/** The error code an AI request fails with when the agent needs the user to log in first. */
export const AI_AUTH_REQUIRED = 'ai-auth'
