import { createServer, type IncomingMessage, type Server } from 'node:http'

/**
 * A local stand-in for github.com and api.github.com, enough for the OAuth device flow, GET /user,
 * the commit lookup behind signed-in avatars, and avatar images. Tests point the app at it with
 * GITSQUID_GITHUB_URL / GITSQUID_GITHUB_API; nothing ever talks to the real GitHub.
 */

/** A real 1x1 PNG. */
export const FAKE_AVATAR_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

export interface FakeGitHubOptions {
  clientId?: string
  /** How many polls answer authorization_pending before the outcome. */
  pendingPolls?: number
  /** Answer slow_down on the first poll. */
  slowDown?: boolean
  outcome?: 'token' | 'access_denied' | 'expired_token'
  /** Scopes the token grants (defaults to what was asked for). */
  grant?: string
  user?: { login: string; name: string | null }
  /** sha -> GitHub login of that commit's author, for GET /repos/:o/:r/commits/:sha. */
  commits?: Record<string, string>
}

export interface FakeGitHub {
  url: string
  server: Server
  /** Every request, as "METHOD /path", in order. */
  hits: string[]
  /** Tokens handed out. */
  tokens: string[]
  opts: FakeGitHubOptions
  close(): Promise<void>
}

async function body(req: IncomingMessage): Promise<Record<string, string>> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if ((req.headers['content-type'] ?? '').includes('json')) return raw ? JSON.parse(raw) : {}
  return Object.fromEntries(new URLSearchParams(raw))
}

export async function fakeGitHub(opts: FakeGitHubOptions = {}): Promise<FakeGitHub> {
  const clientId = opts.clientId ?? 'test-client'
  const hits: string[] = []
  const tokens: string[] = []
  let polls = 0
  let scope = ''
  let url = ''
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0]!
    hits.push(`${req.method} ${path}`)
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    const auth = req.headers.authorization ?? ''
    const authed = tokens.some((t) => auth === `Bearer ${t}` || auth === `token ${t}`)

    if (req.method === 'POST' && path === '/login/device/code') {
      const b = await body(req)
      if (b.client_id !== clientId) return json(200, { error: 'incorrect_client_credentials' })
      scope = b.scope ?? ''
      polls = 0
      return json(200, { device_code: 'dev-123', user_code: 'WDJB-MJHT', verification_uri: `${url}/login/device`, expires_in: 900, interval: 1 })
    }
    if (req.method === 'POST' && path === '/login/oauth/access_token') {
      const b = await body(req)
      if (b.client_id !== clientId || b.device_code !== 'dev-123' || b.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') {
        return json(200, { error: 'incorrect_device_code' })
      }
      polls++
      if (opts.slowDown && polls === 1) return json(200, { error: 'slow_down', interval: 6 })
      if (polls <= (opts.pendingPolls ?? 1) + (opts.slowDown ? 1 : 0)) return json(200, { error: 'authorization_pending' })
      const outcome = opts.outcome ?? 'token'
      if (outcome !== 'token') return json(200, { error: outcome })
      const token = `gho_fake${tokens.length + 1}`
      tokens.push(token)
      return json(200, { access_token: token, token_type: 'bearer', scope: opts.grant ?? scope.replace(/ /g, ',') })
    }
    if (req.method === 'GET' && path === '/user') {
      if (!authed) return json(401, { message: 'Bad credentials' })
      const u = opts.user ?? { login: 'octocat', name: 'The Octocat' }
      return json(200, { ...u, avatar_url: `${url}/avatars/${u.login}.png` })
    }
    const commit = /^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]+)$/.exec(path)
    if (req.method === 'GET' && commit) {
      if (!authed) return json(401, { message: 'Bad credentials' })
      const login = opts.commits?.[commit[3]!]
      if (!login) return json(422, { message: 'No commit found for SHA' })
      return json(200, { sha: commit[3], author: { login, avatar_url: `${url}/avatars/${login}.png` } })
    }
    if (req.method === 'GET' && path.startsWith('/avatars/')) {
      res.writeHead(200, { 'content-type': 'image/png' })
      return res.end(FAKE_AVATAR_PNG)
    }
    json(404, { message: 'Not Found' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    url, server, hits, tokens, opts,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
