import { initRepo, tempDir } from '@gitgoose/fixtures'
import { chmodSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitRunner, flatpakCommandLine, inFlatpakSandbox } from './runner'

/**
 * A stand-in for flatpak-spawn: it accepts the arguments the real one does, applies them the way
 * the portal would (directory, environment), and runs the command on "the host" — here, the same
 * machine. If GitRunner builds the command line wrongly, git is handed the wrong arguments and
 * these tests fail.
 */
function fakeFlatpakSpawn(): string {
  const dir = tempDir('gitgoose-flatpak-')
  const script = join(dir, 'flatpak-spawn')
  writeFileSync(script, `#!/bin/sh
[ "$1" = "--host" ] || { echo "expected --host, got $1" >&2; exit 2; }
shift
env=''
while [ $# -gt 0 ]; do
  case "$1" in
    --directory=*) cd "\${1#--directory=}" || exit 2 ;;
    --env=*) env="$env \${1#--env=}" ;;
    *) break ;;
  esac
  shift
done
[ $# -gt 0 ] || { echo "no command given" >&2; exit 2; }
# Deliberately start from an empty environment: the real flatpak-spawn does not carry ours over.
exec env -i PATH="$PATH" HOME="$HOME" $env "$@"
`)
  chmodSync(script, 0o700)
  return dir
}

const savedPath = process.env.PATH
afterEach(() => {
  process.env.PATH = savedPath
})

describe('running git on the host from a flatpak sandbox', () => {
  it('detects the sandbox from FLATPAK_ID', () => {
    expect(inFlatpakSandbox({})).toBe(false)
    expect(inFlatpakSandbox({ FLATPAK_ID: 'dev.gitgoose.app' })).toBe(true)
  })

  it('passes the working directory and only the variables we set', () => {
    const line = flatpakCommandLine('git', ['status'], '/home/ada/work', { LC_ALL: 'C' })
    expect(line.command).toBe('flatpak-spawn')
    expect(line.args).toEqual(['--host', '--directory=/home/ada/work', '--env=LC_ALL=C', 'git', 'status'])
  })

  // The fake flatpak-spawn is a shell script: Windows cannot start it (and has no flatpak).
  it.skipIf(process.platform === 'win32')('runs real git through flatpak-spawn, in the repository and with our environment', async () => {
    const r = initRepo()
    r.commit('root')
    process.env.PATH = `${fakeFlatpakSpawn()}:${savedPath}`

    const runner = new GitRunner({ cwd: r.dir, hostSpawn: true })
    const log = await runner.run(['log', '--format=%s'], { readOnly: true })
    expect(log.stdout.trim()).toBe('root')

    // --directory, not the cwd of the flatpak-spawn process, is what puts git in the repository:
    // the fake starts git from an empty environment, as the portal does.
    const top = await runner.run(['rev-parse', '--show-toplevel'], { readOnly: true })
    // Both resolved: macOS keeps temp folders behind a symlink (/var -> /private/var).
    expect(realpathSync(top.stdout.trim())).toBe(realpathSync(r.dir))

    // Proof that the variables cross as --env arguments: from a directory that is not a
    // repository at all, git finds this one only through GIT_DIR.
    const elsewhere = new GitRunner({ cwd: tempDir('gitgoose-elsewhere-'), hostSpawn: true })
    const gitDir = await elsewhere.run(['rev-parse', '--git-dir'], {
      readOnly: true,
      env: { GIT_DIR: join(r.dir, '.git') },
    })
    expect(gitDir.stdout.trim()).toBe(join(r.dir, '.git'))

    // The command log records the git arguments, not the flatpak-spawn plumbing.
    expect(runner.history[0]?.args).toEqual(['log', '--format=%s'])
  })

  it('reports a missing flatpak-spawn as a git error rather than crashing', async () => {
    const r = initRepo()
    process.env.PATH = '/nonexistent'
    const runner = new GitRunner({ cwd: r.dir, hostSpawn: true })
    await expect(runner.run(['status'])).rejects.toThrow(/Could not run git/)
  })
})
