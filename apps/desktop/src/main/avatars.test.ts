import { Repo } from '@gitgoose/git'
import { makeFixture, tempDir } from '@gitgoose/fixtures'
import { readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AvatarCache, type AvatarCacheOptions } from './avatars'
import { GitHubApi } from './github/api'
import { lookupAuthorAvatar } from './github/avatarLookup'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const API = 'https://api.example'

type Route = (url: string) => Response | undefined

/** A fake network: each request goes to the first route that answers, else 404. */
function fakeFetch(calls: string[], ...routes: Route[]): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    // GitGoose never signs in: no request may carry credentials.
    if (new Headers(init?.headers).has('authorization')) throw new Error('Authorization header sent')
    for (const route of routes) {
      const res = route(url)
      if (res) return res
    }
    return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } })
  }) as unknown as typeof fetch
}

const image = (part: string): Route => (url) => (url.includes(part) ? new Response(PNG, { headers: { 'content-type': 'image/png' } }) : undefined)
const json = (part: string, status: number, body: unknown, headers: Record<string, string> = {}): Route => (url) =>
  url.startsWith(API) && url.includes(part) ? new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }) : undefined

let opened: Repo[] = []
afterEach(() => {
  for (const r of opened) r.dispose()
  opened = []
})

/** A repository whose GitHub remote already has commits by grace and hal (pushed), and one by alan that is not. */
async function githubRepo() {
  const r = makeFixture('linear')
  r.git('commit', '-q', '--allow-empty', '-m', 'by grace', '--author', 'Grace Hopper <grace@example.com>')
  const grace = r.head()
  r.git('commit', '-q', '--allow-empty', '-m', 'by hal', '--author', 'Hal <hal@example.com>')
  const hal = r.head()
  r.git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  r.git('update-ref', 'refs/remotes/origin/main', hal)
  r.git('commit', '-q', '--allow-empty', '-m', 'unpushed', '--author', 'Alan Turing <alan@example.com>')
  const repo = await Repo.open(r.dir, {})
  opened.push(repo)
  return { repo, grace, hal }
}

/** The cache as index.ts wires it: noreply addresses first, then GitHub's commits API. */
function cache(dir: string, fetchFn: typeof fetch, repos: Repo[], extra: Partial<AvatarCacheOptions> & { now?: () => number } = {}) {
  const api = new GitHubApi({ base: API, fetch: fetchFn, now: extra.now })
  const c = new AvatarCache({
    dir, source: () => 'github', fetch: fetchFn, avatarBase: 'https://avatars.example',
    lookup: (email) => lookupAuthorAvatar(email, repos, api), ...extra,
  })
  return { c, api }
}

const files = (dir: string) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

