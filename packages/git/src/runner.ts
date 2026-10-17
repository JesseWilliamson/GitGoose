import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Every git invocation goes through here. The rules from ADR-001 live in this file:
 * - force machine-stable output (no colour, no pager, no path quoting, C locale)
 * - never let git open a terminal prompt or an editor (we provide askpass and messages)
 * - read-only commands skip optional locks so a background refresh never blocks the user's own git
 */

export class GitError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly stdout: string,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface RunOptions {
  /** Written to git's stdin. */
  input?: string | Buffer
  /** Exit codes that count as success besides 0 (e.g. `diff --no-index` exits 1 on differences). */
  okCodes?: number[]
  /** Extra environment for this call only. */
  env?: Record<string, string>
  /** Called with each chunk of stderr, for progress reporting (fetch/push). */
  onStderr?: (text: string) => void
  /** Pass --no-optional-locks. Use for every command that only reads. */
  readOnly?: boolean
}

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

const STABLE_CONFIG = [
  '-c', 'core.quotepath=false',
  '-c', 'color.ui=never',
  '-c', 'core.pager=cat',
  '-c', 'log.showSignature=false',
]

export interface RunnerOptions {
  cwd: string
  gitPath?: string
  /** Base environment additions for every call (askpass variables, for example). */
  env?: Record<string, string>
}

export class GitRunner {
  readonly cwd: string
  gitPath: string
  env: Record<string, string>

  constructor(opts: RunnerOptions) {
    this.cwd = opts.cwd
    this.gitPath = opts.gitPath ?? 'git'
    this.env = opts.env ?? {}
  }

  private buildArgs(args: string[], readOnly: boolean | undefined): string[] {
    return [...(readOnly ? ['--no-optional-locks'] : []), ...STABLE_CONFIG, ...args]
  }

  private buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
    return {
      ...process.env,
      LC_ALL: 'C',
      LANG: 'C',
      GIT_TERMINAL_PROMPT: '0',
      // Merge/rebase --continue would otherwise open an editor and hang.
      GIT_EDITOR: 'true',
      GIT_SEQUENCE_EDITOR: 'true',
      GIT_MERGE_AUTOEDIT: 'no',
      ...this.env,
      ...extra,
    }
  }

  /** Spawn git and return the process, for streaming output (see LogStream, CatFile). */
  spawn(args: string[], opts: { readOnly?: boolean; env?: Record<string, string> } = {}): ChildProcess {
    return spawn(this.gitPath, this.buildArgs(args, opts.readOnly), {
      cwd: this.cwd,
      env: this.buildEnv(opts.env),
      windowsHide: true,
    })
  }

  /** Run git to completion and return its output as UTF-8 text. Throws GitError on failure. */
  async run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const result = await this.runBuffer(args, opts)
    return { stdout: result.stdout.toString('utf8'), stderr: result.stderr, code: result.code }
  }

  /** Like run, but stdout stays a Buffer (file contents may not be text). */
  runBuffer(args: string[], opts: RunOptions = {}): Promise<{ stdout: Buffer; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(args, { readOnly: opts.readOnly, env: opts.env })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout!.on('data', (b: Buffer) => out.push(b))
      child.stderr!.on('data', (b: Buffer) => {
        err.push(b)
        opts.onStderr?.(b.toString('utf8'))
      })
      child.on('error', (e) => {
        reject(new GitError(`Could not run git (${this.gitPath}): ${e.message}`, describe(args), null, '', ''))
      })
      child.on('close', (code) => {
        const stdout = Buffer.concat(out)
        const stderr = Buffer.concat(err).toString('utf8')
        const exit = code ?? -1
        if (exit === 0 || opts.okCodes?.includes(exit)) {
          resolve({ stdout, stderr, code: exit })
        } else {
          reject(new GitError(firstLine(stderr) || `git ${args[0]} failed with exit code ${exit}`,
            describe(args), exit, stderr, stdout.toString('utf8')))
        }
      })
      if (opts.input !== undefined) child.stdin!.end(opts.input)
      else child.stdin!.end()
    })
  }
}

function describe(args: string[]): string {
  return `git ${args.join(' ')}`
}

function firstLine(stderr: string): string {
  // Prefer git's "fatal:" or "error:" line over hint noise.
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0] ?? ''
}
