import { initRepo, tempDir } from '@gitsquid/fixtures'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Repo } from './repo'

// A throwaway GPG home with one passphrase-less key, and no global git config (it may force SSH).
const hasGpg = spawnSync('gpg', ['--version']).status === 0
const home = tempDir('gitsquid-gnupg-')
const saved = { GNUPGHOME: process.env.GNUPGHOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL }
beforeAll(() => {
  if (!hasGpg) return
  chmodSync(home, 0o700)
  process.env.GNUPGHOME = home
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  // Loopback: take the (empty) passphrase from the command line, never from a pinentry window.
  const gen = spawnSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-gen-key', 'Ada Lovelace <ada@example.com>', 'ed25519', 'sign', 'never'], { encoding: 'utf8' })
  if (gen.status !== 0) throw new Error(`gpg could not make a test key (exit ${gen.status}):\n${gen.stderr}`)
})
afterAll(() => {
  if (!hasGpg) return
  spawnSync('gpgconf', ['--kill', 'gpg-agent'], { env: process.env })
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe.skipIf(!hasGpg)('signatures', () => {
  it('verifies a signed commit, flags a bad one, and leaves unsigned commits alone', async () => {
    const r = initRepo()
    r.git('config', 'user.signingkey', 'ada@example.com')
    const plain = r.commit('plain')
    r.git('commit', '-q', '-S', '--allow-empty', '-m', 'signed')
    const signed = r.head()
    const repo = await Repo.open(r.dir, {})
    expect((await repo.commitDetails(plain)).signature).toBeUndefined()
    expect((await repo.commitDetails(signed)).signature).toMatchObject({ status: 'G', signer: 'Ada Lovelace <ada@example.com>' })

    // Tamper: same signature, different message. git must call it bad.
    const raw = r.git('cat-file', 'commit', signed).replace('signed\n', 'tampered\n')
    const forged = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: r.dir, input: raw, encoding: 'utf8' }).trim()
    expect((await repo.commitDetails(forged)).signature?.status).toBe('B')
    repo.dispose()
  })

  it('creates signed tags', async () => {
    const r = initRepo()
    r.git('config', 'user.signingkey', 'ada@example.com')
    const head = r.commit('root')
    const repo = await Repo.open(r.dir, {})
    await repo.createTag('v1', head, undefined, { sign: true })
    expect(r.git('cat-file', 'tag', 'v1')).toContain('-----BEGIN PGP SIGNATURE-----')
    expect(spawnSync('git', ['tag', '-v', 'v1'], { cwd: r.dir }).status).toBe(0)
    repo.dispose()
  })
})