describe('AvatarCache', () => {
  it('asks nothing with the initials setting', async () => {
    const calls: string[] = []
    const { c } = cache(tempDir(), fakeFetch(calls, image('/u/')), [], { source: () => 'initials' })
    expect(await c.get('583231+octocat@users.noreply.github.com')).toBeNull()
    expect(calls).toEqual([])
  })

  it('maps a noreply address straight to its image: no API call; fetched once, then served from disk', async () => {
    const calls: string[] = []
    const dir = tempDir()
    const { c } = cache(dir, fakeFetch(calls, image('/u/583231')), [])
    const email = '583231+octocat@users.noreply.github.com'
    const [a, b] = await Promise.all([c.get(email), c.get(email)])
    expect(a?.body).toEqual(PNG)
    expect(b?.body).toEqual(PNG)
    expect(calls).toEqual(['https://avatars.example/u/583231?s=64&v=4'])
    const again = cache(dir, fakeFetch(calls), []).c
    expect((await again.get(email))?.body).toEqual(PNG)
    expect(calls).toHaveLength(1)
  })

  it('finds other authors through the public commits API, by a commit already on GitHub', async () => {
    const calls: string[] = []
    const { repo, grace } = await githubRepo()
    const fetchFn = fakeFetch(calls, json(`/repos/acme/widgets/commits/${grace}`, 200, { author: { login: 'ghopper', avatar_url: 'https://avatars.example/u/99?v=4' } }), image('/u/99'))
    const { c } = cache(tempDir(), fetchFn, [repo])
    expect((await c.get('Grace@Example.com'))?.body).toEqual(PNG)
    expect(calls).toEqual([`${API}/repos/acme/widgets/commits/${grace}`, 'https://avatars.example/u/99?v=4&s=64'])
    // Not pushed yet: GitHub cannot know it, so it is not asked.
    expect(await c.get('alan@example.com')).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('remembers GitHub\'s "no account" for a day, then asks again', async () => {
    const calls: string[] = []
    const dir = tempDir()
    const { repo, hal } = await githubRepo()
    const { c } = cache(dir, fakeFetch(calls, json(`/commits/${hal}`, 200, { author: null })), [repo])
    expect(await c.get('hal@example.com')).toBeNull()
    expect(await c.get('hal@example.com')).toBeNull()
    expect(calls).toHaveLength(1)
    const miss = files(dir).find((f) => f.endsWith('.miss'))!
    expect(miss).toBeTruthy()
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    utimesSync(join(dir, miss), old, old)
    await c.get('hal@example.com')
    expect(calls).toHaveLength(2)
  })

  it('pauses at the rate limit: nothing asked until the reset, and no miss written', async () => {
    const calls: string[] = []
    const dir = tempDir()
    let now = Date.now()
    const reset = Math.floor(now / 1000) + 900
    const { repo, grace, hal } = await githubRepo()
    let limited = true
    const fetchFn = fakeFetch(calls,
      (url) => (limited && url.startsWith(API) ? new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }) : undefined),
      json(`/commits/${grace}`, 200, { author: { login: 'ghopper', avatar_url: 'https://avatars.example/u/99' } }),
      json(`/commits/${hal}`, 200, { author: null }),
      image('/u/99'))
    const { c, api } = cache(dir, fetchFn, [repo], { now: () => now })

    expect(await c.get('grace@example.com')).toBeNull()
    expect(calls).toHaveLength(1)
    expect(api.pausedUntil()).toBe(reset * 1000)
    // Neither the same author nor another one makes GitHub be asked again before the reset.
    expect(await c.get('grace@example.com')).toBeNull()
    expect(await c.get('hal@example.com')).toBeNull()
    now += 10 * 60 * 1000
    expect(await c.get('hal@example.com')).toBeNull()
    expect(calls).toHaveLength(1)
    // "Could not ask" is not "has no avatar": nothing on disk says so.
    expect(files(dir).filter((f) => f.endsWith('.miss'))).toEqual([])

    limited = false
    now = reset * 1000 + 1
    expect((await c.get('grace@example.com'))?.body).toEqual(PNG)
    expect(calls.filter((u) => u.startsWith(API))).toHaveLength(2)
  })

  it('does not record a miss when the image host cannot be reached', async () => {
    const calls: string[] = []
    const dir = tempDir()
    const down: Route = () => {
      throw new TypeError('fetch failed')
    }
    const { c } = cache(dir, fakeFetch(calls, down), [])
    expect(await c.get('583231+octocat@users.noreply.github.com')).toBeNull()
    expect(files(dir).filter((f) => f.endsWith('.miss'))).toEqual([])
    // Answered from memory for a while, so scrolling does not retry it on every row.
    expect(await c.get('583231+octocat@users.noreply.github.com')).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('runs at most four network requests at once', async () => {
    let active = 0
    let peak = 0
    const fetchFn = (async () => {
      peak = Math.max(peak, ++active)
      await new Promise((r) => setTimeout(r, 20))
      active--
      return new Response(PNG, { headers: { 'content-type': 'image/png' } })
    }) as unknown as typeof fetch
    const c = new AvatarCache({ dir: tempDir(), source: () => 'github', fetch: fetchFn })
    const got = await Promise.all(Array.from({ length: 10 }, (_, i) => c.get(`${i + 1}+u@users.noreply.github.com`)))
    expect(got.every((g) => g?.body.equals(PNG))).toBe(true)
    expect(peak).toBe(4)
  })
})
