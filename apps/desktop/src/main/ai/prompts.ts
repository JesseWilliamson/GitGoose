import type { Repo } from '@gitgoose/git'
import { addedLines, carryOver, codeContextInfo, contextBudget, textKey, describeHunks, globToRegExp, hunkKey, numberedDiff, onlyChanged, renderCodeContext, reviewableLines, secretFindings, walkthroughHunks, type AddedLines, type ReviewableLines } from '@gitgoose/git'
import {
  DEFAULT_PROMPTS, joinPrompt, renderTemplate,
  type AiTask, type ArtifactKind, type ImpactResult, type LinterRun, type PromptKind, type PromptParts, type PromptText, type ReviewContextInfo, type ReviewFinding,
  type ReviewLearning, type ReviewProfile, type ThreadAnchor, type WalkthroughResult,
} from '@gitgoose/shared'
import { join } from 'node:path'

/**
 * The prompts. Each one embeds exactly the text the feature needs (a diff, an error), asks for a
 * short answer in plain text, and says which tools are off limits. That last part is a request,
 * not a guarantee: the guarantee is the permission modal and the file-access rules in acp.ts.
 *
 * The words (system, instructions, answer format) live in @gitgoose/shared's DEFAULT_PROMPTS,
 * so the user can read and edit them; this file builds the context and puts the parts together
 * (compose). Every case returns its parts too: the Prompt panel shows exactly what is sent.
 *
 * Git output here is read by a model, not parsed by us, so human-readable formats are fine.
 */

/** Diffs beyond this are cut: a commit message does not need the 40th file. */
export const MAX_DIFF_CHARS = 60_000

/** Generated files that would fill the budget and tell the model nothing. */
const NOISE = [':(exclude,glob)**/pnpm-lock.yaml', ':(exclude,glob)**/package-lock.json', ':(exclude,glob)**/yarn.lock', ':(exclude,glob)**/*.lock', ':(exclude,glob)**/*.min.js']

/** What each review profile asks for (the answer is filtered the same way afterwards). */
const PROFILE_ASK: Record<ReviewProfile, string> = {
  quiet: 'Report only real problems: bugs, security holes, data loss, serious performance issues (severity critical or major). If there are none, return no findings. Silence is a fine answer.',
  chill: 'Report bugs, risks and clear maintainability problems. Skip style preferences and nits.',
  assertive: 'Report everything worth a comment, nits included, but never invent problems to have something to say.',
}

export interface BuiltPrompt {
  system: string
  prompt: string
  /** What the prompt was made of (the Prompt panel shows these). */
  parts: PromptParts
  /** For resolve-conflict: the one file the agent may write (absolute). */
  writable?: string
  /** For recompose: the range and its units, to turn the answer into a proposal. */
  recompose?: RecomposeInfo
  /** For assess-impact: the impact found locally (the model may only cite its call sites). */
  impact?: ImpactResult
  /** For walkthrough: everything but the model's part. */
  walkthrough?: Omit<WalkthroughResult, 'summary' | 'effort' | 'effortWhy' | 'groups' | 'sequence'>
  /** For fix-finding: the file (relative) the proposal is for, and its text when asked. */
  fix?: { path: string; before: string }
  /** For push-checks: where evidence may point. */
  pushChecks?: { lines: ReviewableLines }
  /** For review: what the findings are checked against. */
  review?: {
    lines: ReviewableLines; texts: Map<string, string>; label: string; head: string; base?: string; skipped: string[]
    context: ReviewContextInfo
    /** Findings from tools, not the model: the secret scan and linters (see lint.ts). */
    local: ReviewFinding[]
    hunkKeys: string[]
    contextKey: string
    /** A re-review: what was carried over and what was sent. No model call when nothing changed. */
    incremental?: { open: ReviewFinding[]; addressed: ReviewFinding[]; sent: number; unchanged: number }
    skipModel?: boolean
  }
}

export type RecomposeInfo = Awaited<ReturnType<Repo['recomposeInfo']>>

/** More pieces than this is not a commit series a person would review anyway. */
export const MAX_RECOMPOSE_UNITS = 300

