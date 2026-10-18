import { describe, expect, it } from 'vitest'
import { isLocalBuild, localBuildVersion } from './version'

describe('local build versions', () => {
  it('stamps the commit, and marks uncommitted changes', () => {
    expect(localBuildVersion('0.2.0', '1a2b3c4', false)).toBe('0.2.0-dev.1a2b3c4')
    expect(localBuildVersion('0.2.0', '1a2b3c4', true)).toBe('0.2.0-dev.1a2b3c4.dirty')
  })

  it('recognises what it stamps, and nothing else', () => {
    expect(isLocalBuild(localBuildVersion('0.2.0', '1a2b3c4', false))).toBe(true)
    expect(isLocalBuild(localBuildVersion('0.2.0', '1a2b3c4', true))).toBe(true)
    expect(isLocalBuild('0.2.0')).toBe(false)
    expect(isLocalBuild('0.3.0-beta.1')).toBe(false)
  })
})
