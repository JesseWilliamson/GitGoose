import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { Encryption } from '../github/tokenStore'

/**
 * One secret (the Anthropic API key) encrypted with the OS keychain, like the GitHub token
 * (github/tokenStore.ts, same rules): without a real keychain it lives in memory only.
 */
export class SecretFile {
  private memory: string | null = null
  private loaded = false

  constructor(private file: string, private enc: Encryption) {}

  get(): string | null {
    if (this.memory !== null || this.loaded) return this.memory
    this.loaded = true
    try {
      if (this.enc.secure()) this.memory = this.enc.decrypt(readFileSync(this.file))
    } catch {
      this.memory = null
    }
    return this.memory
  }

  /** Returns whether the secret will survive a restart. */
  set(value: string | null): { persisted: boolean } {
    this.memory = value
    this.loaded = true
    if (value === null || !this.enc.secure()) {
      rmSync(this.file, { force: true })
      return { persisted: value === null }
    }
    writeFileSync(`${this.file}.tmp`, this.enc.encrypt(value), { mode: 0o600 })
    renameSync(`${this.file}.tmp`, this.file)
    return { persisted: true }
  }

  persisted(): boolean {
    return this.enc.secure()
  }
}
