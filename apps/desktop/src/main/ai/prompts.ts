import type { Repo } from '@gitgoose/git'
import { addedLines, carryOver, codeContextInfo, contextBudget, textKey, describeHunks, globToRegExp, hunkKey, numberedDiff, onlyChanged, renderCodeContext, reviewableLines, secretFindings, walkthroughHunks, type AddedLines, type ReviewableLines } from '@gitgoose/git'
import type { AiTask, ArtifactKind, ImpactResult, LinterRun, ReviewContextInfo, ReviewFinding, ReviewLearning, ReviewProfile, ThreadAnchor, WalkthroughResult } from '@gitgoose/shared'
import { join } from 'node:path'

/**
 * The prompts. Each one embeds exactly the text the feature needs (a diff, an error), asks for a
 * short answer in plain text, and says which tools are off limits. That last part is a request,
 * not a guarantee: the guarantee is the permission modal and the file-access rules in acp.ts.
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

const NO_TOOLS = 'Answer from the text below. Do not run commands or edit files.'

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
  /** The review's lint pass (main/ai/linters.ts): run what the user allowed on these files. */
  lint?: (paths: string[], texts: Map<string, string>, lines: AddedLines) => Promise<{ findings: ReviewFinding[]; runs: LinterRun[]; report: string[] }>
}

