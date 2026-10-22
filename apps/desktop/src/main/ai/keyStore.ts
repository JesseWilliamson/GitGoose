import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/** The OS keychain (Electron's safeStorage in the app, a fake in tests). */
export interface Encryption {
  /** True only when a real OS keychain backs the encryption. */
  secure(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

/**
 * One secret (the Anthropic API key) encrypted with the OS keychain (Keychain on macOS, DPAPI on
 * Windows, libsecret/kwallet on Linux), in a file in the profile. Without a real keychain (a
 * Linux box without a secret service, where Electron would fall back to a hard-coded key) it
 * lives in memory only: kept until quit, never written to disk in a form anyone could decrypt.
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
