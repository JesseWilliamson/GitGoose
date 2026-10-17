import type { GraphFilter } from './index'
import { DEFAULT_LAYOUT, normalizeLayout, type PaneLayout } from './layout'

export type GraphColumn = 'refs' | 'graph' | 'author' | 'date' | 'sha'
export type GraphColumns = Record<GraphColumn, boolean>
export const GRAPH_COLUMNS: { id: GraphColumn; label: string }[] = [
  { id: 'refs', label: 'Branch / Tag' },
  { id: 'graph', label: 'Graph' },
  { id: 'author', label: 'Author' },
  { id: 'date', label: 'Date / Time' },
  { id: 'sha', label: 'SHA' },
]
export const DEFAULT_GRAPH_COLUMNS: GraphColumns = { refs: true, graph: true, author: true, date: true, sha: true }

function normalizeColumns(raw: unknown): GraphColumns {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return Object.fromEntries(GRAPH_COLUMNS.map((c) => [c.id, typeof r[c.id] === 'boolean' ? r[c.id] : true])) as GraphColumns
}

/**
 * Every setting in one table. The settings page, defaults, validation and migration all come
 * from this, so adding a setting is one entry here and nothing else drifts out of sync.
 *
 * Each entry has a kind (how it is edited and validated), a default, and where it appears.
 * `internal` entries are app state that lives in the same file (recent repos, column widths)
 * and never appear on the page.
 */

interface Meta {
  label: string
  section: Section
  description?: string
  /** Extra words the settings search should match. */
  keywords?: string
}

export type Section = 'Appearance' | 'Graph' | 'Git' | 'Diff' | 'Confirmations' | 'Integrations' | 'AI' | 'Accounts' | 'Startup' | 'Keyboard'

export const SECTIONS: Section[] = ['Appearance', 'Graph', 'Git', 'Diff', 'Confirmations', 'Integrations', 'AI', 'Accounts', 'Startup', 'Keyboard']

export type SettingSpec =
  | (Meta & { kind: 'boolean'; default: boolean })
  | (Meta & { kind: 'number'; default: number; min: number; max: number; step: number; unit?: string; format?: 'percent' })
  | (Meta & { kind: 'choice'; default: string; options: readonly { value: string; label: string }[] })
  | (Meta & { kind: 'text'; default: string; placeholder?: string })
  | (Meta & { kind: 'keybindings'; default: Record<string, string> })
  | { kind: 'internal'; default: unknown }

const bool = (d: boolean, m: Meta) => ({ kind: 'boolean' as const, default: d, ...m })
const num = (d: number, min: number, max: number, step: number, m: Meta & { unit?: string; format?: 'percent' }) =>
  ({ kind: 'number' as const, default: d, min, max, step, ...m })
const text = (d: string, m: Meta & { placeholder?: string }) => ({ kind: 'text' as const, default: d, ...m })
function choice<const V extends string>(d: NoInfer<V>, options: readonly { value: V; label: string }[], m: Meta) {
  return { kind: 'choice' as const, default: d as V, options, ...m }
}
function internal<T>(d: T) {
  return { kind: 'internal' as const, default: d }
}