export async function buildPrompt(maybeRepo: Repo | null, task: AiTask, ctx: PromptContext = {}): Promise<BuiltPrompt> {
  if (task.kind === 'explain-error') return explainError(task)
  if (!maybeRepo) throw new Error('Open a repository first.')
  const repo = maybeRepo
  switch (task.kind) {
    case 'commit-message': {
      const diff = await git(repo, ['diff', '--cached', '--no-color', '--no-ext-diff', '-M', '--', '.', ...NOISE], true)
      if (!diff.trim()) throw new Error('Nothing is staged. Stage some changes first.')
      const recent = await git(repo, ['log', '-n', '12', '--format=%s']).catch(() => '')
      return {
        system: 'You write git commit messages.',
        prompt: [
          'Write a git commit message for the staged changes below.',
          'First line: a summary in the imperative mood, at most 72 characters. If the recent subjects below follow a convention (like "feat:" or "fix(scope):"), follow it too.',
          'Then, only if the reason for the change is not obvious from the summary, a blank line and a short body wrapped at 72 characters.',
          'Reply with the commit message only: no code fences, no commentary.',
          NO_TOOLS,
          '',
          'Recent commit subjects:',
          recent.trim() || '(none)',
          '',
          'Staged diff:',
          truncate(diff),
        ].join('\n'),
      }
    }
    case 'explain-commit': {
      if (!/^[0-9a-f]{4,64}$/i.test(task.hash)) throw new Error('Not a commit hash')
      const show = await git(repo, ['show', '--no-color', '--no-ext-diff', '-M', '--stat', '--patch', '--format=fuller', task.hash, '--', '.', ...NOISE], true)
      return {
        system: 'You explain code changes to a teammate.',
        prompt: [
          'Explain what this commit does and why, for a teammate reviewing it.',
          'Three to six sentences of plain text, then one line starting "Watch out:" if anything looks risky. No headings, no lists unless the commit is a list of unrelated changes.',
          NO_TOOLS,
          '',
          truncate(show),
        ].join('\n'),
      }
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
        system: 'You organise code changes into clear git commits.',
        recompose: info,
        prompt: [
          `Reorganise ${info.list.length === 1 ? 'this commit' : `these ${info.list.length} commits`} into a clean series of commits a reviewer can follow: each commit one logical change, in an order where each builds on the ones before (for example: refactors first, then the feature, then tests and docs).`,
          'The changes are cut into numbered pieces below. Assign every piece to exactly one commit; a piece cannot be split. Pieces of the same file may go to different commits.',
          'Write each message the way the original commits are written (same conventions, such as "feat:" prefixes): a summary line under 72 characters, then a blank line and a short body only when the reason is not obvious.',
          'Answer with JSON only, no prose and no code fence, in exactly this shape, commits oldest first:',
          '{"commits": [{"message": "summary\\n\\noptional body", "units": ["U1", "U4"]}]}',
          NO_TOOLS,
          '',
          'The original commits, oldest first:',
          ...info.messages.map((m) => `- ${m.subject}${m.body ? `\n  ${m.body.split('\n').join('\n  ')}` : ''}`),
          '',
          'The pieces:',
          units,
        ].join('\n'),
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
        system: 'You are a careful senior engineer reviewing a code change.',
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
        prompt: [
          `Review this change (${input.label}).`,
          PROFILE_ASK[task.profile],
          'Each finding must point at lines that exist after the change: use the line numbers shown at the left of the diff (lines marked + are new; lines marked - are gone and have no number). Only comment on the files and lines shown.',
          'For a local fix, give "suggestion": the exact replacement text for lines startLine..endLine (complete lines, no diff markers). Leave it out when the fix is not local.',
          'Severity: critical (breaks things or leaks data), major (a real bug or risk), minor (worth fixing), nit (taste).',
          'Answer with JSON only, no prose and no code fence, in exactly this shape:',
          '{"summary": "two or three sentences on what the change does and its overall quality", "findings": [{"path": "src/a.ts", "startLine": 12, "endLine": 14, "type": "bug|security|performance|maintainability|style|docs|tests", "severity": "critical|major|minor|nit", "title": "short", "message": "what is wrong and why, in plain words", "suggestion": "optional replacement lines"}]}',
          NO_TOOLS,
          '',
          ...guidance,
          ...already,
          ...intent,
          ...environment,
          ...(again ? [`This is a re-review: only the ${files.length === 1 ? 'piece' : 'pieces'} that changed since the last review ${files.length === 1 ? 'is' : 'are'} shown.`, ''] : []),
          'The change:',
          diff,
          ...(input.skipped.length ? [`(Not shown, over the size limit: ${input.skipped.join(', ')})`] : []),
        ].join('\n'),
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
        system: 'You explain code changes so a reviewer understands them quickly.',
        walkthrough: { scope: task.scope, label: input.label, head: input.head, base: input.base, hunks, history, skipped: input.skipped },
        prompt: [
          `Write a walkthrough of this change (${input.label}) for the person about to review it.`,
          'The change is cut into pieces [H1], [H2], … already in reading order (contracts, implementation, tests, config, docs).',
          'Answer with JSON only, no prose and no code fence, in exactly this shape:',
          '{"summary": "what the change does and why, 3-6 sentences", "effort": 1-5 (1 trivial, 5 needs a long careful review), "effortWhy": "one short reason", "groups": [{"title": "short", "description": "one or two sentences", "files": ["paths from the change"]}], "hunks": {"H1": "one line on what this piece does"}, "sequence": null or {"participants": ["A", "B"], "messages": [{"from": "A", "to": "B", "label": "call or event"}]}}',
          'Groups gather files by purpose (a feature, a refactor, its tests). Give a one-line summary for every piece that is not just imports or formatting.',
          'Add a sequence only when the change adds or alters a flow between components (calls, requests, events); keep it under 8 participants and 20 messages. Otherwise "sequence": null.',
          NO_TOOLS,
          '',
          ...(history.length ? ['Recent commits that touched these files, newest first:', ...history.map((h) => `- ${h.subject}`), ''] : []),
          ...(around ? ['Around the change (from the code graph; not part of the change):', around, ''] : []),
          'The pieces:',
          text,
        ].join('\n'),
      }
    }
    case 'push-checks': {
      const out = await repo.outgoing(task.branch)
      if (!out.commits.length) throw new Error('There is nothing to push.')
      const input = await repo.reviewInput({ kind: 'outgoing', branch: task.branch })
      return {
        system: "You check code changes against a team's rules before they are pushed.",
        pushChecks: { lines: reviewableLines(input.files) },
        prompt: [
          `Judge whether this push (${input.label}) follows each rule below.`,
          'For each rule answer "pass" (the push follows it), "fail" (the push breaks it) or "inconclusive" (what is shown is not enough to tell). Judge only what this push changes, not the rest of the codebase. A rule about something the push does not touch passes.',
          'For a failure, give the lines that show it as evidence, using the line numbers at the left of the diff. A rule about commit messages needs no evidence lines.',
          'Answer with JSON only, no prose and no code fence, in exactly this shape:',
          '{"results": [{"id": "C1", "verdict": "pass|fail|inconclusive", "reason": "one or two plain sentences", "evidence": [{"path": "src/a.ts", "line": 12}]}]}',
          NO_TOOLS,
          '',
          'The rules:',
          ...task.checks.map((c, i) => `[C${i + 1}] ${c.name}: ${c.instructions.replace(/\s*\n\s*/g, ' ')}`),
          '',
          'The commits, newest first:',
          ...out.commits.map((c) => `- ${c.subject}${c.body ? `\n  ${truncate(c.body, 600).replace(/\n/g, '\n  ')}` : ''}`),
          '',
          numberedDiff(input.files, (p) => input.texts.get(p) ?? null, (p, t) => repo.definitionsOf(p, t)),
          ...(input.skipped.length ? [`(Not shown, over the size limit: ${input.skipped.join(', ')}. Say "inconclusive" for rules that depend on them.)`] : []),
        ].join('\n'),
      }
    }
    case 'assess-impact': {
      const impact = await repo.impact(task.scope)
      if (!impact.callers.length) throw new Error('No uses of the changed code were found outside the change: nothing to assess.')
      const input = await repo.reviewInput(task.scope)
      const changed = impact.symbols.map((s) => `- ${s.kind} ${s.name} (${s.path}:${s.line}) ${s.change}`).join('\n')
      return {
        system: 'You assess the blast radius of code changes.',
        impact,
        prompt: [
          `This change (${input.label}) touches the definitions listed below. Their uses outside the change are numbered C1, C2, ….`,
          'Say which of those uses could break or behave differently because of the change, and why. Cite only the numbered uses; do not invent others. Leave out uses that are fine.',
          'Answer with JSON only, no prose and no code fence, in exactly this shape:',
          '{"summary": "one or two sentences on the overall risk", "risks": [{"id": "C3", "why": "what could go wrong there"}]}',
          NO_TOOLS,
          '',
          'Changed definitions:',
          changed,
          '',
          'Uses outside the change:',
          ...impact.callers.map((c) => `[${c.id}] ${c.path}:${c.line}${c.within ? ` in ${c.within}` : ''}${c.test ? ' (test)' : ''}: ${c.text}`),
          '',
          'The change:',
          truncate(numberedDiff(input.files, (p) => input.texts.get(p) ?? null, (p, t) => repo.definitionsOf(p, t)), 40_000),
        ].join('\n'),
      }
    }
    case 'ask': {
      if (task.path.includes('\0') || task.path.startsWith('/') || task.path.split(/[\\/]/).includes('..')) throw new Error('Bad path')
      const c = await repo.askContext(task.rev, task.path, task.startLine, task.endLine)
      const where = `${task.path}, lines ${task.startLine}-${task.endLine}${task.rev ? ` at commit ${task.rev.slice(0, 7)}` : ' (working tree)'}`
      return {
        system: 'You explain code to a teammate, plainly and precisely.',
        prompt: [
          'Answer the question about the selected lines below. Use the context given: the enclosing definition, the definitions of names the lines use, and their history. Say so when the context does not settle something, rather than guessing.',
          'Plain text, short paragraphs; quote code in backticks. No headings.',
          NO_TOOLS,
          '',
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
        ].join('\n'),
      }
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
        system: 'You fix code review findings with the smallest correct change.',
        writable: file,
        fix: { path: f.path, before: content },
        prompt: [
          'Fix this code review finding.',
          issue,
          '',
          'Change only what the fix needs, keep the style of the file, and do not touch unrelated code.',
          'If you can edit files: write the whole fixed file back with your file-writing tool, then reply with one sentence on what you changed. Edit only this file. Do not run commands.',
          'If you cannot edit files: reply with one sentence on what you changed, then the whole fixed file in one fenced code block.',
          '',
          'The file as it is now:',
          '```',
          content,
          '```',
        ].join('\n'),
      }
    }
    case 'resolve-conflict': {
      if (task.path.includes('\0') || task.path.startsWith('/') || task.path.split(/[\\/]/).includes('..')) throw new Error('Bad path')
      const file = join(repo.path, task.path)
      return {
        system: 'You resolve git merge conflicts.',
        writable: file,
        prompt: [
          'Resolve the merge conflict in the file below.',
          `File: ${file}`,
          'Read it, combine both sides so that the intent of each change survives (when they truly cannot both hold, prefer the one that keeps the code working, and say so), and write the whole resolved file back with your file-writing tool.',
          'Remove every conflict marker. Edit only this file. Do not run commands.',
          'Then reply with one or two sentences on what you chose.',
        ].join('\n'),
      }
    }
  }
}