/** What the model sees of one unit: its id, file, size, and (budget permitting) the hunk. */
export function describeUnit(u: RecomposeInfo['units'][number], maxLines: number): string {
  const kind = /\nnew file mode/.test(u.header) ? ' (new file)' : /\ndeleted file mode/.test(u.header) ? ' (deleted)' : u.binary ? ' (binary)' : !u.body ? ' (mode change)' : ''
  const head = `[${u.id}] ${u.path}${kind} +${u.added} -${u.removed}`
  if (!u.body) return head
  const lines = u.body.split('\n')
  return [head, ...lines.slice(0, maxLines), ...(lines.length > maxLines ? [`… ${lines.length - maxLines} more lines`] : [])].join('\n')
}


export function truncate(text: string, max = MAX_DIFF_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[… ${text.length - max} more characters of diff left out]`
}

async function git(repo: Repo, args: string[], pathspecs = false): Promise<string> {
  // Pathspec magic (the excludes) needs GIT_LITERAL_PATHSPECS off; see GitRunner.buildEnv.
  const res = await repo.runner.run(args, { readOnly: true, env: pathspecs ? { GIT_LITERAL_PATHSPECS: '0' } : undefined })
  return res.stdout
}

/** What the caller knows that the repository does not: the learnings saved for it. */
export interface PromptContext {
  learnings?: ReviewLearning[]
  /** The words to use for a prompt (the user's edits); blank parts and no answer: the built-in ones. */
  words?: (kind: PromptKind) => PromptText | undefined
  /** The review's lint pass (main/ai/linters.ts): run what the user allowed on these files. */
  lint?: (paths: string[], texts: Map<string, string>, lines: AddedLines) => Promise<{ findings: ReviewFinding[]; runs: LinterRun[]; report: string[] }>
}

/**
 * One prompt from its parts: the words in use (filled in with `vars`), the fixed answer format,
 * and the context. Blank edited parts fall back to the built-in words.
 */
export function compose(kind: PromptKind, ctx: PromptContext, vars: Record<string, string>, context: string, note?: string): Pick<BuiltPrompt, 'system' | 'prompt' | 'parts'> {
  const def = DEFAULT_PROMPTS[kind]
  const words = ctx.words?.(kind)
  const system = words?.system.trim() ? words.system : def.system
  const template = words?.instructions.trim() ? words.instructions : def.instructions
  const parts: PromptParts = { kind, system, template, instructions: renderTemplate(template, vars), format: def.format, context, ...(note ? { note } : {}) }
  return { system, prompt: joinPrompt(parts), parts }
}

export async function buildPrompt(maybeRepo: Repo | null, task: AiTask, ctx: PromptContext = {}): Promise<BuiltPrompt> {
  if (task.kind === 'explain-error') return explainError(task, ctx)
  if (!maybeRepo) throw new Error('Open a repository first.')
  const repo = maybeRepo
  switch (task.kind) {
    case 'commit-message': {
      const diff = await git(repo, ['diff', '--cached', '--no-color', '--no-ext-diff', '-M', '--', '.', ...NOISE], true)
      if (!diff.trim()) throw new Error('Nothing is staged. Stage some changes first.')
      const recent = await git(repo, ['log', '-n', '12', '--format=%s']).catch(() => '')
      return compose('commit-message', ctx, {}, [
        'Recent commit subjects:',
        recent.trim() || '(none)',
        '',
        'Staged diff:',
        truncate(diff),
      ].join('\n'))
    }
    case 'explain-commit': {
      if (!/^[0-9a-f]{4,64}$/i.test(task.hash)) throw new Error('Not a commit hash')
      const show = await git(repo, ['show', '--no-color', '--no-ext-diff', '-M', '--stat', '--patch', '--format=fuller', task.hash, '--', '.', ...NOISE], true)
      return compose('explain-commit', ctx, {}, truncate(show))
    }
    case 'recompose': {
      const info = await repo.recomposeInfo(task.hashes)
      if (info.units.length > MAX_RECOMPOSE_UNITS) {
        throw new Error(`These commits change ${info.units.length} separate places, too many to recompose at once (the limit is ${MAX_RECOMPOSE_UNITS}). Select fewer commits.`)
      }
      // Show as much of each hunk as fits: halve the lines per hunk until the whole list fits.
      let maxLines = 60
      let units = info.units.map((u) => describeUnit(u, maxLines)).join('\n\n')
      while (units.length > MAX_DIFF_CHARS && maxLines > 2) {
        maxLines = Math.floor(maxLines / 2)
        units = info.units.map((u) => describeUnit(u, maxLines)).join('\n\n')
      }
      return {
        recompose: info,
        ...compose('recompose', ctx, { commits: info.list.length === 1 ? 'this commit' : `these ${info.list.length} commits` }, [
          'The original commits, oldest first:',
          ...info.messages.map((m) => `- ${m.subject}${m.body ? `\n  ${m.body.split('\n').join('\n  ')}` : ''}`),
          '',
          'The pieces:',
          units,
        ].join('\n')),
      }
    }
    case 'review': {
      const input = await repo.reviewInput(task.scope)
      if (!input.files.length) throw new Error('There is nothing to review in that change.')
      const allKeys = input.files.flatMap((f) => f.hunks.map((h) => hunkKey(f.path, h)))
      const allPaths = input.files.map((f) => f.path)
      const project = await repo.reviewContext(allPaths, input.head)
      const learnings = (ctx.learnings ?? []).filter((l) => !l.path || allPaths.some((p) => globToRegExp(l.path!).test(p)))
      const guidance = [
        ...(project.guidelines.length ? ['Project guidelines from the repository. Follow them where they apply (each covers its directory and below):',
          ...project.guidelines.map((g) => `--- ${g.path} (applies to ${g.scope ? `${g.scope}/` : 'every file'}) ---\n${g.text.trim()}`), ''] : []),
        ...(project.pathInstructions.length ? ['Path-specific review instructions:', ...project.pathInstructions.map((pi) => `- ${pi.path}: ${pi.instructions}`), ''] : []),
        ...(learnings.length ? ['Learnings: this team told earlier reviews these things are fine or preferred. Do not flag what they allow:',
          ...learnings.map((l) => `- ${l.text}${l.path ? ` (for ${l.path})` : ''}`), ''] : []),
      ]
      const contextKey = textKey(guidance.join('\n'))
      // A re-review sends only the hunks that changed, and carries the rest of the last review
      // over; unless the guidance changed (a new learning, an edited CLAUDE.md): then all of it.
      const previous = task.previous?.contextKey === contextKey ? task.previous : undefined
      const again = previous ? onlyChanged(input.files, new Set(previous.hunkKeys)) : null
      const carried = previous ? carryOver(previous.findings, (p) => input.texts.get(p) ?? null) : null
      const files = again ? again.files : input.files
      const incremental = again && carried ? { open: carried.open, addressed: carried.addressed, sent: allKeys.length - again.unchanged, unchanged: again.unchanged } : undefined
      // The tools' half: secrets on added lines and linter reports, on the same pieces the model sees.
      const lines = reviewableLines(files)
      const secrets = secretFindings(files)
      const linted = files.length && ctx.lint
        ? await ctx.lint(files.filter((f) => !f.binary && f.change !== 'deleted').map((f) => f.path), input.texts, addedLines(files))
        : { findings: [], runs: [], report: [] }
      const already = [
        ...(secrets.length ? ['The built-in secret scan already reported these (the values are redacted below); do not report them again:',
          ...secrets.map((f) => `- ${f.path}:${f.startLine} ${f.title}`), ''] : []),
        ...(linted.report.length ? ['Linters already reported these; do not repeat them, and do not comment on style the linters cover:', ...linted.report, ''] : []),
      ]
      // Three kinds of context, as CodeRabbit frames them: intent (why: the commit messages),
      // environment (what around the change: the code graph), standards (the guidance above).
      const commits = await repo.scopeCommits(input).catch(() => [])
      const intent = commits.length
        ? ['The commit messages, newest first (what the author meant to do; judge the change against them):',
          ...commits.map((c) => `- ${c.subject}${c.body ? `\n  ${truncate(c.body, 600).replace(/\n/g, '\n  ')}` : ''}`), '']
        : []
      const diff = numberedDiff(files, (p) => input.texts.get(p) ?? null, (p, t) => repo.definitionsOf(p, t))
      const code = await repo.codeContext({ ...input, files })
      const rendered = renderCodeContext(code, contextBudget(diff.length))
      const environment = rendered.text
        ? ['Around the change (from the code graph; not part of the change, there to judge it by). Findings may not point at these lines, but do report when the change breaks them: a call that no longer matches a changed signature, a removed definition still in use, a test that should have changed.',
          rendered.text, '']
        : []
      return {
        ...compose('review', ctx, { label: input.label, profile: PROFILE_ASK[task.profile] }, [
          ...guidance,
          ...already,
          ...intent,
          ...environment,
          ...(again ? [`This is a re-review: only the ${files.length === 1 ? 'piece' : 'pieces'} that changed since the last review ${files.length === 1 ? 'is' : 'are'} shown.`, ''] : []),
          'The change:',
          diff,
          ...(input.skipped.length ? [`(Not shown, over the size limit: ${input.skipped.join(', ')})`] : []),
        ].join('\n'), ctx.lint ? undefined : 'Linter findings are added here when the review is sent (the linters run then).'),
        review: {
          lines, texts: input.texts, label: input.label, head: input.head, base: input.base, skipped: input.skipped,
          context: {
            guidelines: project.guidelines.map((g) => g.path), pathInstructions: project.pathInstructions.map((pi) => pi.path), learnings: learnings.length,
            ...(linted.runs.length ? { linters: linted.runs } : {}),
            ...(commits.length ? { commits: commits.length } : {}),
            ...(rendered.text ? { code: codeContextInfo(code, rendered.truncated) } : {}),
          },
          // With their lines as they are, like the model's findings: a re-review finds them again by those.
          local: [...secrets, ...linted.findings].map((f) => ({ ...f, original: input.texts.get(f.path)?.split(/\r?\n/).slice(f.startLine - 1, f.endLine) })),
          hunkKeys: allKeys, contextKey, incremental, skipModel: !!again && !files.length,
        },
      }
    }
    case 'walkthrough': {
      const input = await repo.reviewInput(task.scope)
      if (!input.files.length) throw new Error('There is nothing to explain in that change.')
      const hunks = walkthroughHunks(input.files, (p) => input.texts.get(p) ?? null, (p, t) => repo.definitionsOf(p, t))
      const paths = input.files.map((f) => f.path)
      const history = await repo.relatedHistory(paths, input.base ?? 'HEAD').catch(() => [])
      // Who uses what changed, and what the new code calls: the flows a sequence diagram draws.
      const around = renderCodeContext(await repo.codeContext(input, { symbols: 12, callers: 4, used: 8 }), 8_000).text
      // Shrink each hunk until the list fits, as recompose does.
      let maxLines = 40
      let text = describeHunks(input.files, hunks, maxLines)
      while (text.length > MAX_DIFF_CHARS && maxLines > 3) {
        maxLines = Math.floor(maxLines / 2)
        text = describeHunks(input.files, hunks, maxLines)
      }
      return {
        walkthrough: { scope: task.scope, label: input.label, head: input.head, base: input.base, hunks, history, skipped: input.skipped },
        ...compose('walkthrough', ctx, { label: input.label }, [
          ...(history.length ? ['Recent commits that touched these files, newest first:', ...history.map((h) => `- ${h.subject}`), ''] : []),
          ...(around ? ['Around the change (from the code graph; not part of the change):', around, ''] : []),
          'The pieces:',
          text,
        ].join('\n')),
      }
    }
    case 'push-checks': {
      const out = await repo.outgoing(task.branch)
      if (!out.commits.length) throw new Error('There is nothing to push.')
      const input = await repo.reviewInput({ kind: 'outgoing', branch: task.branch })
      return {
        pushChecks: { lines: reviewableLines(input.files) },
        ...compose('push-checks', ctx, { label: input.label }, [
          'The rules:',
            ...task.checks.map((c, i) => `[C${i + 1}] ${c.name}: ${c.instructions.replace(/\s*\n\s*/g, ' ')}`),
          '',
          'The commits, newest first:',
          ...out.commits.map((c) => `- ${c.subject}${c.body ? `\n  ${truncate(c.body, 600).replace(/\n/g, '\n  ')}` : ''}`),
          '',
          numberedDiff(input.files, (p) => input.texts.get(p) ?? null, (p, t) => repo.definitionsOf(p, t)),
          ...(input.skipped.length ? [`(Not shown, over the size limit: ${input.skipped.join(', ')}. Say "inconclusive" for rules that depend on them.)`] : []),
        ].join('\n')),
      }
    }
    case 'assess-impact': {
      const impact = await repo.impact(task.scope)
      if (!impact.callers.length) throw new Error('No uses of the changed code were found outside the change: nothing to assess.')
      const input = await repo.reviewInput(task.scope)
      const changed = impact.symbols.map((s) => `- ${s.kind} ${s.name} (${s.path}:${s.line}) ${s.change}`).join('\n')
      return {
        impact,
        ...compose('assess-impact', ctx, { label: input.label }, [
          'Changed definitions:',
          changed,
          '',
          'Uses outside the change:',
          ...impact.callers.map((c) => `[${c.id}] ${c.path}:${c.line}${c.within ? ` in ${c.within}` : ''}${c.test ? ' (test)' : ''}: ${c.text}`),
          '',
          'The change:',
          truncate(numberedDiff(input.files, (p) => input.texts.get(p) ?? null, (p, t) => repo.definitionsOf(p, t)), 40_000),
        ].join('\n')),
      }
    }
    case 'ask': {
      if (task.path.includes('\0') || task.path.startsWith('/') || task.path.split(/[\\/]/).includes('..')) throw new Error('Bad path')
      const c = await repo.askContext(task.rev, task.path, task.startLine, task.endLine)
      const where = `${task.path}, lines ${task.startLine}-${task.endLine}${task.rev ? ` at commit ${task.rev.slice(0, 7)}` : ' (working tree)'}`
      return compose('ask', ctx, {}, [
          `Selected (${where}):`,
          '```',
          c.lines.join('\n'),
          '```',
          ...(c.within ? ['', `They are inside ${c.within.kind} ${c.within.name} (from line ${c.within.line}):`, '```', truncate(c.within.text, 12_000), '```'] : []),
          ...(c.used.length ? ['', 'Definitions of names they use:', ...c.used.map((u) => `${u.name}, ${u.path}:${u.line}:\n\`\`\`\n${u.preview.join('\n')}\n\`\`\``)] : []),
          ...(c.history.length ? ['', 'Commits that changed these lines, newest first:', ...c.history] : []),
          ...(c.blame.length ? ['', 'Who wrote them:', ...c.blame.map((b) => `- ${b.author} (${b.lines} line${b.lines === 1 ? '' : 's'}): ${b.summary}`)] : []),
          ...(task.earlier.length ? ['', 'The conversation so far:', ...task.earlier.map((m) => `${m.role === 'user' ? 'Question' : 'Answer'}: ${m.text}`)] : []),
          '',
          `Question: ${task.question}`,
        ].join('\n'))
    }
    case 'fix-finding': {
      const f = task.finding
      if (f.path.includes('\0') || f.path.startsWith('/') || f.path.split(/[\\/]/).includes('..')) throw new Error('Bad path')
      const file = join(repo.path, f.path)
      const content = await repo.workingText(f.path)
      if (content === null) throw new Error(`${f.path} is not in the working tree.`)
      if (content.length > 150_000) throw new Error(`${f.path} is too large to send for a fix.`)
      const issue = [
        `File: ${file}`,
        `Problem (${f.severity} ${f.type}) at lines ${f.startLine}-${f.endLine}: ${f.title}`,
        f.message,
        ...(f.suggestion ? ['', 'A suggested replacement for those lines:', f.suggestion] : []),
      ].join('\n')
      return {
        writable: file,
        fix: { path: f.path, before: content },
        ...compose('fix-finding', ctx, {}, [
          issue,
          '',
          'The file as it is now:',
          '```',
          content,
          '```',
        ].join('\n')),
      }
    }
    case 'resolve-conflict': {
      if (task.path.includes('\0') || task.path.startsWith('/') || task.path.split(/[\\/]/).includes('..')) throw new Error('Bad path')
      const file = join(repo.path, task.path)
      return { writable: file, ...compose('resolve-conflict', ctx, {}, `File: ${file}`) }
    }
  }
}

