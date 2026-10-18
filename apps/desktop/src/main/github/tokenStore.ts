import type { GitHubAccount } from '@gitgoose/shared'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * Where the GitHub token lives: encrypted by the OS keychain (Electron's safeStorage: Keychain on
 * macOS, DPAPI on Windows, libsecret/kwallet on Linux), in a file in the profile. The account
 * (login, name, avatar) is not secret and sits next to it in clear.
 *
 * If there is no real keychain (a Linux box without a secret service, where Electron would fall
 * back to a hard-coded key), the token is kept in memory only: signed in until quit, never
 * written to disk in a form anyone could decrypt.
 *
 * Plain Node: the encryption is passed in, so tests use a fake.
 */

export interface Encryption {
  /** True only when a real OS keychain backs the encryption. */
  secure(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

interface Stored {
  account: GitHubAccount
  token: string
}

export class TokenStore {
  private memory: Stored | null = null

  constructor(private file: string, private enc: Encryption) {}

  load(): Stored | null {
    if (this.memory) return this.memory
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { account: GitHubAccount; token: string }
      if (!this.enc.secure()) return null
      this.memory = { account: raw.account, token: this.enc.decrypt(Buffer.from(raw.token, 'base64')) }
      return this.memory
    } catch {
      return null
    }
  }

  /** Returns whether the sign-in will survive a restart. */
  save(account: GitHubAccount, token: string): { persisted: boolean } {
    this.memory = { account, token }
    if (!this.enc.secure()) {
      this.removeFile()
      return { persisted: false }
    }
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ account, token: this.enc.encrypt(token).toString('base64') }), { mode: 0o600 })
    renameSync(tmp, this.file)
    return { persisted: true }
  }

  clear(): void {
    this.memory = null
    this.removeFile()
  }

  private removeFile() {
    rmSync(this.file, { force: true })
  }
}
