import { Repo } from '@gitgoose/git'
import { fakeGitHub, makeFixture, type FakeGitHub, type FakeGitHubOptions } from '@gitgoose/fixtures'
import { afterEach, describe, expect, it } from 'vitest'
import { GitHubApi, RateLimitedError, rateLimitPause } from './api'
import { GitHubService } from './service'

let servers: FakeGitHub[] = []
let opened: Repo[] = []
async function server(opts: FakeGitHubOptions = {}) {
  const s = await fakeGitHub(opts)
  servers.push(s)
  return s
}
async function open(dir: string) {
  const repo = await Repo.open(dir, {})
  opened.push(repo)
  return repo
}
afterEach(async () => {
  for (const r of opened) r.dispose()
  opened = []
  await Promise.all(servers.map((s) => s.close()))
  servers = []
})

const response = (status: number, headers: Record<string, string> = {}, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('rateLimitPause', () => {
  const now = 1_000_000_000_000
  it('reads when to ask again from the headers of a refusal', () => {
    // The hourly limit: wait for its reset.
    expect(rateLimitPause(response(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 600) }), now)).toBe(now + 600_000)
    // retry-after (seconds) wins: GitHub sends it for its secondary limits.
    expect(rateLimitPause(response(429, { 'retry-after': '30', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 600) }), now)).toBe(now + 30_000)
    // A limit response that says nothing more: a minute, as GitHub advises.
    expect(rateLimitPause(response(429), now)).toBe(now + 60_000)
    expect(rateLimitPause(response(403, { 'x-ratelimit-remaining': '12' }), now)).toBe(now + 60_000)
  })

  it('pauses after the last allowed request succeeds, and not for other answers', () => {
    expect(rateLimitPause(response(200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 60) }), now)).toBe(now + 60_000)
    expect(rateLimitPause(response(200, { 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': String(now / 1000 + 60) }), now)).toBe(0)
    expect(rateLimitPause(response(404), now)).toBe(0)
    // A 403 without any rate limit header is a different refusal.
    expect(rateLimitPause(response(403), now)).toBe(0)
  })
})

describe('GitHubApi', () => {
  it('stops asking once GitHub says the limit is used up, until the reset', async () => {
    let now = 1_000_000_000_000
    const sent: string[] = []
    const fetchFn = (async (url: string) => {
      sent.push(url)
      return sent.length === 1
        ? response(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 600) }, { message: 'API rate limit exceeded' })
        : response(200, {}, [])
    }) as unknown as typeof fetch
    const api = new GitHubApi({ base: 'https://api.example', fetch: fetchFn, now: () => now })
    await expect(api.pulls('acme', 'widgets')).rejects.toBeInstanceOf(RateLimitedError)
    await expect(api.pulls('acme', 'widgets')).rejects.toThrow(/60 requests an hour/)
    await expect(api.commitAuthorAvatar('acme', 'widgets', 'abc')).rejects.toBeInstanceOf(RateLimitedError)
    expect(sent).toHaveLength(1)
    expect(api.pausedUntil()).toBe(now + 600_000)
    now += 600_001
    expect(await api.pulls('acme', 'widgets')).toEqual([])
    expect(sent).toHaveLength(2)
  })

  it('says plainly why a private repository cannot be listed', async () => {
    const api = new GitHubApi({ base: 'https://api.example', fetch: (async () => response(404, {}, { message: 'Not Found' })) as unknown as typeof fetch })
    await expect(api.pulls('acme', 'secret')).rejects.toThrow('GitHub answered 404: it lists pull requests only for public repositories when not signed in')
  })
})

