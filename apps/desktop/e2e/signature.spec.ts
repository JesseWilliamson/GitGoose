import { initRepo, tempDir } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { launch } from './app'

test.skip(spawnSync('gpg', ['--version']).status !== 0, 'needs gpg')

test('a signed commit shows a verified signature; an unsigned one shows nothing', async () => {
  const home = tempDir('gitgoose-gnupg-')
  chmodSync(home, 0o700)
  const env = { GNUPGHOME: home, GIT_CONFIG_GLOBAL: '/dev/null' }
  execFileSync('gpg', ['--batch', '--passphrase', '', '--quick-gen-key', 'Ada Lovelace <ada@example.com>', 'ed25519', 'sign', 'never'], { stdio: 'ignore', env: { ...process.env, ...env } })
  const r = initRepo()
  const plain = r.commit('plain')
  execFileSync('git', ['-c', 'user.signingkey=ada@example.com', 'commit', '-q', '-S', '--allow-empty', '-m', 'signed'], { cwd: r.dir, env: { ...process.env, ...env } })
  const signed = r.head()
  const { app, page } = await launch(r.dir, env)
  await page.locator(`[data-testid="commit-row"][data-hash="${signed}"]`).click()
  await expect(page.getByTestId('signature')).toHaveText('Verified signature · Ada Lovelace <ada@example.com>')
  await page.locator(`[data-testid="commit-row"][data-hash="${plain}"]`).click()
  await expect(page.getByTestId('detail-panel')).toContainText('plain')
  await expect(page.getByTestId('signature')).toHaveCount(0)
  await app.close()
  spawnSync('gpgconf', ['--kill', 'gpg-agent'], { env: { ...process.env, ...env } })
})
