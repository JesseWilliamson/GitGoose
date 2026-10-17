import { Repo } from '@gitsquid/git'
import { fakeGitHub, makeFixture, tempDir, type FakeGitHub, type FakeGitHubOptions } from '@gitsquid/fixtures'
import { GITHUB_SCOPES, type GitHubStatus } from '@gitsquid/shared'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceFlowError, pollForToken, requestDeviceCode, type GitHubEndpoints } from './deviceFlow'
import { GitHubService } from './service'
import { TokenStore, type Encryption } from './tokenStore'

/** Reversible and recognisable, so the tests can check the file never holds the token in clear. */
const fakeEncryption = (secure = true): Encryption => ({
  secure: () => secure,
  encrypt: (s) => Buffer.from(s.split('').reverse().join(''), 'utf8'),
  decrypt: (b) => b.toString('utf8').split('').reverse().join(''),
})

/** Polls without waiting, but still records how long the flow asked to wait. */
function instant() {
  const waits: number[] = []
  const sleep = async (ms: number, signal?: AbortSignal) => {
    waits.push(ms)
    await new Promise((r) => setImmediate(r))
    if (signal?.aborted) throw new DeviceFlowError('cancelled')
  }
  return { sleep, waits }
}

let servers: FakeGitHub[] = []
async function server(opts: FakeGitHubOptions = {}) {
  const s = await fakeGitHub(opts)
  servers.push(s)
  const ep: GitHubEndpoints = { web: s.url, api: s.url, clientId: 'test-client' }
  return { s, ep }
}
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()))
  servers = []
})

describe('device flow', () => {
  it('waits through authorization_pending and slow_down, then returns the token and scopes', async () => {
    const { s, ep } = await server({ pendingPolls: 2, slowDown: true })
    const { sleep, waits } = instant()
    const code = await requestDeviceCode(ep, GITHUB_SCOPES.basic, { fetch })
    expect(code).toMatchObject({ userCode: 'WDJB-MJHT', interval: 1, expiresIn: 900 })
    const res = await pollForToken(ep, code, { fetch, sleep })
    expect(res).toEqual({ token: 'gho_fake1', scopes: ['read:user'] })
    // 1 s, then slow_down's interval (6 s) for every later poll.
    expect(waits).toEqual([1000, 6000, 6000, 6000])
    expect(s.hits.filter((h) => h.endsWith('/access_token'))).toHaveLength(4)
  })

  it('adds 5 seconds on slow_down when GitHub sends no new interval', async () => {
    const { s, ep } = await server({ pendingPolls: 0 })
    const { sleep, waits } = instant()
    let first = true
    const fetchSlow: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/access_token') && first) {
        first = false
        return new Response(JSON.stringify({ error: 'slow_down' }), { headers: { 'content-type': 'application/json' } })
      }
      return fetch(url, init)
    }
    const code = await requestDeviceCode(ep, GITHUB_SCOPES.basic, { fetch })
    await pollForToken(ep, code, { fetch: fetchSlow, sleep })
    expect(waits).toEqual([1000, 6000])
    void s
  })

  it.each(['access_denied', 'expired_token'] as const)('stops with %s', async (outcome) => {
    const { ep } = await server({ outcome })
    const code = await requestDeviceCode(ep, GITHUB_SCOPES.basic, { fetch })
    await expect(pollForToken(ep, code, { fetch, sleep: instant().sleep })).rejects.toMatchObject({ code: outcome })
  })

  it('gives up when the code expires, even if GitHub keeps saying pending', async () => {
    const { ep } = await server({ pendingPolls: 1000 })
    const code = await requestDeviceCode(ep, GITHUB_SCOPES.basic, { fetch })
    let t = 0
    const { sleep } = instant()
    await expect(pollForToken(ep, code, { fetch, sleep: (ms, sig) => ((t += ms), sleep(ms, sig)), now: () => t }))
      .rejects.toMatchObject({ code: 'expired_token' })
  })

  it('refuses to start without a client id, and reports a wrong one', async () => {
    const { ep } = await server()
    await expect(requestDeviceCode({ ...ep, clientId: '' }, GITHUB_SCOPES.basic, { fetch })).rejects.toMatchObject({ code: 'not_configured' })
    await expect(requestDeviceCode({ ...ep, clientId: 'nope' }, GITHUB_SCOPES.basic, { fetch })).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('can be cancelled while polling', async () => {
    const { ep } = await server({ pendingPolls: 1000 })
    const code = await requestDeviceCode(ep, GITHUB_SCOPES.basic, { fetch })
    const abort = new AbortController()
    const p = pollForToken(ep, code, { fetch, sleep: instant().sleep }, abort.signal)
    setTimeout(() => abort.abort(), 20)
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
  })
})

