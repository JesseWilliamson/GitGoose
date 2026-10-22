import { noreplyAvatarUrl, type AvatarSource } from '@gitgoose/shared'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Author avatars, fetched and cached by the main process.
 *
 * The renderer never talks to the network: its Content-Security-Policy only allows images from
 * the app itself and from the `gitgoose-avatar:` scheme, which this class answers. It asks for
 * an author by email, and we find the picture on GitHub without signing in:
 *
 *   1. a GitHub noreply address names the account: its image URL needs no API call;
 *   2. otherwise `lookup` asks GitHub who wrote one of the author's pushed commits
 *      (github/avatarLookup.ts);
 *   3. nothing found is a miss: the renderer keeps the initials.
 *
 * Pictures are kept on disk for 30 days, and so are GitHub's "no such account" answers (for a
 * day), so an author without an avatar is not looked up again on every scroll. When GitHub could
 * not be asked (its hourly limit, no network, no GitHub remote open) nothing is written to disk:
 * the miss is remembered in memory for a while and the author is looked up again after that.
 *
 * Plain Node (no Electron imports), so it is unit-tested directly.
 */

const TTL_MS = 30 * 24 * 3600 * 1000
const MISS_TTL_MS = 24 * 3600 * 1000
/** How long a lookup that could not be made is not tried again (unless the rate limit says longer). */
const RETRY_MS = 10 * 60 * 1000
const TIMEOUT_MS = 3000
const MAX_IN_FLIGHT = 4

export interface AvatarImage {
  body: Buffer
  type: string
}

/**
 * What a GitHub lookup found: a picture's URL; `none`, GitHub knows no account for the author
 * (remembered on disk); or `later`, GitHub could not be asked (remembered in memory until
 * `until`, or for RETRY_MS).
 */
export type AvatarLookup = { kind: 'url'; url: string } | { kind: 'none' } | { kind: 'later'; until?: number }

export interface AvatarCacheOptions {
  dir: string
  source: () => AvatarSource
  /** Authors without a noreply address: ask GitHub (GitHubService.authorAvatar). */
  lookup?: (email: string) => Promise<AvatarLookup>
  /** Where noreply avatars are served from (a local stand-in in tests). */
  avatarBase?: string
  fetch?: typeof fetch
  now?: () => number
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

type Download = AvatarImage | 'missing' | 'failed'

export class AvatarCache {
  private inFlight = new Map<string, Promise<AvatarImage | null>>()
  /** Misses not written to disk (GitHub could not be asked), by cache key: until when. */
  private retryAt = new Map<string, number>()
  private active = 0
  private waiting: (() => void)[] = []
  /** How many images were downloaded (tests use it to prove "no network" really means none). */
  requests = 0

  constructor(private opts: AvatarCacheOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  /** The author's picture, or null for a miss (the protocol handler answers 404, the page keeps the initials). */
  async get(email: string): Promise<AvatarImage | null> {
    if (this.opts.source() === 'initials') return null
    const e = email.trim().toLowerCase()
    if (!e) return null
    // "gh-": the key of this scheme. Older builds used other prefixes, so their misses (recorded
    // while they could find fewer authors) do not hide anyone now.
    const key = `gh-${sha256(e)}`
    // Concurrent requests for the same author share one lookup.
    let p = this.inFlight.get(key)
    if (!p) {
      p = this.lookup(key, e).finally(() => this.inFlight.delete(key))
      this.inFlight.set(key, p)
    }
    return p
  }

  private async lookup(key: string, email: string): Promise<AvatarImage | null> {
    const file = join(this.opts.dir, key)
    const fresh = async (path: string, ttl: number) => {
      try {
        return this.now() - (await stat(path)).mtimeMs < ttl
      } catch {
        return false
      }
    }
    if (await fresh(file + '.img', TTL_MS)) {
      const body = await readFile(file + '.img')
      const type = (await readFile(file + '.type', 'utf8').catch(() => 'image/png')) || 'image/png'
      return { body, type }
    }
    if (await fresh(file + '.miss', MISS_TTL_MS)) return null
    if ((this.retryAt.get(key) ?? 0) > this.now()) return null
    this.retryAt.delete(key)

    let url = noreplyAvatarUrl(email, this.opts.avatarBase)
    if (!url && this.opts.lookup) {
      const lookup = this.opts.lookup
      const found = await this.limited(() => lookup(email)).catch((): AvatarLookup => ({ kind: 'later' }))
      if (found.kind === 'later') return this.later(key, found.until)
      if (found.kind === 'url') url = found.url
    }
    const got: Download = url ? await this.download(url) : 'missing'
    if (got === 'failed') return this.later(key)
    await mkdir(this.opts.dir, { recursive: true })
    if (got === 'missing') {
      await writeFile(file + '.miss', '')
      return null
    }
    await writeFile(file + '.img', got.body)
    await writeFile(file + '.type', got.type)
    return got
  }

  /** A miss that is not GitHub's answer: served now, not written to disk, looked up again later. */
  private later(key: string, until?: number): null {
    this.retryAt.set(key, until ?? this.now() + RETRY_MS)
    return null
  }

  /**
   * Run network work at most MAX_IN_FLIGHT at a time: a screenful of new authors queues up
   * instead of firing dozens of requests at once. Lookup and download take a slot each, one after
   * the other, never both at once (holding one while waiting for another could deadlock).
   */
  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_IN_FLIGHT) await new Promise<void>((r) => this.waiting.push(r))
    else this.active++
    try {
      return await fn()
    } finally {
      // Hand the slot straight to the next waiter, or free it.
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }

  private download(url: string): Promise<Download> {
    return this.limited(async () => {
      this.requests++
      try {
        const res = await (this.opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' })
        // A server error is no answer about this author; a 404 (or a page that is not an image) is.
        if (res.status >= 500 || res.status === 429) return 'failed'
        if (!res.ok) return 'missing'
        const type = res.headers.get('content-type') ?? 'image/png'
        if (!type.startsWith('image/')) return 'missing'
        return { body: Buffer.from(await res.arrayBuffer()), type }
      } catch {
        return 'failed'
      }
    })
  }
}
