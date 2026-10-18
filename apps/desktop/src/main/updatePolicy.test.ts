import { describe, expect, it } from 'vitest'
import { shouldCheckForUpdates } from './updatePolicy'

const release = { packaged: true, version: '0.2.0', disabledByEnv: false, enabled: true }

describe('shouldCheckForUpdates', () => {
  it('checks in an installed release', () => {
    expect(shouldCheckForUpdates(release)).toBe(true)
  })

  it('skips local builds, which a release would overwrite', () => {
    expect(shouldCheckForUpdates({ ...release, version: '0.2.0-dev.1a2b3c4' })).toBe(false)
  })

  it('still checks prereleases that are not local builds', () => {
    expect(shouldCheckForUpdates({ ...release, version: '0.3.0-beta.1' })).toBe(true)
  })

  it('skips unpackaged runs and respects the setting and GITGOOSE_NO_UPDATE', () => {
    expect(shouldCheckForUpdates({ ...release, packaged: false })).toBe(false)
    expect(shouldCheckForUpdates({ ...release, enabled: false })).toBe(false)
    expect(shouldCheckForUpdates({ ...release, disabledByEnv: true })).toBe(false)
  })
})
