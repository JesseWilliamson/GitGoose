import type { Ref } from '@gitgoose/shared'
import { describe, expect, it } from 'vitest'
import { refShown } from './graphFilter'

const ref = (kind: 'local' | 'remote', shortName: string): Ref =>
  ({ kind, shortName, name: kind === 'local' ? `refs/heads/${shortName}` : `refs/remotes/${shortName}`, hash: 'a' }) as Ref

describe('refShown', () => {
  it('hides by name or by whole remote, never HEAD', () => {
    const filter = { hidden: ['refs/heads/wip', 'refs/remotes/fork/*'], solo: [] }
    expect(refShown(ref('local', 'wip'), filter, 'main')).toBe(false)
    expect(refShown(ref('remote', 'fork/topic'), filter, 'main')).toBe(false)
    expect(refShown(ref('remote', 'origin/topic'), filter, 'main')).toBe(true)
    expect(refShown(ref('local', 'wip'), filter, 'wip')).toBe(true)
  })

  it('shows only soloed branches (and HEAD) while anything is soloed', () => {
    const filter = { hidden: [], solo: ['refs/heads/topic'] }
    expect(refShown(ref('local', 'topic'), filter, 'main')).toBe(true)
    expect(refShown(ref('local', 'other'), filter, 'main')).toBe(false)
    expect(refShown(ref('local', 'main'), filter, 'main')).toBe(true)
  })
})