export const SETTINGS = {
  // ---------------------------------------------------------------- Appearance
  theme: choice('system', [{ value: 'system', label: 'Match system' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }],
    { label: 'Theme', section: 'Appearance' }),
  uiScale: num(1, 0.8, 1.75, 0.05, {
    label: 'UI scale', section: 'Appearance', format: 'percent', keywords: 'zoom size font bigger smaller',
    description: 'Scales the whole window. Ctrl/⌘ + and − change it too; Ctrl/⌘ 0 resets.',
  }),
  codeFontSize: num(12, 10, 20, 1, { label: 'Code font size', section: 'Appearance', unit: 'px', description: 'Diffs, blame, conflict editors and the commit message.' }),
  codeFontFamily: text('', { label: 'Code font', section: 'Appearance', placeholder: 'System monospace', description: 'A CSS font family list, e.g. "JetBrains Mono", monospace.' }),
  dateFormat: choice('relative', [{ value: 'relative', label: 'Relative (3 days ago)' }, { value: 'absolute', label: 'Absolute (12 Mar 2026)' }, { value: 'both', label: 'Both' }],
    { label: 'Dates', section: 'Appearance' }),
  compactRows: bool(false, { label: 'Compact graph rows', section: 'Appearance', keywords: 'density row height' }),

  // ---------------------------------------------------------------- Graph
  avatars: choice('initials', [
    { value: 'initials', label: 'Initials (no network)' },
    { value: 'github', label: 'GitHub' },
    { value: 'gravatar', label: 'Gravatar' },
  ], {
    label: 'Author avatars', section: 'Graph', keywords: 'picture photo image node',
    description: 'GitHub: authors with a GitHub noreply address; once you sign in with GitHub (Accounts), any author whose commits GitHub has. Gravatar: sends a hash of each author email. Images are cached for 30 days.',
  }),
  showRemoteBranches: bool(true, { label: 'Show remote branches on the graph', section: 'Graph' }),
  showTags: bool(true, { label: 'Show tags on the graph', section: 'Graph' }),
  showStashes: bool(true, { label: 'Show stashes on the graph', section: 'Graph', description: 'Each stash as a node beside the commit it was made on.' }),

  // ---------------------------------------------------------------- Git
  gitPath: text('git', { label: 'Git executable', section: 'Git', placeholder: 'git', description: 'Applies to repositories opened after the change.' }),
  pullMode: choice('merge', [{ value: 'merge', label: 'Merge' }, { value: 'rebase', label: 'Rebase' }, { value: 'ff-only', label: 'Fast-forward only' }],
    { label: 'Pull', section: 'Git', description: 'What the Pull button does when your branch and its upstream have both moved.' }),
  fetchOnOpen: bool(false, { label: 'Fetch when a repository opens', section: 'Git', description: 'Off by default: it uses the network.' }),
  autoFetchMinutes: num(0, 0, 60, 5, { label: 'Fetch automatically every', section: 'Git', unit: 'min', description: '0 turns it off.' }),
  pruneOnFetch: bool(true, { label: 'Prune deleted remote branches on fetch', section: 'Git' }),
  signOff: bool(false, { label: 'Add Signed-off-by to commits', section: 'Git', keywords: 'dco' }),
  gpgSign: bool(false, { label: 'Sign commits (-S)', section: 'Git', keywords: 'gpg ssh signing', description: 'Uses the signing key from your git config.' }),
  signTags: bool(false, { label: 'Sign tags (-s)', section: 'Git', keywords: 'gpg ssh signing', description: 'New tags are signed (and annotated) with the signing key from your git config.' }),

  // ---------------------------------------------------------------- Diff
  contextLines: num(3, 1, 20, 1, { label: 'Context lines', section: 'Diff', unit: 'lines', description: 'Unchanged lines shown around each change.' }),
  ignoreWhitespace: bool(false, { label: 'Ignore whitespace changes', section: 'Diff', description: 'Line staging is turned off while this is on: the hidden changes would be staged too.' }),
  tabSize: num(4, 1, 8, 1, { label: 'Tab size', section: 'Diff', unit: 'spaces' }),
  wrapLines: bool(false, { label: 'Wrap long lines', section: 'Diff' }),
  diffLayout: choice('unified', [{ value: 'unified', label: 'Unified' }, { value: 'split', label: 'Side by side' }],
    { label: 'Diff layout', section: 'Diff', keywords: 'split side-by-side', description: 'Also switchable above each diff. Changed words are highlighted in both.' }),
  syntaxHighlighting: bool(true, { label: 'Syntax highlighting', section: 'Diff' }),
  highlightMaxKb: num(400, 50, 4000, 50, { label: 'Highlight files up to', section: 'Diff', unit: 'KB' }),
  mergeView: choice('three-pane', [
    { value: 'three-pane', label: 'Three panes' },
    { value: 'auto', label: 'Three panes, blocks for small conflicts' },
    { value: 'blocks', label: 'Blocks' },
  ], {
    label: 'Conflict view', section: 'Diff', keywords: 'merge resolve intellij',
    description: 'Three panes: yours, the result and theirs, IntelliJ style. Blocks: pick a side per conflict. Small means fewer than 3 conflicts.',
  }),

  // ---------------------------------------------------------------- Confirmations
  confirmForcePush: bool(true, { label: 'Confirm force push', section: 'Confirmations', description: 'Changes to a remote cannot be undone.' }),
  confirmDeleteRemoteBranch: bool(true, { label: 'Confirm deleting a remote branch', section: 'Confirmations' }),
  confirmDiscard: bool(false, { label: 'Confirm discarding changes', section: 'Confirmations', description: 'Off by default: discards can be undone.' }),
  confirmHardReset: bool(false, { label: 'Confirm hard reset', section: 'Confirmations', description: 'Off by default: hard resets can be undone.' }),

  // ---------------------------------------------------------------- Integrations
  editorCommand: text('', {
    label: 'External editor', section: 'Integrations', placeholder: 'code --goto {file}:{line}',
    description: '{file} and {line} are filled in. Empty opens files with the system default app.',
  }),
  terminalCommand: text('', { label: 'Terminal', section: 'Integrations', placeholder: 'System default', description: 'Runs in the repository folder.' }),

  // ---------------------------------------------------------------- AI
  aiProvider: choice('off', [
    { value: 'off', label: 'Off' },
    { value: 'agent', label: 'An agent on this computer (ACP)' },
    { value: 'anthropic', label: 'Anthropic API key' },
  ], {
    label: 'AI features', section: 'AI', keywords: 'claude gemini codex llm acp agent',
    description: 'Commit messages, explanations and conflict help. Nothing is sent anywhere until you use one, and GitSquid asks first.',
  }),
  aiAgent: choice('claude', [
    { value: 'claude', label: 'Claude' },
    { value: 'codex', label: 'Codex' },
    { value: 'gemini', label: 'Gemini CLI' },
    { value: 'custom', label: 'Custom command' },
  ], { label: 'Agent', section: 'AI', description: 'Started on first use and kept running until GitSquid quits. It uses its own login.' }),
  aiAgentCommand: text('', {
    label: 'Custom agent command', section: 'AI', placeholder: 'my-agent --acp',
    description: 'Used when Agent is "Custom command". It must speak the Agent Client Protocol on stdin/stdout.',
  }),
  anthropicModel: text('claude-opus-5-5', { label: 'Model (API key only)', section: 'AI', placeholder: 'claude-opus-5-5' }),
  /** Providers the user agreed to send content to, e.g. "agent:npx -y …" or "anthropic". */
  aiConsent: internal([] as string[]),

  // ---------------------------------------------------------------- Accounts
  githubHttps: bool(false, {
    label: 'Use your GitHub sign-in for HTTPS push and fetch', section: 'Accounts', keywords: 'token password credential',
    description: 'Answers GitHub\'s password prompt with your sign-in (needs repository access, asked for once). Your credential helpers are skipped for github.com while this is on.',
  }),

  // ---------------------------------------------------------------- Startup
  reopenTabs: bool(true, { label: 'Reopen last session’s tabs', section: 'Startup' }),
  checkForUpdates: bool(true, { label: 'Check for updates', section: 'Startup', description: 'Packaged builds only.' }),
  openDevRepo: bool(true, { label: 'Open the development repository', section: 'Startup', description: 'Development builds only (pnpm dev): opens .fixtures/dev-repo when no other tab is open. Build it with pnpm dev:repo.' }),

  // ---------------------------------------------------------------- Keyboard
  keybindings: { kind: 'keybindings' as const, default: {} as Record<string, string>, label: 'Shortcuts', section: 'Keyboard' as const, description: 'Click a shortcut, then press the new keys. Esc cancels; Backspace restores the default.' },

  // ---------------------------------------------------------------- app state
  settingsVersion: internal(2),
  recentRepos: internal<string[]>([]),
  openRepos: internal<string[]>([]),
  graphWidth: internal<number | null>(null),
  /** Which optional graph columns show (the commit message always does). From the gear in the graph header. */
  graphColumns: internal<GraphColumns>({ ...DEFAULT_GRAPH_COLUMNS }),
  /** Hidden and soloed branches, per repository path (empty filters are not stored). */
  graphFilters: internal<Record<string, GraphFilter>>({}),
  /** Pane arrangement (packages/shared/src/layout.ts); repaired with normalizeLayout when read. */
  layout: internal<PaneLayout>(DEFAULT_LAYOUT),
} satisfies Record<string, SettingSpec>