function explainError(task: Extract<AiTask, { kind: 'explain-error' }>, ctx: PromptContext): BuiltPrompt {
  return compose('explain-error', ctx, {}, [
    `What failed: ${task.title}`,
    '',
    "Git's output:",
    truncate(task.detail, 8_000),
  ].join('\n'))
}

/** Models sometimes wrap a commit message in a code fence anyway. */
export function cleanCommitMessage(text: string): string {
  const t = text.trim()
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t)
  return (fenced ? fenced[1]! : t).trim()
}

// ------------------------------------------------------------------ threads

/** Which artifacts a conversation about each anchor may send back (and the renderer may apply). */
export const ANCHOR_ARTIFACTS: Record<ThreadAnchor['kind'], ArtifactKind[]> = {
  review: ['findings', 'diagram'],
  changestack: ['findings', 'diagram'],
  recompose: ['plan'],
  walkthrough: ['walkthrough', 'diagram'],
  explain: ['diagram'],
  impact: ['diagram'],
  ask: ['diagram'],
  free: ['commit-message', 'diagram'],
  task: [],
}

const ARTIFACT_SHAPE: Record<ArtifactKind, string> = {
  findings: 'the whole review again (every finding you still stand by, not only the new ones), in the same JSON shape as the first answer: {"summary": "…", "findings": [{"path", "startLine", "endLine", "type", "severity", "title", "message", "suggestion"?}]}, with line numbers from the diff',
  plan: 'the whole plan again, in the same JSON shape as the first answer: {"commits": [{"message": "…", "units": ["U1"]}]}, oldest first, every piece in exactly one commit',
  walkthrough: 'the whole walkthrough again, in the same JSON shape as the first answer',
  'commit-message': '{"message": "summary line under 72 characters\n\noptional body"}',
  diagram: '{"participants": ["A", "B"], "messages": [{"from": "A", "to": "B", "label": "call or event"}]} (a sequence diagram, under 8 participants and 20 messages)',
}

