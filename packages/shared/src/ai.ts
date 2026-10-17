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

/** What the user asked the AI to do. Each builds its own prompt in main/ai/prompts.ts. */
export type AiTask =
  | { kind: 'commit-message' }
  | { kind: 'explain-commit'; hash: string }
  | { kind: 'explain-error'; title: string; detail: string }
  | { kind: 'resolve-conflict'; path: string }

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

export interface AiResult {
  text: string
  /** resolve-conflict: the file the agent wrote, captured instead of written, for review. */
  proposal?: { path: string; content: string }
}

/** The error code an AI request fails with when the agent needs the user to log in first. */
export const AI_AUTH_REQUIRED = 'ai-auth'
