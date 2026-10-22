import type { AiArea, AiTask } from './ai'

/**
 * The words of every AI prompt, as data, so the user can read and change them.
 *
 * A prompt is four parts, sent in this order:
 *   system        who the model is (the API takes it separately; an agent gets it on top)
 *   instructions  what to do and how to say it: editable, in Settings → AI and in each area
 *   format        how to answer, when GitGoose parses the answer (JSON shapes, "the message
 *                 only"): shown, never editable, because the checker that reads the answer
 *                 (verifyFindings, repairPlan, …) depends on exactly these words
 *   context       the diff, the commits, the code around it: shown, built fresh for each request
 *
 * Instructions are templates: `{name}` is replaced by the request's value (see `vars`); an
 * unknown name stays as typed, so a stray brace in an edit never breaks a request.
 *
 * The built-in instructions keep their first lines word for word: e2e/fake-agent.mjs (and
 * the tests behind it) tell requests apart by them.
 */

/** Which prompt: one per AI task, plus `chat`, the opening of a conversation in the AI panel. */
export type PromptKind = AiTask['kind'] | 'chat'

/** What the user may change. Blank `system` or `instructions` means the default's. */
export interface PromptText {
  system: string
  instructions: string
}

export interface PromptDefault extends PromptText {
  label: string
  /** Fixed: what GitGoose parses the answer with. '' when the answer is free text. */
  format: string
  /** Template names in `instructions`, and what each becomes. */
  vars: Record<string, string>
}

/** What every prompt says about tools. A request, not a guarantee: acp.ts enforces the rules. */
export const NO_TOOLS = 'Answer from the text below. Do not run commands or edit files.'

const JSON_ONLY = 'Answer with JSON only, no prose and no code fence, in exactly this shape:'