describe('GitHub service', () => {
  function service(s: FakeGitHub, repos: Repo[] = []) {
    return new GitHubService({ endpoints: { web: 'https://github.example', api: s.url }, fetch, repos: () => repos })
  }

  it('finds avatars through pushed commits GitHub knows, without signing in', async () => {
    const r = makeFixture('linear')
    r.git('commit', '-q', '--allow-empty', '-m', 'by grace', '--author', 'Grace Hopper <grace@example.com>')
    const grace = r.head()
    r.git('commit', '-q', '--allow-empty', '-m', 'by hal', '--author', 'Hal <hal@example.com>')
    r.git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
    // A remote-tracking ref stands in for a fetch: these commits are "on GitHub".
    r.git('update-ref', 'refs/remotes/origin/main', r.head())
    r.git('commit', '-q', '--allow-empty', '-m', 'unpushed', '--author', 'Alan Turing <alan@example.com>')
    const s = await server({ commits: { [grace]: 'ghopper' } })
    const svc = service(s, [await open(r.dir)])

    expect(await svc.authorAvatar('Grace@Example.com')).toEqual({ kind: 'url', url: `${s.url}/avatars/ghopper.png?s=64` })
    expect(s.hits).toEqual([`GET /repos/acme/widgets/commits/${grace}`])
    expect(s.authorization).toEqual([''])
    // GitHub knows the commit but no account for it: a real answer.
    expect(await svc.authorAvatar('hal@example.com')).toEqual({ kind: 'none' })
    // Not pushed: GitHub is not asked, so nothing is known yet.
    const before = s.hits.length
    expect(await svc.authorAvatar('alan@example.com')).toEqual({ kind: 'later' })
    expect(s.hits.length).toBe(before)
  })

  it('asks nothing for repositories without a GitHub remote', async () => {
    const s = await server()
    const svc = service(s, [await open(makeFixture('linear').dir)])
    expect(await svc.authorAvatar('ada@example.com')).toEqual({ kind: 'later' })
    expect(s.hits).toEqual([])
  })

  it('lists pull requests with no Authorization header, only for a GitHub remote', async () => {
    const s = await server({ pulls: [{
      number: 7, title: 'Fix the widget', html_url: 'https://github.com/acme/widgets/pull/7', user: { login: 'grace' },
      head: { ref: 'fix-widget', sha: 'abc', repo: { full_name: 'someone/widgets' } }, base: { ref: 'main' },
    }] })
    const r = makeFixture('linear')
    const repo = await open(r.dir)
    const svc = service(s, [repo])
    expect(await svc.pullRequests(repo)).toEqual({ state: 'no-remote' })
    expect(s.hits).toEqual([])
    r.git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git')
    const list = await svc.pullRequests(repo)
    expect(list).toMatchObject({ state: 'ok', owner: 'acme', repo: 'widgets', pulls: [{ number: 7, author: 'grace', branch: 'fix-widget', fromFork: true }] })
    expect(s.hits).toEqual(['GET /repos/acme/widgets/pulls'])
    expect(s.authorization).toEqual([''])
  })

  it('builds the compare page for a new pull request, on the GitHub host only', async () => {
    const s = await server()
    const r = makeFixture('linear')
    const repo = await open(r.dir)
    const svc = service(s, [repo])
    await expect(svc.compareUrl(repo, { branch: 'x', base: 'main', title: 't', body: '' })).rejects.toThrow('no GitHub remote')
    r.git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
    const url = await svc.compareUrl(repo, { branch: 'feature/login', base: 'main', title: 'Add login & logout', body: 'Why:\n#12' })
    expect(url).toBe('https://github.example/acme/widgets/compare/main...feature/login?expand=1&title=Add%20login%20%26%20logout&body=Why%3A%0A%2312')
    expect(svc.isGitHubUrl(url)).toBe(true)
    expect(svc.isGitHubUrl('https://github.example.evil/acme')).toBe(false)
    expect(s.hits).toEqual([])
  })

  it('checks out a pull request by fetching pull/N/head, undoably', async () => {
    // The "GitHub" repository: a bare repo with a pull request ref, as GitHub keeps them.
    const upstream = makeFixture('linear')
    const prHead = upstream.commit('pr work', { 'pr.txt': 'pr\n' })
    upstream.git('update-ref', 'refs/pull/3/head', prHead)
    upstream.git('reset', '-q', '--hard', 'HEAD~1')
    const r = makeFixture('linear')
    r.git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
    // Point that URL at the local repository: nothing goes to github.com.
    r.git('config', `url.${upstream.dir}.insteadOf`, 'https://github.com/acme/widgets.git')
    const repo = await open(r.dir)
    const before = r.head()
    const id = await repo.checkoutPullRequest('origin', 3)
    expect(r.git('branch', '--show-current').trim()).toBe('pr/3')
    expect(r.head()).toBe(prHead)
    await repo.undo(id)
    expect(r.head()).toBe(before)
    expect(r.git('branch', '--list', 'pr/3')).toBe('')
  })
})
