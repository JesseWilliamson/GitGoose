// `pnpm install:local`: build GitGoose from this working tree and install it like a release, so you
// can use your own changes day to day. Run it again to update. The build is stamped with the commit
// (see localBuildVersion), and the app leaves updating it to this script, not to GitHub releases.
//
//   --build-only   build the installer into apps/desktop/release/local/ and stop

import { localBuildVersion } from '@gitgoose/shared'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const desktop = resolve(import.meta.dirname, '../../../apps/desktop')
const out = join(desktop, 'release', 'local')
const buildOnly = process.argv.includes('--build-only')

function run(cmd: string, args: string[]): void {
  // Through the shell on Windows so `pnpm` finds pnpm.cmd; not for the installer, whose path may hold spaces.
  const shell = process.platform === 'win32' && cmd === 'pnpm'
  const r = spawnSync(cmd, args, { cwd: desktop, stdio: 'inherit', shell })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status ?? r.signal}`)
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: desktop, encoding: 'utf8' }).trim()
}

function build(version: string): void {
  const target: Record<string, string[]> = {
    // An app folder, not a dmg: it is copied straight into Applications. Ad-hoc signed, since Apple
    // silicon will not run an app whose signature electron-builder's edits have broken; hardened
    // runtime off because with an ad-hoc signature it rejects Electron's own frameworks.
    darwin: ['--mac', 'dir', '-c.mac.identity=-', '-c.mac.hardenedRuntime=false'],
    win32: ['--win', 'nsis'],
    linux: ['--linux', 'AppImage'],
  }
  const args = target[process.platform]
  if (!args) throw new Error(`No local install for ${process.platform}`)
  rmSync(out, { recursive: true, force: true })
  run('pnpm', ['build:dist'])
  run('pnpm', ['exec', 'electron-builder', ...args, '--publish', 'never', `-c.extraMetadata.version=${version}`, `-c.directories.output=${out}`])
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function installMac(): string {
  const built = readdirSync(out).map((d) => join(out, d, 'GitGoose.app')).find(existsSync)
  if (!built) throw new Error(`No GitGoose.app under ${out}`)
  const running = spawnSync('pgrep', ['-f', 'GitGoose.app/Contents/MacOS/GitGoose']).status === 0
  if (running) throw new Error('GitGoose is running. Quit it, then run this again.')
  const apps = writable('/Applications') ? '/Applications' : join(homedir(), 'Applications')
  const dest = join(apps, 'GitGoose.app')
  mkdirSync(apps, { recursive: true })
  rmSync(dest, { recursive: true, force: true })
  // ditto keeps the bundle's symlinks, permissions and signature intact; a plain copy can break them.
  execFileSync('ditto', [built, dest])
  return dest
}

function installWindows(): string {
  const setup = readdirSync(out).find((f) => f.endsWith('.exe'))
  if (!setup) throw new Error(`No installer in ${out}`)
  // Silent, for this user only: no UAC prompt, and it closes a running GitGoose before replacing it.
  run(join(out, setup), ['/S', '/currentuser'])
  return join(process.env.LOCALAPPDATA ?? '', 'Programs', 'GitGoose')
}

function installLinux(): string {
  const image = readdirSync(out).find((f) => f.endsWith('.AppImage'))
  if (!image) throw new Error(`No AppImage in ${out}`)
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const home = join(data, 'gitgoose')
  const app = join(home, 'GitGoose.AppImage')
  const icon = join(home, 'icon.png')
  mkdirSync(home, { recursive: true })
  // Replacing the file (not writing into it) is safe while the old version is running.
  rmSync(app, { force: true })
  copyFileSync(join(out, image), app)
  chmodSync(app, 0o755)
  copyFileSync(join(desktop, 'build', 'icon.png'), icon)

  const bin = join(homedir(), '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  rmSync(join(bin, 'gitgoose'), { force: true })
  symlinkSync(app, join(bin, 'gitgoose'))

  // The file name and StartupWMClass match desktopName in package.json, so the window groups
  // with this launcher.
  const applications = join(data, 'applications')
  mkdirSync(applications, { recursive: true })
  writeFileSync(
    join(applications, 'gitgoose.desktop'),
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=GitGoose',
      'Comment=A fast git client',
      `Exec="${app}" %U`,
      `Icon=${icon}`,
      'Terminal=false',
      'Categories=Development;RevisionControl;',
      'StartupWMClass=gitgoose',
      '',
    ].join('\n'),
  )
  return app
}

const base = (JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')) as { version: string }).version
const version = localBuildVersion(base, git('rev-parse', '--short', 'HEAD'), git('status', '--porcelain') !== '')
console.log(`Building GitGoose ${version}`)
build(version)
if (buildOnly) {
  console.log(`Built into ${out}`)
} else {
  const where = { darwin: installMac, win32: installWindows, linux: installLinux }[process.platform as 'darwin' | 'win32' | 'linux']()
  console.log(`Installed GitGoose ${version} at ${where}`)
}
