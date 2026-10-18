import { initRepo } from '@gitgoose/fixtures'
import { expect, test, type Page } from '@playwright/test'
import { launch } from './app'

/** Screen position of the first occurrence of `word` inside the diff lines. */
async function wordPosition(page: Page, word: string) {
  return page.evaluate((w) => {
    const root = document.querySelector('[data-testid="diff-lines"]')!
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = new RegExp(`\\b${w}\\b`).exec(n.textContent ?? '')?.index
      if (i === undefined) continue
      const range = document.createRange()
      range.setStart(n, i)
      range.setEnd(n, i + w.length)
      const r = range.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    throw new Error(`${w} not in the diff`)
  }, word)
}

test('Ctrl+click a name in a diff to peek at its definition and uses; Esc closes the peek only', async () => {
  const r = initRepo()
  r.commit('root', { 'src/price.ts': 'export function total(price: number, count: number): number {\n  return price * count\n}\n' })
  r.commit('use it', { 'src/cart.ts': "import { total } from './price'\nexport const sum = total(2, 3)\n" })
  const { app, page } = await launch(r.dir)
  await page.getByTestId('commit-file').filter({ hasText: 'cart.ts' }).click()
  await expect(page.getByTestId('diff-lines')).toContainText('total(2, 3)')

  const at = await wordPosition(page, 'total')
  await page.keyboard.down('ControlOrMeta')
  await page.mouse.click(at.x, at.y)
  await page.keyboard.up('ControlOrMeta')
  const peek = page.getByTestId('code-peek')
  await expect(peek).toContainText('total')
  await expect(peek.getByTestId('peek-definition')).toContainText('src/price.ts:1')
  await expect(peek.getByTestId('peek-definition')).toContainText('return price * count')
  await expect(peek.getByTestId('peek-reference')).toHaveCount(2)

  await page.keyboard.press('Escape')
  await expect(peek).toHaveCount(0)
  await expect(page.getByTestId('file-view')).toBeVisible()
  await app.close()
})
