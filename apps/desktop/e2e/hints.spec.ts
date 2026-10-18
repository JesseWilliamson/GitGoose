import { initRepo } from '@gitgoose/fixtures'
import { expect, test } from '@playwright/test'
import { launch } from './app'

test('before committing: a usual companion that is missing, and whose lines are changing', async () => {
  const r = initRepo()
  r.commit('root', { 'price.ts': '1\n2\n3\n', 'price.test.ts': 't\n' })
  for (let i = 0; i < 3; i++) r.commit(`change ${i}`, { 'price.ts': `1\n2\n${i}\n`, 'price.test.ts': `t${i}\n` })
  r.write('price.ts', '1\n2\nnew\n')
  const { app, page } = await launch(r.dir)
  const hints = page.getByTestId('change-hints')
  await expect(hints.getByTestId('co-change')).toContainText('price.test.ts usually changes with price.ts (4 of 4 commits)')
  await expect(hints.getByTestId('owners')).toHaveText('Changing lines by Ada Lovelace (1).')

  r.write('price.test.ts', 'updated\n')
  await expect(hints.getByTestId('co-change')).toHaveCount(0)
  await app.close()
})