export const DEFAULT_PROMPTS: Record<PromptKind, PromptDefault> = {
  'commit-message': {
    label: 'Commit message (Write)',
    system: 'You write git commit messages.',
    instructions: [
      'Write a git commit message for the staged changes below.',
      'First line: a summary in the imperative mood, at most 72 characters. If the recent subjects below follow a convention (like "feat:" or "fix(scope):"), follow it too.',
      'Then, only if the reason for the change is not obvious from the summary, a blank line and a short body wrapped at 72 characters.',
      NO_TOOLS,
    ].join('\n'),
    format: 'Reply with the commit message only: no code fences, no commentary.',
    vars: {},
  },
  'explain-commit': {
    label: 'Explain a commit',
    system: 'You explain code changes to a teammate.',
    instructions: [
      'Explain what this commit does and why, for a teammate reviewing it.',
      'Three to six sentences of plain text, then one line starting "Watch out:" if anything looks risky. No headings, no lists unless the commit is a list of unrelated changes.',
      NO_TOOLS,
    ].join('\n'),
    format: '',
    vars: {},
  },
  'explain-error': {
    label: 'Explain an error',
    system: 'You help people use git.',
    instructions: [
      'A git operation in a desktop git client failed. In two to five sentences of plain words, say what went wrong and the most likely fix.',
      'If a git command would help, give it on its own line. Do not suggest anything that loses work without saying so.',
      NO_TOOLS,
    ].join('\n'),
    format: '',
    vars: {},
  },
  recompose: {
    label: 'Recompose',
    system: 'You organise code changes into clear git commits.',
    instructions: [
      'Reorganise {commits} into a clean series of commits a reviewer can follow: each commit one logical change, in an order where each builds on the ones before (for example: refactors first, then the feature, then tests and docs).',
      'Write each message the way the original commits are written (same conventions, such as "feat:" prefixes): a summary line under 72 characters, then a blank line and a short body only when the reason is not obvious.',
      NO_TOOLS,
    ].join('\n'),
    format: [
      'The changes are cut into numbered pieces below. Assign every piece to exactly one commit; a piece cannot be split. Pieces of the same file may go to different commits.',
      `${JSON_ONLY.replace(':', ', commits oldest first:')}`,
      '{"commits": [{"message": "summary\\n\\noptional body", "units": ["U1", "U4"]}]}',
    ].join('\n'),
    vars: { commits: '"this commit" or "these 3 commits"' },
  },
  review: {
    label: 'Review',
    system: 'You are a careful senior engineer reviewing a code change.',
    instructions: [
      'Review this change ({label}).',
      '{profile}',
      NO_TOOLS,
    ].join('\n'),
    format: [
      'Each finding must point at lines that exist after the change: use the line numbers shown at the left of the diff (lines marked + are new; lines marked - are gone and have no number). Only comment on the files and lines shown.',
      'For a local fix, give "suggestion": the exact replacement text for lines startLine..endLine (complete lines, no diff markers). Leave it out when the fix is not local.',
      'Severity: critical (breaks things or leaks data), major (a real bug or risk), minor (worth fixing), nit (taste).',
      JSON_ONLY,
      '{"summary": "two or three sentences on what the change does and its overall quality", "findings": [{"path": "src/a.ts", "startLine": 12, "endLine": 14, "type": "bug|security|performance|maintainability|style|docs|tests", "severity": "critical|major|minor|nit", "title": "short", "message": "what is wrong and why, in plain words", "suggestion": "optional replacement lines"}]}',
    ].join('\n'),
    vars: { label: 'what is reviewed, e.g. "Staged changes"', profile: 'what the review style (Settings → AI) asks for' },
  },
  'fix-finding': {
    label: 'Fix a review finding',
    system: 'You fix code review findings with the smallest correct change.',
    instructions: [
      'Fix this code review finding.',
      'Change only what the fix needs, keep the style of the file, and do not touch unrelated code.',
    ].join('\n'),
    format: [
      'If you can edit files: write the whole fixed file back with your file-writing tool, then reply with one sentence on what you changed. Edit only this file. Do not run commands.',
      'If you cannot edit files: reply with one sentence on what you changed, then the whole fixed file in one fenced code block.',
    ].join('\n'),
    vars: {},
  },
  walkthrough: {
    label: 'Walkthrough',
    system: 'You explain code changes so a reviewer understands them quickly.',
    instructions: [
      'Write a walkthrough of this change ({label}) for the person about to review it.',
      'Groups gather files by purpose (a feature, a refactor, its tests). Give a one-line summary for every piece that is not just imports or formatting.',
      'Add a sequence only when the change adds or alters a flow between components (calls, requests, events); keep it under 8 participants and 20 messages. Otherwise "sequence": null.',
      NO_TOOLS,
    ].join('\n'),
    format: [
      'The change is cut into pieces [H1], [H2], … already in reading order (contracts, implementation, tests, config, docs).',
      JSON_ONLY,
      '{"summary": "what the change does and why, 3-6 sentences", "effort": 1-5 (1 trivial, 5 needs a long careful review), "effortWhy": "one short reason", "groups": [{"title": "short", "description": "one or two sentences", "files": ["paths from the change"]}], "hunks": {"H1": "one line on what this piece does"}, "sequence": null or {"participants": ["A", "B"], "messages": [{"from": "A", "to": "B", "label": "call or event"}]}}',
    ].join('\n'),
    vars: { label: 'what is explained, e.g. "Staged changes"' },
  },
  'assess-impact': {
    label: 'Assess impact',
    system: 'You assess the blast radius of code changes.',
    instructions: [
      'This change ({label}) touches the definitions listed below. Their uses outside the change are numbered C1, C2, ….',
      'Say which of those uses could break or behave differently because of the change, and why. Leave out uses that are fine.',
      NO_TOOLS,
    ].join('\n'),
    format: [
      'Cite only the numbered uses; do not invent others.',
      JSON_ONLY,
      '{"summary": "one or two sentences on the overall risk", "risks": [{"id": "C3", "why": "what could go wrong there"}]}',
    ].join('\n'),
    vars: { label: 'what changed, e.g. "Staged changes"' },
  },
  'push-checks': {
    label: 'Pre-push checks',
    system: "You check code changes against a team's rules before they are pushed.",
    instructions: [
      'Judge whether this push ({label}) follows each rule below.',
      'Judge only what this push changes, not the rest of the codebase. A rule about something the push does not touch passes.',
      NO_TOOLS,
    ].join('\n'),
    format: [
      'For each rule answer "pass" (the push follows it), "fail" (the push breaks it) or "inconclusive" (what is shown is not enough to tell).',
      'For a failure, give the lines that show it as evidence, using the line numbers at the left of the diff. A rule about commit messages needs no evidence lines.',
      JSON_ONLY,
      '{"results": [{"id": "C1", "verdict": "pass|fail|inconclusive", "reason": "one or two plain sentences", "evidence": [{"path": "src/a.ts", "line": 12}]}]}',
    ].join('\n'),
    vars: { label: 'what is pushed, e.g. "main → origin/main"' },
  },
  ask: {
    label: 'Ask about lines',
    system: 'You explain code to a teammate, plainly and precisely.',
    instructions: [
      'Answer the question about the selected lines below. Use the context given: the enclosing definition, the definitions of names the lines use, and their history. Say so when the context does not settle something, rather than guessing.',
      'Plain text, short paragraphs; quote code in backticks. No headings.',
      NO_TOOLS,
    ].join('\n'),
    format: '',
    vars: {},
  },
  'resolve-conflict': {
    label: 'Resolve a conflict',
    system: 'You resolve git merge conflicts.',
    instructions: [
      'Resolve the merge conflict in the file below.',
      'Combine both sides so that the intent of each change survives (when they truly cannot both hold, prefer the one that keeps the code working, and say so).',
      'Then reply with one or two sentences on what you chose.',
    ].join('\n'),
    format: 'Read the file and write the whole resolved file back with your file-writing tool. Remove every conflict marker. Edit only this file. Do not run commands.',
    vars: {},
  },
  chat: {
    label: 'AI panel chat',
    system: 'You help people understand and change the code in their git repository.',
    instructions: [
      'You are helping someone with their git repository, in GitGoose (a desktop git client).',
      'You may read files in the repository; ask before anything else. Do not change files or run commands unless the user asks.',
    ].join('\n'),
    // The conversation's own format (Markdown, artifact blocks) is added after, per anchor.
    format: '',
    vars: {},
  },
}