function explainError(task: Extract<AiTask, { kind: 'explain-error' }>): BuiltPrompt {
  return {
    system: 'You help people use git.',
    prompt: [
      'A git operation in a desktop git client failed. In two to five sentences of plain words, say what went wrong and the most likely fix.',
      'If a git command would help, give it on its own line. Do not suggest anything that loses work without saying so.',
      NO_TOOLS,
      '',
      `What failed: ${task.title}`,
      '',
      "Git's output:",
      truncate(task.detail, 8_000),
    ].join('\n'),
  }
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
export async function anchorContext(repo: Repo, anchor: ThreadAnchor): Promise<string> {
  switch (anchor.kind) {
    case 'free': {
      const head = (await git(repo, ['log', '-n', '1', '--format=%h %s', 'HEAD']).catch(() => '')).trim()
      const branch = (await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim()
      return [
        'You are helping someone with their git repository, in GitGoose (a desktop git client).',
        `Repository: ${repo.path.split(/[\\/]/).pop()}. HEAD: ${branch ? `${branch} at ` : 'detached at '}${head || '(no commits yet)'}.`,
        'You may read files in the repository; ask before anything else. Do not change files or run commands unless the user asks.',
      ].join('\n')
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
      const built = await buildPrompt(repo, { kind: 'ask', rev: anchor.rev === 'worktree' ? null : anchor.rev, path: anchor.path, startLine: anchor.lines[0], endLine: anchor.lines[1], question: '(see the conversation)', earlier: [] })
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
