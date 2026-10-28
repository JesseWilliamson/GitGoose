import { spawn, type ChildProcess } from 'node:child_process'
import type { CommandRecord } from '@gitgoose/shared'

/**
 * Every git invocation goes through here. The rules for running git live in this file:
 * - force machine-stable output (no colour, no pager, no path quoting, C locale)
 * - never let git open a terminal prompt or an editor (we provide askpass and messages)
 * - read-only commands skip optional locks so a background refresh never blocks the user's own git
 * - paths given after `--` are literal (GIT_LITERAL_PATHSPECS), never glob patterns
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
  /** Run git on the host through flatpak-spawn. Defaults to whether we are in a sandbox. */
  hostSpawn?: boolean
}

/**
 * Are we running inside a flatpak sandbox? Flatpak sets FLATPAK_ID for the app it starts.
 *
 * We ship an AppImage on Linux and no flatpak, so this is false in every artifact we
 * build today. It stays because running the user's own git, with their hooks and credential
 * helpers, is the hard part of any future flatpak.
 */
export function inFlatpakSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.FLATPAK_ID
}

/**
 * Rewrite a git invocation to run on the host instead of inside the sandbox.
 *
 * flatpak-spawn asks the Flatpak portal to start a process outside the sandbox. It does not
 * inherit our environment or our working directory, so both are passed explicitly: only the
 * variables GitRunner sets go across, never the whole sandbox environment, whose paths mean
 * nothing on the other side.
 */
export function flatpakCommandLine(
  gitPath: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): { command: string; args: string[] } {
  return {
    command: 'flatpak-spawn',
    args: [
      '--host',
      `--directory=${cwd}`,
      ...Object.entries(env).map(([k, v]) => `--env=${k}=${v}`),
      gitPath,
      ...args,
    ],
  }
}

/** How many commands the log keeps (oldest dropped first). */
const LOG_SIZE = 500
const STDERR_KEEP = 4000

/** "https://user:token@host" → "https://***@host": the log is shown on screen and copied. */
export function maskCredentials(arg: string): string {
  return arg.replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@')
}

export class GitRunner {
  readonly cwd: string
  gitPath: string
  env: Record<string, string>
  /** Every process this runner started, oldest first (the command log). */
  readonly history: CommandRecord[] = []
  private nextId = 1
  private readonly hostSpawn: boolean

  constructor(opts: RunnerOptions) {
    this.cwd = opts.cwd
    this.gitPath = opts.gitPath ?? 'git'
    this.env = opts.env ?? {}
    this.hostSpawn = opts.hostSpawn ?? inFlatpakSandbox()
  }

  private buildArgs(args: string[], readOnly: boolean | undefined): string[] {
    return [...(readOnly ? ['--no-optional-locks'] : []), ...STABLE_CONFIG, ...args]
  }

  /** The variables we set for git, without the rest of the environment. */
  private gitEnv(args: string[], extra?: Record<string, string>): Record<string, string> {
    // File names are data, not patterns: without this, discarding "a[1].txt" also matches
    // "a1.txt". It applies only to commands that pass paths after `--`; setting it globally
    // breaks git internals (`stash push -u` then stops removing untracked files).
    // A caller that wants pathspec magic (path search) passes GIT_LITERAL_PATHSPECS=0.
    const dashdash = args.indexOf('--')
    const literal: Record<string, string> =
      dashdash >= 0 && dashdash < args.length - 1 ? { GIT_LITERAL_PATHSPECS: '1' } : {}
    return {
      LC_ALL: 'C',
      LANG: 'C',
      GIT_TERMINAL_PROMPT: '0',
      // Merge/rebase --continue would otherwise open an editor and hang.
      GIT_EDITOR: 'true',
      GIT_SEQUENCE_EDITOR: 'true',
      GIT_MERGE_AUTOEDIT: 'no',
      ...literal,
      ...this.env,
      ...extra,
    }
  }

  private buildEnv(args: string[], extra?: Record<string, string>): NodeJS.ProcessEnv {
    return { ...process.env, ...this.gitEnv(args, extra) }
  }

  /** Spawn git and return the process, for streaming output (see LogStream, CatFile). */
  spawn(args: string[], opts: { readOnly?: boolean; env?: Record<string, string> } = {}): ChildProcess {
    const gitArgs = this.buildArgs(args, opts.readOnly)
    const line = this.hostSpawn
      ? flatpakCommandLine(this.gitPath, gitArgs, this.cwd, this.gitEnv(args, opts.env))
      : { command: this.gitPath, args: gitArgs }
    const child = spawn(line.command, line.args, {
      cwd: this.cwd,
      env: this.buildEnv(args, opts.env),
      windowsHide: true,
    })
    this.track(child, args, !!opts.readOnly)
    return child
  }

  /** Add a process to the command log; its record completes when it exits. */
  private track(child: ChildProcess, args: string[], readOnly: boolean): void {
    const rec: CommandRecord = { id: this.nextId++, args: args.map(maskCredentials), start: Date.now(), durationMs: null, code: null, stderr: '', readOnly }
    this.history.push(rec)
    if (this.history.length > LOG_SIZE) this.history.splice(0, this.history.length - LOG_SIZE)
    child.stderr?.on('data', (b: Buffer) => {
      rec.stderr = (rec.stderr + b.toString('utf8')).slice(-STDERR_KEEP)
    })
    child.on('close', (code) => {
      rec.durationMs = Date.now() - rec.start
      rec.code = code ?? -1
    })
    child.on('error', (e) => {
      rec.durationMs = Date.now() - rec.start
      rec.stderr = e.message
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
      // git may exit (a failing hook, a bad argument) before it reads its input; the write then
      // fails asynchronously (EPIPE on POSIX, EOF or ECONNRESET on Windows pipes), and with no
      // listener that is an unhandled error. The exit code and stderr already say what went
      // wrong. Anything else is a real failure; 'close' still follows the child's exit, so the
      // promise cannot stay pending.
      child.stdin!.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EPIPE' || e.code === 'EOF' || e.code === 'ECONNRESET') return
        reject(new GitError(`Could not write to git (${this.gitPath}): ${e.message}`, describe(args), null, '', ''))
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