export const PROMPT_KINDS = Object.keys(DEFAULT_PROMPTS) as PromptKind[]

/** `{name}` → vars[name]; names not in vars stay as they are. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) => (Object.hasOwn(vars, name) ? vars[name]! : all))
}

/** The prompt kinds an area's panel edits (the Review area also asks for fixes). */
export function promptKindsOf(area: AiArea): PromptKind[] {
  switch (area) {
    case 'commit': return ['commit-message']
    case 'explain': return ['explain-commit']
    case 'error': return ['explain-error']
    case 'conflict': return ['resolve-conflict']
    case 'review': return ['review', 'fix-finding']
    case 'impact': return ['assess-impact']
    case 'chat': return ['chat']
    case 'recompose': case 'walkthrough': case 'ask': case 'push-checks': return [area]
  }
}

/** Where the words in use came from. */
export type PromptSource = 'area' | 'settings' | 'built-in'

interface PromptSettings {
  aiPrompts: Partial<Record<PromptKind, PromptText>>
  aiPromptEdits: Partial<Record<PromptKind, PromptText>>
}

/**
 * The words a request of `kind` uses: the area's edit, else Settings → AI's, else the built-in
 * ones, part by part (an edit that only changed the instructions keeps the default system).
 */
export function effectivePrompt(kind: PromptKind, s: PromptSettings, opts: { area?: boolean } = { area: true }): PromptText & { source: PromptSource } {
  const def = DEFAULT_PROMPTS[kind]
  const settings = s.aiPrompts[kind]
  const area = opts.area === false ? undefined : s.aiPromptEdits[kind]
  const pick = (k: keyof PromptText) => area?.[k]?.trim() ? area[k] : settings?.[k]?.trim() ? settings[k] : def[k]
  const source: PromptSource = area && (area.system.trim() || area.instructions.trim()) ? 'area' : settings && (settings.system.trim() || settings.instructions.trim()) ? 'settings' : 'built-in'
  return { system: pick('system'), instructions: pick('instructions'), source }
}

/**
 * The words a request sends, with an area's draft that may not be saved yet: `draft` undefined
 * (no draft: the saved settings decide), null (the draft goes back to the default), or the words
 * on screen. Blank parts fall through exactly as effectivePrompt's do, so the request sends
 * what the panel previewed.
 */
export function requestWords(kind: PromptKind, s: PromptSettings, draft?: PromptText | null): PromptText {
  const { [kind]: _saved, ...others } = s.aiPromptEdits
  const edits = draft === undefined ? s.aiPromptEdits : draft === null ? others : { ...others, [kind]: draft }
  const { system, instructions } = effectivePrompt(kind, { aiPrompts: s.aiPrompts, aiPromptEdits: edits })
  return { system, instructions }
}

/** The prompt a conversation about `anchor` opens with, when it has words of its own (the AI panel's, Ask's). */
export function openingPromptKind(anchor: { kind: string }): PromptKind | undefined {
  return anchor.kind === 'free' ? 'chat' : anchor.kind === 'ask' ? 'ask' : undefined
}

/** The parts of a built prompt, in the order they are sent (what a Prompt panel shows). */
export interface PromptParts {
  kind: PromptKind
  system: string
  /** The template in use, before `{name}`s are filled (what the user edits). */
  template: string
  /** The instructions as they will be sent. */
  instructions: string
  format: string
  context: string
  /** Shown with the context: what is added only when the request is really sent (linters run then). */
  note?: string
}

/** The user message these parts make (the system prompt goes separately, or on top for agents). */
export function joinPrompt(p: Pick<PromptParts, 'instructions' | 'format' | 'context'>): string {
  const head = [p.instructions.trim(), p.format].filter(Boolean).join('\n')
  return [head, p.context].filter(Boolean).join('\n\n')
}