const ARTIFACT_NOUN: Record<ArtifactKind, string> = {
  findings: 'revise the review',
  plan: 'revise the plan',
  walkthrough: 'revise the walkthrough',
  'commit-message': 'write a commit message the user can use',
  diagram: 'draw a diagram',
}

/**
 * The artifact protocol: how a conversation sends a structured result back. Each anchor states
 * it in its first message. GitGoose parses the tagged block, checks it with the same verifier as
 * the feature's first answer, and shows it as a card the user may apply; nothing changes by itself.
 */
export function artifactProtocol(anchor: ThreadAnchor, afterFeature: boolean): string {
  const kinds = ANCHOR_ARTIFACTS[anchor.kind]
  return [
    'This is a conversation: the user may ask follow-up questions.',
    afterFeature ? 'Your first answer keeps the format asked for above. After that, answer in prose.' : 'Answer in prose.',
    'Write prose as Markdown: short paragraphs, lists, `inline code` and fenced code blocks. No HTML.',
    ...kinds.map((k) => `When you ${ARTIFACT_NOUN[k]}, send it as one fenced code block tagged \`\`\`json:${k} containing ${ARTIFACT_SHAPE[k]}. GitGoose checks it and the user decides whether to apply it.`),
    ...(kinds.length ? ['Send such a block only when it is asked for or clearly needed; otherwise answer in prose.'] : []),
  ].join('\n')
}

