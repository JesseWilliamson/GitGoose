import { tempDir } from '@gitsquid/fixtures'
import { utimesSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AvatarCache, TRANSPARENT_PNG } from './avatars'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

function fakeFetch(routes: Record<string, number>, calls: string[]): typeof fetch {
  return (async (url: string) => {
    calls.push(url)
    const status = Object.entries(routes).find(([k]) => url.includes(k))?.[1] ?? 404
    return new Response(status === 200 ? PNG : 'nope', { status, headers: { 'content-type': status === 200 ? 'image/png' : 'text/plain' } })
  }) as unknown as typeof fetch
}

describe('AvatarCache', () => {
  it('serves nothing and never fetches when the source is initials', async () => {
    const calls: string[] = []
    const c = new AvatarCache({ dir: tempDir(), source: () => 'initials', fetch: fakeFetch({}, calls) })
    expect((await c.get('583231+octocat@users.noreply.github.com')).body).toEqual(TRANSPARENT_PNG)
    expect(calls).toEqual([])
  })

  it('fetches once, then serves from disk; shares concurrent lookups', async () => {
    const calls: string[] = []
    const dir = tempDir()
    const c = new AvatarCache({ dir, source: () => 'github', fetch: fakeFetch({ '/u/583231': 200 }, calls) })
    const email = '583231+octocat@users.noreply.github.com'
    const [a, b] = await Promise.all([c.get(email), c.get(email)])
    expect(a.body).toEqual(PNG)
    expect(b.body).toEqual(PNG)
    expect(calls).toHaveLength(1)
    const again = new AvatarCache({ dir, source: () => 'github', fetch: fakeFetch({}, calls) })
    expect((await again.get(email)).body).toEqual(PNG)
    expect(calls).toHaveLength(1)
  })

  it('remembers misses, and retries them after the miss expires', async () => {
    const calls: string[] = []
    const dir = tempDir()
    const c = new AvatarCache({ dir, source: () => 'gravatar', fetch: fakeFetch({}, calls) })
    expect((await c.get('nobody@example.com')).body).toEqual(TRANSPARENT_PNG)
    expect((await c.get('nobody@example.com')).body).toEqual(TRANSPARENT_PNG)
    expect(calls).toHaveLength(1)
    const miss = readdirSync(dir).find((f) => f.endsWith('.miss'))!
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    utimesSync(join(dir, miss), old, old)
    await c.get('nobody@example.com')
    expect(calls).toHaveLength(2)
  })

  it('caches per source, so switching sources does not reuse the other source\'s answer', async () => {
    const calls: string[] = []
    let source: 'github' | 'gravatar' = 'gravatar'
    const c = new AvatarCache({ dir: tempDir(), source: () => source, fetch: fakeFetch({ '/avatar/': 200 }, calls) })
    expect((await c.get('ada@example.com')).body).toEqual(PNG)
    source = 'github'
    expect((await c.get('ada@example.com')).body).toEqual(TRANSPARENT_PNG) // not a noreply address
  })

  it('uses the resolver for authors the URL rules cannot map', async () => {
    const calls: string[] = []
    const c = new AvatarCache({
      dir: tempDir(), source: () => 'github', fetch: fakeFetch({ 'resolved.example': 200 }, calls),
      resolve: async (email) => (email === 'ada@example.com' ? 'https://resolved.example/ada.png' : null),
    })
    expect((await c.get('ada@example.com')).body).toEqual(PNG)
    expect(calls).toEqual(['https://resolved.example/ada.png'])
  })
})
