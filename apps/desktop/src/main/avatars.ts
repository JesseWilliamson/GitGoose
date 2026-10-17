import { avatarUrl, type AvatarBases, type AvatarSource } from '@gitsquid/shared'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Author avatars, fetched and cached by the main process.
 *
 * The renderer never talks to the network: its Content-Security-Policy only allows images from
 * the app itself and from the `gitsquid-avatar:` scheme, which this class answers. It asks for
 * an author by email; we look in a disk cache, fetch on a miss, and remember misses too, so an
 * author without an avatar is not looked up again on every scroll.
 *
 * Plain Node (no Electron imports), so it is unit-tested directly.
 */

const TTL_MS = 30 * 24 * 3600 * 1000
const MISS_TTL_MS = 24 * 3600 * 1000
const TIMEOUT_MS = 3000
const MAX_IN_FLIGHT = 4

/** A 1x1 transparent PNG: what a miss serves, so the initials underneath show through. */
export const TRANSPARENT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

export interface AvatarImage {
  body: Buffer
  type: string
}

export interface AvatarCacheOptions {
  dir: string
  source: () => AvatarSource
  bases?: AvatarBases
  /** Extra lookup for authors the URL rules cannot resolve (signed-in GitHub, see github.ts). */
  resolve?: (email: string) => Promise<string | null>
  fetch?: typeof fetch
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export class AvatarCache {
  private inFlight = new Map<string, Promise<AvatarImage>>()
  private active = 0
  private waiting: (() => void)[] = []
  /** How many network requests were made (tests use it to prove "no network" really means none). */
  requests = 0

  constructor(private opts: AvatarCacheOptions) {}

  async get(email: string): Promise<AvatarImage> {
    const source = this.opts.source()
    if (source === 'initials') return { body: TRANSPARENT_PNG, type: 'image/png' }
    const key = `${source}-${sha256(email.trim().toLowerCase())}`
    // Concurrent requests for the same author share one lookup.
    let p = this.inFlight.get(key)
    if (!p) {
      p = this.lookup(key, email, source).finally(() => this.inFlight.delete(key))
      this.inFlight.set(key, p)
    }
    return p
  }

  private async lookup(key: string, email: string, source: AvatarSource): Promise<AvatarImage> {
    const file = join(this.opts.dir, key)
    const fresh = async (path: string, ttl: number) => {
      try {
        return Date.now() - (await stat(path)).mtimeMs < ttl
      } catch {
        return false
      }
    }
    if (await fresh(file + '.img', TTL_MS)) {
      const body = await readFile(file + '.img')
      const type = (await readFile(file + '.type', 'utf8').catch(() => 'image/png')) || 'image/png'
      return { body, type }
    }
    if (await fresh(file + '.miss', MISS_TTL_MS)) return { body: TRANSPARENT_PNG, type: 'image/png' }

    let url = avatarUrl(email, source, sha256, this.opts.bases)
    if (!url && this.opts.resolve) url = await this.opts.resolve(email).catch(() => null)
    const got = url ? await this.download(url) : null
    await mkdir(this.opts.dir, { recursive: true })
    if (!got) {
      await writeFile(file + '.miss', '')
      return { body: TRANSPARENT_PNG, type: 'image/png' }
    }
    await writeFile(file + '.img', got.body)
    await writeFile(file + '.type', got.type)
    return got
  }

  private async download(url: string): Promise<AvatarImage | null> {
    if (this.active >= MAX_IN_FLIGHT) await new Promise<void>((r) => this.waiting.push(r))
    this.active++
    this.requests++
    try {
      const res = await (this.opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' })
      if (!res.ok) return null
      const type = res.headers.get('content-type') ?? 'image/png'
      if (!type.startsWith('image/')) return null
      return { body: Buffer.from(await res.arrayBuffer()), type }
    } catch {
      return null
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}
