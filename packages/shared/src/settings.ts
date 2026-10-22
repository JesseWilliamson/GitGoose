import type { GraphFilter } from './index'
import type { AiArea, AiModelList, AiTarget, AiThread, PushCheck, ReviewLearning } from './ai'
import { askToThread } from './thread'
import { DEFAULT_LAYOUT, normalizeLayout, type PaneLayout } from './layout'

/**
 * Every setting in one table. The settings page, defaults, validation and migration all come
 * from this, so adding a setting is one entry here and nothing else drifts out of sync.
 *
 * Each entry has a kind (how it is edited and validated), a default, and where it appears.
 * `internal` entries are app state that lives in the same file (recent repos, column widths)
 * and never appear on the page.
 */

/**
 * The sidebar's state for one repository (internal setting `sidebar`, by repository path): which
 * sections, folders and remotes are open (only those the user changed; the rest use their
 * default), and the gear menu's per-repository options.
 */
export interface SidebarPrefs {
  open?: Record<string, boolean>
  /** Badges: "merged" (already in HEAD) and "stale" (no commits for 90 days). Default on. */
  merged?: boolean
  stale?: boolean
  /** The Reflog item in Workspace, and the stash count beside Stashes. Default on. */
  reflog?: boolean
  stashCount?: boolean
  /** What a single click on a branch does: show its history (solo it in the graph), or only jump to its commit. */
  click?: 'history' | 'reveal'
}

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
  fileTree: bool(false, { label: 'Show changed files as a tree', section: 'Appearance', keywords: 'folder list view', description: 'In the changes and commit file lists. Also the toggle beside their filter box.' }),
  dateFormat: choice('relative', [{ value: 'relative', label: 'Relative (3 days ago)' }, { value: 'absolute', label: 'Absolute (12 Mar 2026)' }, { value: 'both', label: 'Both' }],
    { label: 'Dates', section: 'Appearance' }),
  // 'comfy' was 'comfortable' until the layouts were renamed; an old saved value is not an option
  // any more, so it falls back to the default, which is the same layout.
  graphStyle: choice('comfy', [
    { value: 'comfy', label: 'Comfy: two-line rows' },
    { value: 'compact', label: 'Compact: one-line rows, branches on the left' },
  ], {
    label: 'Graph layout', section: 'Appearance', keywords: 'comfy comfortable compact density row height columns tower',
    description: 'Comfy: author and branches over hash and subject. Compact: the same graph, each commit on one shorter line, branch and tag names in a column on the left.',
  }),

  sidebarFolders: bool(true, {
    label: 'Group branches and tags in folders', section: 'Appearance', keywords: 'sidebar tree folder slash',
    description: 'In the sidebar, names with a slash (feature/login) sit in folders. Also in the gear menu below the sidebar.',
  }),
  sidebarTags: choice('250', [
    { value: '50', label: 'Newest 50' }, { value: '100', label: 'Newest 100' }, { value: '250', label: 'Newest 250' }, { value: 'all', label: 'All' },
  ], { label: 'Tags in the sidebar', section: 'Appearance', keywords: 'sidebar tags limit', description: 'Newest first. Also View ▸ Tags. The filter box always searches all of them.' }),

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
  commitOrder: choice('date', [
    { value: 'date', label: 'Date (newest first; branches interleaved by time)' },
    { value: 'topo', label: 'Topological (each branch kept together)' },
  ], {
    label: 'Commit order', section: 'Graph', keywords: 'sort topological topo date order',
    description: "Date: newest first, branches interleaved by time (GitKraken, Tower). Topological: each branch's commits kept together; dates run out of order.",
  }),

  // ---------------------------------------------------------------- Git
  gitPath: text('git', { label: 'Git executable', section: 'Git', placeholder: 'git', description: 'Applies to repositories opened after the change.' }),
  pullMode: choice('merge', [{ value: 'merge', label: 'Merge' }, { value: 'rebase', label: 'Rebase' }, { value: 'ff-only', label: 'Fast-forward only' }],
    { label: 'Pull', section: 'Git', description: 'What the Pull button does when your branch and its upstream have both moved.' }),
  pushSecretCheck: bool(true, {
    label: 'Scan pushes for secrets', section: 'Git', keywords: 'pre-push check credential token key',
    description: 'Before a push, the commits being pushed are scanned for keys and tokens (on this computer; nothing is sent). A match stops the push until you choose to push anyway.',
  }),
  fetchOnOpen: bool(false, { label: 'Fetch when a repository opens', section: 'Git', description: 'Off by default: it uses the network.' }),
  autoFetchMinutes: num(0, 0, 60, 5, { label: 'Fetch automatically every', section: 'Git', unit: 'min', description: '0 turns it off.' }),
  pruneOnFetch: bool(true, { label: 'Prune deleted remote branches on fetch', section: 'Git' }),
  signOff: bool(false, { label: 'Add Signed-off-by to commits', section: 'Git', keywords: 'dco' }),
  codeGraph: bool(true, {
    label: 'Index code for Peek and Impact', section: 'Git', keywords: 'code graph tree-sitter symbols index parse',
    description: 'Parses the repository in the background when it opens; a commit or checkout re-indexes only what changed. Off: Peek and Impact fall back to text search.',
  }),
  gpgSign: bool(false, { label: 'Sign commits (-S)', section: 'Git', keywords: 'gpg ssh signing', description: 'Uses the signing key from your git config.' }),
  changeHints: bool(true, { label: 'Hints from history before committing', section: 'Git', keywords: 'co-change owners blame insights', description: 'Above the commit box: files that usually change with yours but are missing, and whose lines you are changing. Computed locally from history.' }),
  signTags: bool(false, { label: 'Sign tags (-s)', section: 'Git', keywords: 'gpg ssh signing', description: 'New tags are signed (and annotated) with the signing key from your git config.' }),

  // ---------------------------------------------------------------- Diff
  contextLines: num(3, 1, 20, 1, { label: 'Context lines', section: 'Diff', unit: 'lines', description: 'Unchanged lines shown around each change.' }),
  ignoreWhitespace: bool(false, { label: 'Ignore whitespace changes', section: 'Diff', description: 'Line staging is turned off while this is on: the hidden changes would be staged too.' }),
  tabSize: num(4, 1, 8, 1, { label: 'Tab size', section: 'Diff', unit: 'spaces' }),
  wrapLines: bool(false, { label: 'Wrap long lines', section: 'Diff' }),
  diffLayout: choice('unified', [{ value: 'unified', label: 'Unified' }, { value: 'split', label: 'Side by side' }],
    { label: 'Diff layout', section: 'Diff', keywords: 'split side-by-side', description: 'Also switchable above each diff. Changed words are highlighted in both.' }),
  syntaxHighlighting: bool(true, { label: 'Syntax highlighting', section: 'Diff' }),
  diffTool: text('', { label: 'External diff tool', section: 'Diff', placeholder: 'git\'s diff.tool', keywords: 'difftool meld beyond compare kdiff3 vscode', description: 'A tool name git knows (git difftool --tool-help), or one you configured with difftool.<name>.cmd. Empty: git\'s diff.tool.' }),
  mergeTool: text('', { label: 'External merge tool', section: 'Diff', placeholder: 'git\'s merge.tool', keywords: 'mergetool meld kdiff3 p4merge vscode', description: 'Offered in the conflict view. Empty: git\'s merge.tool.' }),
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
    description: 'Commit messages, explanations and conflict help. Nothing is sent anywhere until you use one, and GitGoose asks first.',
  }),
  aiAgent: choice('claude', [
    { value: 'claude', label: 'Claude' },
    { value: 'codex', label: 'Codex' },
    { value: 'gemini', label: 'Gemini CLI' },
    { value: 'custom', label: 'Custom command' },
  ], { label: 'Agent', section: 'AI', description: 'Started on first use and kept running until GitGoose quits. It uses its own login.' }),
  aiAgentCommand: text('', {
    label: 'Custom agent command', section: 'AI', placeholder: 'my-agent --acp',
    description: 'Used when Agent is "Custom command". It must speak the Agent Client Protocol on stdin/stdout.',
  }),
  /** The API key mode's default model. Edited by the model picker in Settings → AI, not a row of its own. */
  anthropicModel: internal('claude-opus-5-5'),
  /** Each agent's default model, by its command line (targetKey); none: the agent's own default. */
  aiAgentModel: internal<Record<string, string>>({}),
  /** The target picked in each AI area (Recompose, Review, …); an area with none uses the default. */
  aiAreaTargets: internal<Partial<Record<AiArea, AiTarget>>>({}),
  /**
   * The models each agent offered in its last session, by targetKey. ACP lists models only in a
   * session's config options, so this is how a picker can show them before anything is started.
   */
  aiAgentModels: internal<Record<string, AiModelList & { at: number }>>({}),
  anthropicMaxTokens: num(8192, 1024, 64000, 1024, {
    label: 'Longest answer (API key only)', section: 'AI', unit: 'tokens', keywords: 'max_tokens length limit',
    description: 'The most one answer may use. Long reviews and walkthroughs need room; a lower limit costs less.',
  }),
  /** Providers the user agreed to send content to, e.g. "agent:npx -y …" or "anthropic". */
  reviewProfile: choice('chill', [{ value: 'quiet', label: 'Quiet: only real problems' }, { value: 'chill', label: 'Chill: no nits or style' }, { value: 'assertive', label: 'Assertive: everything, nits too' }],
    { label: 'Review style', section: 'AI', keywords: 'code review findings nits coderabbit', description: 'How much AI review says. Findings are always checked against the diff before they are shown.' }),
  reviewLinter: text('', {
    label: 'Extra linter for reviews', section: 'AI', placeholder: 'npx stylelint --formatter unix {files}', keywords: 'lint eslint ruff shellcheck',
    description: 'Runs on the changed files during an AI review, besides the linters GitGoose finds in the repository (ESLint, Ruff, ShellCheck). {files} is replaced by the files; output as path:line:col: message. Asked for once per repository.',
  }),
  aiConsent: internal([] as string[]),
  /** The user's own pre-push checks, per repository path (besides those in .coderabbit.yaml). */
  pushChecks: internal<Record<string, PushCheck[]>>({}),
  /** Linter commands the user allowed (true) or refused (false), keyed "<repo path>\n<command>". */
  linterDecisions: internal<Record<string, boolean>>({}),

  // ---------------------------------------------------------------- Accounts
  githubHttps: bool(false, {
    label: 'Use your GitHub sign-in for HTTPS push and fetch', section: 'Accounts', keywords: 'token password credential',
    description: 'Answers GitHub\'s password prompt with your sign-in (needs repository access, asked for once). Your credential helpers are skipped for github.com while this is on.',
  }),

  // ---------------------------------------------------------------- Startup
  reopenTabs: bool(true, { label: 'Reopen last session’s tabs', section: 'Startup' }),
  checkForUpdates: bool(true, { label: 'Check for updates', section: 'Startup', description: 'Installed releases only; local builds update with pnpm install:local.' }),
  openDevRepo: bool(true, { label: 'Open the development repository', section: 'Startup', description: 'Development builds only (pnpm dev): opens .fixtures/dev-repo when no other tab is open. Build it with pnpm dev:repo.' }),

  // ---------------------------------------------------------------- Keyboard
  keybindings: { kind: 'keybindings' as const, default: {} as Record<string, string>, label: 'Shortcuts', section: 'Keyboard' as const, description: 'Click a shortcut, then press the new keys. Esc cancels; Backspace restores the default.' },

  // ---------------------------------------------------------------- app state
  settingsVersion: internal(4),
  recentRepos: internal<string[]>([]),
  openRepos: internal<string[]>([]),
  /**
   * AI conversations, per repository path, most recently used first (kept to 100): Ask threads
   * about lines, the AI panel's, and the ones under reviews, walkthroughs and the rest.
   */
  aiThreads: internal<Record<string, AiThread[]>>({}),
  /** Review learnings per repository path ("do not flag X"), from dismissed findings. */
  reviewLearnings: internal<Record<string, ReviewLearning[]>>({}),
  /** The sidebar's open sections and gear options, per repository path (see SidebarPrefs). */
  sidebar: internal<Record<string, SidebarPrefs>>({}),
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
  if (version < 3) {
    // v2 had a "compact rows" switch; it is now one of the graph layouts.
    if (s.compactRows === true && s.graphStyle === undefined) s.graphStyle = 'compact'
    delete s.compactRows
  }
  if (version < 4) {
    // v3 kept Ask's question threads on their own; they are AI threads with an ask anchor now.
    const old = s.askThreads
    if (old && typeof old === 'object' && !Array.isArray(old) && s.aiThreads === undefined) {
      s.aiThreads = Object.fromEntries(Object.entries(old as Record<string, unknown>).map(([path, list]) => [
        path,
        (Array.isArray(list) ? list : []).flatMap((t) => {
          try {
            return [askToThread(t)]
          } catch {
            return []
          }
        }),
      ]))
    }
    delete s.askThreads
  }
  s.settingsVersion = 4
  const out = defaultSettings() as Record<string, unknown>
  for (const k of Object.keys(SETTINGS)) if (k in s) out[k] = validateSetting(k as SettingKey, s[k])
  return out as Settings
}
