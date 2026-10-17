import type { Repo } from '@gitsquid/git'
import type { AiTask } from '@gitsquid/shared'
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

export interface BuiltPrompt {
  system: string
  prompt: string
  /** For resolve-conflict: the one file the agent may write (absolute). */
  writable?: string
  /** For recompose: the range and its units, to turn the answer into a proposal. */
  recompose?: RecomposeInfo
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

export async function buildPrompt(maybeRepo: Repo | null, task: AiTask): Promise<BuiltPrompt> {
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
