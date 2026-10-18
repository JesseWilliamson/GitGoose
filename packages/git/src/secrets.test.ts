import { describe, expect, it } from 'vitest'
import { entropy, lineAt, redactSecrets, scanSecrets } from './secrets'

// Built by concatenation so this file does not trip secret scanners itself.
const GH = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE'
const KEY = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA', '-----END OPENSSH PRIVATE KEY-----'].join('\n')

describe('secret scan', () => {
  it('finds credentials by shape, masked', () => {
    const text = `const token = "${GH}"\naws = ${AWS}\n${KEY}\n`
    const hits = scanSecrets(text)
    expect(hits.map((h) => h.kind)).toEqual(['GitHub token', 'AWS access key', 'private key'])
    expect(hits[0]!.masked).toBe('ghp_…R8 (40 chars)')
    expect(lineAt(text, hits[1]!.index)).toBe(2)
  })

  it('flags random-looking assigned passwords, not placeholders or words', () => {
    expect(scanSecrets('password = "hunter2hunter2"')).toEqual([]) // low entropy
    expect(scanSecrets('db_password: "${DB_PASSWORD}"')).toEqual([])
    expect(scanSecrets('apiKey = "changeme-please"')).toEqual([])
    expect(scanSecrets('client_secret = "q8Zt3vK1pR9xW2mN7bL4"').map((h) => h.kind)).toEqual(['hard-coded client_secret'])
    expect(entropy('aaaaaaaa')).toBe(0)
  })

  it('redacts, saying what was removed', () => {
    expect(redactSecrets(`use ${GH} here`)).toEqual({ text: 'use [REDACTED GitHub token] here', count: 1 })
    expect(redactSecrets('nothing secret')).toEqual({ text: 'nothing secret', count: 0 })
  })
})