/** What the conversation's feature knew: the start of a thread opened without the feature's own request, and of a replay. */
export async function anchorContext(repo: Repo, anchor: ThreadAnchor, ctx: PromptContext = {}): Promise<string> {
  switch (anchor.kind) {
    case 'free': {
      const head = (await git(repo, ['log', '-n', '1', '--format=%h %s', 'HEAD']).catch(() => '')).trim()
      const branch = (await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim()
      // The AI panel's words (prompt "chat"), then where we are.
      return compose('chat', ctx, {}, `Repository: ${repo.path.split(/[\\/]/).pop()}. HEAD: ${branch ? `${branch} at ` : 'detached at '}${head || '(no commits yet)'}.`).prompt
    }
    case 'review':
    case 'walkthrough':
    case 'changestack':
    case 'impact': {
      const input = await repo.reviewInput(anchor.scope)
      const diff = numberedDiff(input.files, (p) => input.texts.get(p) ?? null, (p, t) => repo.definitionsOf(p, t))
      const about = anchor.kind === 'review' ? 'a code review' : anchor.kind === 'walkthrough' ? 'a walkthrough' : anchor.kind === 'impact' ? 'what this change could affect' : 'a change stack'
      const parts = [`This conversation is about ${about} of a change (${input.label}). The change, with new line numbers at the left:`, truncate(diff)]
      if (anchor.kind === 'impact') {
        const impact = await repo.impact(anchor.scope)
        if (impact.callers.length) {
          parts.push('', 'Where the changed definitions are used elsewhere:', ...impact.callers.map((c) => `- ${c.path}:${c.line}${c.within ? ` in ${c.within}` : ''}${c.test ? ' (test)' : ''}: ${c.text}`))
        }
      }
      return parts.join('\n')
    }
    case 'recompose': {
      const info = await repo.recomposeInfo(anchor.hashes)
      return [
        `This conversation is about reorganising ${info.list.length === 1 ? 'a commit' : `${info.list.length} commits`} on ${info.branch} into a better series. The original commits, oldest first:`,
        ...info.messages.map((m) => `- ${m.subject}`),
        '',
        'The changes, cut into numbered pieces:',
        truncate(info.units.map((u) => describeUnit(u, 20)).join('\n\n')),
      ].join('\n')
    }
    case 'explain': {
      if (!/^[0-9a-f]{4,64}$/i.test(anchor.hash)) throw new Error('Not a commit hash')
      const show = await git(repo, ['show', '--no-color', '--no-ext-diff', '-M', '--stat', '--patch', '--format=fuller', anchor.hash, '--', '.', ...NOISE], true)
      return [`This conversation is about commit ${anchor.hash.slice(0, 7)}:`, truncate(show)].join('\n')
    }
    case 'ask': {
      const built = await buildPrompt(repo, { kind: 'ask', rev: anchor.rev === 'worktree' ? null : anchor.rev, path: anchor.path, startLine: anchor.lines[0], endLine: anchor.lines[1], question: '(see the conversation)', earlier: [] }, ctx)
      return built.prompt.slice(0, built.prompt.lastIndexOf('\nQuestion:'))
    }
    case 'task':
      return ''
  }
}

/** The first message of a thread that starts with the user's own words (not a feature's request). */
export function openingMessage(context: string, anchor: ThreadAnchor, text: string): string {
  return [context, '', artifactProtocol(anchor, false), '', "The user's message:", text].filter((l, i) => i > 0 || l).join('\n')
}

/** Marks each earlier exchange in a replay (the fake agent counts them). */
export const REPLAY_USER = '<<user>>'
export const REPLAY_AGENT = '<<assistant>>'

/**
 * A new session for a conversation that already happened (the agent restarted, the thread was
 * reopened later, and the agent cannot load sessions): the conversation so far as text, then
 * the new message. The first exchange carries the context, so it is all the agent needs.
 */
export function replayMessage(history: { user: string; agent: string }[], text: string): string {
  return [
    'This conversation was interrupted (the assistant restarted). Here it is so far, oldest first; carry on from where it ended.',
    '',
    ...history.flatMap((h) => [REPLAY_USER, h.user, REPLAY_AGENT, h.agent, '']),
    'The new message:',
    text,
  ].join('\n')
}

/** The task a thread's artifacts are checked against (its verifier needs what the feature saw). */
export function anchorTask(anchor: ThreadAnchor, profile: ReviewProfile): AiTask | null {
  switch (anchor.kind) {
    case 'review':
    case 'changestack': return { kind: 'review', scope: anchor.scope, profile }
    case 'walkthrough': return { kind: 'walkthrough', scope: anchor.scope }
    case 'recompose': return { kind: 'recompose', hashes: anchor.hashes }
    default: return null
  }
}

/** The thread a one-shot task becomes. */
export function anchorOf(task: AiTask): ThreadAnchor {
  switch (task.kind) {
    case 'review': return { kind: 'review', scope: task.scope }
    case 'walkthrough': return { kind: 'walkthrough', scope: task.scope }
    case 'assess-impact': return { kind: 'impact', scope: task.scope }
    case 'recompose': return { kind: 'recompose', hashes: task.hashes }
    case 'explain-commit': return { kind: 'explain', hash: task.hash }
    case 'ask': return { kind: 'ask', rev: task.rev ?? 'worktree', path: task.path, lines: [task.startLine, task.endLine], code: '' }
    default: return { kind: 'task', task: task.kind }
  }
}

/** How a feature's own request reads in its thread (one line; the view shows the result). */
export function featureLabel(task: AiTask, built: BuiltPrompt): string {
  switch (task.kind) {
    case 'review': return `Review: ${built.review?.label ?? 'the change'}`
    case 'walkthrough': return `Walkthrough: ${built.walkthrough?.label ?? 'the change'}`
    case 'assess-impact': return 'Assess which uses of the changed code are at risk'
    case 'recompose': return `Propose a better series for ${task.hashes.length === 1 ? 'this commit' : `these ${task.hashes.length} commits`}`
    case 'explain-commit': return `Explain commit ${task.hash.slice(0, 7)}`
    default: return task.kind
  }
}
