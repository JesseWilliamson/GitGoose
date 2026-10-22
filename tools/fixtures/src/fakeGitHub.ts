import { createServer, type Server } from 'node:http'

/**
 * A local stand-in for github.com and api.github.com, enough for the commit lookup behind
 * avatars, the pull request list, and avatar images. Like the real GitHub for a public
 * repository, it answers without any sign-in. Tests point the app at it with
 * GITGOOSE_GITHUB_URL / GITGOOSE_GITHUB_API; nothing ever talks to the real GitHub.
 */

/** A real 1x1 PNG. */
export const FAKE_AVATAR_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

export interface FakeGitHubOptions {
  /** sha -> GitHub login of that commit's author, for GET /repos/:o/:r/commits/:sha. */
  commits?: Record<string, string>
  /** Open pull requests, in GitHub's JSON shape. */
  pulls?: FakePull[]
}

export interface FakePull {
  number: number
  title: string
  body?: string
  draft?: boolean
  html_url: string
  user: { login: string }
  head: { ref: string; sha: string; repo: { full_name: string } }
  base: { ref: string }
}

export interface FakeGitHub {
  url: string
  server: Server
  /** Every request, as "METHOD /path", in order. */
  hits: string[]
  /** Every request's Authorization header ('' when there was none), in the same order as `hits`. */
  authorization: string[]
  /** The open pull requests. */
  pulls: FakePull[]
  opts: FakeGitHubOptions
  close(): Promise<void>
}

export async function fakeGitHub(opts: FakeGitHubOptions = {}): Promise<FakeGitHub> {
  const hits: string[] = []
  const authorization: string[] = []
  const pulls: FakePull[] = opts.pulls ?? []
  let url = ''
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!
    hits.push(`${req.method} ${path}`)
    authorization.push(req.headers.authorization ?? '')
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }

    const commit = /^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]+)$/.exec(path)
    if (req.method === 'GET' && commit) {
      const login = opts.commits?.[commit[3]!]
      if (!login) return json(422, { message: 'No commit found for SHA' })
      return json(200, { sha: commit[3], author: { login, avatar_url: `${url}/avatars/${login}.png` } })
    }
    if (req.method === 'GET' && /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.test(path)) return json(200, pulls)
    if (req.method === 'GET' && path.startsWith('/avatars/')) {
      res.writeHead(200, { 'content-type': 'image/png' })
      return res.end(FAKE_AVATAR_PNG)
    }
    json(404, { message: 'Not Found' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    url, server, hits, authorization, opts, pulls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
