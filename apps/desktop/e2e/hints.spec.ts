import { initRepo } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { launch } from './app'

test('before committing: whose lines are changing', async () => {
  const r = initRepo()
  r.commit('root', { 'price.ts': '1\n2\n3\n' })
  r.write('price.ts', '1\n2\nnew\n')
  const { app, page } = await launch(r.dir)
  const hints = page.getByTestId('change-hints')
  await expect(hints.getByTestId('owners')).toHaveText('Changing lines by Ada Lovelace (1).')

  // Nothing left to change in tracked files: the hint goes away.
  r.write('price.ts', '1\n2\n3\n')
  await expect(hints).toHaveCount(0)
  await app.close()
})