describe('token store', () => {
  const account = { login: 'octocat', name: null, avatarUrl: 'x', scopes: ['read:user'] }

  it('round-trips through the encryption and never writes the token in clear', () => {
    const file = join(tempDir('gitsquid-gh-'), 'github.json')
    expect(new TokenStore(file, fakeEncryption()).save(account, 'gho_secret')).toEqual({ persisted: true })
    expect(readFileSync(file, 'utf8')).not.toContain('gho_secret')
    expect(new TokenStore(file, fakeEncryption()).load()).toEqual({ account, token: 'gho_secret' })
    new TokenStore(file, fakeEncryption()).clear()
    expect(existsSync(file)).toBe(false)
  })

  it('keeps the token in memory only without a real keychain', () => {
    const file = join(tempDir('gitsquid-gh-'), 'github.json')
    const store = new TokenStore(file, fakeEncryption(false))
    expect(store.save(account, 'gho_secret')).toEqual({ persisted: false })
    expect(existsSync(file)).toBe(false)
    expect(store.load()?.token).toBe('gho_secret')
    expect(new TokenStore(file, fakeEncryption(false)).load()).toBeNull()
  })
})

describe('GitHub service', () => {
  async function setup(opts: FakeGitHubOptions = {}, https = false) {
    const { s, ep } = await server(opts)
    const statuses: GitHubStatus[] = []
    const repos: Repo[] = []
    const svc = new GitHubService({
      endpoints: ep,
      store: new TokenStore(join(tempDir('gitsquid-gh-'), 'github.json'), fakeEncryption()),
      fetch,
      sleep: instant().sleep,
      repos: () => repos,
      httpsEnabled: () => https,
      onChange: (st) => statuses.push(st),
    })
    return { s, svc, statuses, repos }
  }

  it('signs in, reports the account, and signs out', async () => {
    const { svc, statuses } = await setup()
    expect(svc.status()).toEqual({ configured: true, account: null, persisted: true })
    const info = await svc.startSignIn(GITHUB_SCOPES.basic)
    expect(info.userCode).toBe('WDJB-MJHT')
    expect(svc.pageUrl('verification')).toMatch(/\/login\/device$/)
    const account = await svc.waitForSignIn()
    expect(account).toMatchObject({ login: 'octocat', name: 'The Octocat', scopes: ['read:user'] })
    expect(statuses.at(-1)?.account?.login).toBe('octocat')
    svc.signOut()
    expect(svc.status().account).toBeNull()
    expect(svc.pageUrl('applications')).toMatch(/\/settings\/connections\/applications\/test-client$/)
  })

  it('finds avatars through commits GitHub knows, and only pushed ones', async () => {
    const r = makeFixture('linear')
    r.git('commit', '-q', '--allow-empty', '-m', 'by grace', '--author', 'Grace Hopper <grace@example.com>')
    const grace = r.head()
    r.git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
    // A remote-tracking ref stands in for a fetch: the commit is "on GitHub".
    r.git('update-ref', 'refs/remotes/origin/main', grace)
    r.git('commit', '-q', '--allow-empty', '-m', 'unpushed', '--author', 'Alan Turing <alan@example.com>')
    const { s, svc, repos } = await setup({ commits: { [grace]: 'ghopper' } })
    repos.push(await Repo.open(r.dir, {}))
    expect(await svc.resolveAvatar('grace@example.com')).toBeNull() // signed out: no call
    expect(s.hits.some((h) => h.includes('/commits/'))).toBe(false)
    await svc.startSignIn(GITHUB_SCOPES.basic)
    await svc.waitForSignIn()
    expect(svc.avatarVariant()).toBe('gh')
    expect(await svc.resolveAvatar('Grace@Example.com')).toBe(`${s.url}/avatars/ghopper.png?s=64`)
    expect(s.hits).toContain(`GET /repos/acme/widgets/commits/${grace}`)
    const before = s.hits.length
    expect(await svc.resolveAvatar('alan@example.com')).toBeNull()
    expect(s.hits.length).toBe(before) // not pushed: GitHub is not asked
    repos[0]!.dispose()
  })

  it('answers github.com password prompts only with repository access and the setting on', async () => {
    const { svc } = await setup({ grant: 'read:user' }, true)
    await svc.startSignIn(GITHUB_SCOPES.basic)
    await svc.waitForSignIn()
    expect(svc.answerPrompt("Password for 'https://octocat@github.com': ")).toBeNull()
    expect(svc.credentialEnv({})).toEqual({})

    const withRepo = await setup({ grant: 'read:user,repo' }, true)
    await withRepo.svc.startSignIn(GITHUB_SCOPES.repo)
    await withRepo.svc.waitForSignIn()
    expect(withRepo.svc.answerPrompt("Username for 'https://github.com': ")).toBe('octocat')
    expect(withRepo.svc.answerPrompt("Password for 'https://octocat@github.com': ")).toBe('gho_fake1')
    expect(withRepo.svc.answerPrompt("Password for 'https://gitlab.com': ")).toBeNull()
    // Helpers are switched off for github.com only, appended after any config already in the env.
    expect(withRepo.svc.credentialEnv({ GIT_CONFIG_COUNT: '2' })).toEqual({
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_2: '',
    })

    const off = await setup({ grant: 'read:user,repo' }, false)
    await off.svc.startSignIn(GITHUB_SCOPES.repo)
    await off.svc.waitForSignIn()
    expect(off.svc.answerPrompt("Password for 'https://octocat@github.com': ")).toBeNull()
  })

  it('still reports success to a wait that arrives after polling finished', async () => {
    const { svc } = await setup({ pendingPolls: 0 })
    await svc.startSignIn(GITHUB_SCOPES.basic)
    await new Promise((r) => setTimeout(r, 100))
    expect(svc.status().account?.login).toBe('octocat')
    await expect(svc.waitForSignIn()).resolves.toMatchObject({ login: 'octocat' })
  })

  it('reports a denied sign-in to whoever waits, and stays signed out', async () => {
    const { svc } = await setup({ outcome: 'access_denied' })
    await svc.startSignIn(GITHUB_SCOPES.basic)
    await expect(svc.waitForSignIn()).rejects.toMatchObject({ code: 'access_denied' })
    expect(svc.status().account).toBeNull()
  })

  it('lists and creates pull requests only for a GitHub remote and a signed-in user', async () => {
    const { s, svc, repos } = await setup({ pulls: [{
      number: 7, title: 'Fix the widget', html_url: 'https://github.com/acme/widgets/pull/7', user: { login: 'grace' },
      head: { ref: 'fix-widget', sha: 'abc', repo: { full_name: 'someone/widgets' } }, base: { ref: 'main' },
    }] })
    const r = makeFixture('linear')
    const repo = await Repo.open(r.dir, {})
    repos.push(repo)
    expect(await svc.pullRequests(repo)).toEqual({ state: 'no-remote' })
    r.git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git')
    expect(await svc.pullRequests(repo)).toEqual({ state: 'signed-out' })
    expect(s.hits.filter((h) => h.includes('/pulls'))).toEqual([])

    await svc.startSignIn(GITHUB_SCOPES.repo)
    await svc.waitForSignIn()
    const list = await svc.pullRequests(repo)
    expect(list).toMatchObject({ state: 'ok', owner: 'acme', repo: 'widgets', pulls: [{ number: 7, author: 'grace', branch: 'fix-widget', fromFork: true }] })

    const pr = await svc.createPullRequest(repo, { branch: 'feature', base: 'main', title: 'Add feature', body: 'Why', draft: true })
    expect(pr).toMatchObject({ number: 8, title: 'Add feature', branch: 'feature', base: 'main', draft: true, fromFork: false })
    await expect(svc.createPullRequest(repo, { branch: 'feature', base: 'main', title: 'Again', body: '', draft: false }))
      .rejects.toThrow(/A pull request already exists/)
    repo.dispose()
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
    const repo = await Repo.open(r.dir, {})
    const before = r.head()
    const id = await repo.checkoutPullRequest('origin', 3)
    expect(r.git('branch', '--show-current').trim()).toBe('pr/3')
    expect(r.head()).toBe(prHead)
    await repo.undo(id)
    expect(r.head()).toBe(before)
    expect(r.git('branch', '--list', 'pr/3')).toBe('')
    repo.dispose()
  })
})