export type SettingKey = keyof typeof SETTINGS
type Widen<T> = T extends boolean ? boolean : T extends number ? number : T
export type Settings = { -readonly [K in SettingKey]: Widen<(typeof SETTINGS)[K]['default']> }

export function defaultSettings(): Settings {
  const out: Record<string, unknown> = {}
  for (const [k, spec] of Object.entries(SETTINGS)) out[k] = structuredClone(spec.default)
  return out as Settings
}

/** Clean a value for one key: wrong types fall back to the default, numbers are clamped, choices checked. */
export function validateSetting<K extends SettingKey>(key: K, value: unknown): Settings[K] {
  const spec = SETTINGS[key] as SettingSpec
  const fallback = structuredClone(spec.default) as Settings[K]
  switch (spec.kind) {
    case 'boolean':
      return (typeof value === 'boolean' ? value : fallback) as Settings[K]
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
      const stepped = Math.round(value / spec.step) * spec.step
      return Math.min(spec.max, Math.max(spec.min, Number(stepped.toFixed(4)))) as Settings[K]
    }
    case 'choice':
      return (spec.options.some((o) => o.value === value) ? value : fallback) as Settings[K]
    case 'text':
      return (typeof value === 'string' ? value : fallback) as Settings[K]
    case 'keybindings':
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
      return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) as Settings[K]
    case 'internal':
      if (key === 'layout') return normalizeLayout(value) as Settings[K]
      if (key === 'graphColumns') return normalizeColumns(value) as Settings[K]
      // App state is trusted as long as its JSON shape matches the default's.
      if (value === undefined) return fallback
      if (Array.isArray(spec.default) !== Array.isArray(value)) return fallback
      return value as Settings[K]
  }
}

/** Validate a partial update; unknown keys are dropped. */
export function validatePatch(patch: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) if (k in SETTINGS) out[k] = validateSetting(k as SettingKey, v)
  return out as Partial<Settings>
}

/**
 * Bring a stored settings file up to date. Each step handles one old version; a file from any
 * older version runs every step after it. Unknown or broken values fall back to defaults instead
 * of stopping the app from starting.
 */
export function migrateSettings(stored: Record<string, unknown>): Settings {
  const s = { ...stored }
  const version = typeof s.settingsVersion === 'number' ? s.settingsVersion : 1
  if (version < 2) {
    // v1 had one "fontSize" slider (11-16 px, default 13) that never scaled much. Its intent was
    // "make everything bigger", which is what UI scale does now.
    if (typeof s.fontSize === 'number' && s.uiScale === undefined) s.uiScale = s.fontSize / 13
    delete s.fontSize
  }
  s.settingsVersion = 2
  const out = defaultSettings() as Record<string, unknown>
  for (const k of Object.keys(SETTINGS)) if (k in s) out[k] = validateSetting(k as SettingKey, s[k])
  return out as Settings
}
