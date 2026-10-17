import type { Repo } from '@gitsquid/git'
import { describeHunks, globToRegExp, numberedDiff, reviewableLines, walkthroughHunks, type ReviewableLines } from '@gitsquid/git'
import type { AiTask, ReviewLearning, ReviewProfile, WalkthroughResult } from '@gitsquid/shared'
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
  /** For walkthrough: everything but the model's part. */
  walkthrough?: Omit<WalkthroughResult, 'summary' | 'effort' | 'effortWhy' | 'groups' | 'sequence'>
  /** For fix-finding: the file (relative) the proposal is for, and its text when asked. */
  fix?: { path: string; before: string }
  /** For review: what the findings are checked against. */
  review?: { lines: ReviewableLines; texts: Map<string, string>; label: string; head: string; base?: string; skipped: string[]; context: { guidelines: string[]; pathInstructions: string[]; learnings: number } }
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
      const paths = input.files.map((f) => f.path)
      const project = await repo.reviewContext(paths, input.head)
      const learnings = (ctx.learnings ?? []).filter((l) => !l.path || paths.some((p) => globToRegExp(l.path!).test(p)))
      const guidance = [
        ...(project.guidelines.length ? ['Project guidelines from the repository. Follow them where they apply (each covers its directory and below):',
          ...project.guidelines.map((g) => `--- ${g.path} (applies to ${g.scope ? `${g.scope}/` : 'every file'}) ---\n${g.text.trim()}`), ''] : []),
        ...(project.pathInstructions.length ? ['Path-specific review instructions:', ...project.pathInstructions.map((pi) => `- ${pi.path}: ${pi.instructions}`), ''] : []),
        ...(learnings.length ? ['Learnings: this team told earlier reviews these things are fine or preferred. Do not flag what they allow:',
          ...learnings.map((l) => `- ${l.text}${l.path ? ` (for ${l.path})` : ''}`), ''] : []),
      ]
      return {
        system: 'You are a careful senior engineer reviewing a code change.',
        review: {
          lines: reviewableLines(input.files), texts: input.texts, label: input.label, head: input.head, base: input.base, skipped: input.skipped,
          context: { guidelines: project.guidelines.map((g) => g.path), pathInstructions: project.pathInstructions.map((pi) => pi.path), learnings: learnings.length },
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
          numberedDiff(input.files, (p) => input.texts.get(p) ?? null),
          ...(input.skipped.length ? [`(Not shown, over the size limit: ${input.skipped.join(', ')})`] : []),
        ].join('\n'),
      }
    }
    case 'walkthrough': {
      const input = await repo.reviewInput(task.scope)
      if (!input.files.length) throw new Error('There is nothing to explain in that change.')
      const hunks = walkthroughHunks(input.files, (p) => input.texts.get(p) ?? null)
      const paths = input.files.map((f) => f.path)
      const history = await repo.relatedHistory(paths, input.base ?? 'HEAD').catch(() => [])
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
          'The pieces:',
          text,
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
