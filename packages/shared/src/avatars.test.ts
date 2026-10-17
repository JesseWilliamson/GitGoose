import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { avatarUrl, githubNoreplyId } from './avatars'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('avatar sources', () => {
  it('maps GitHub noreply addresses to avatar ids without any API call', () => {
    expect(githubNoreplyId('583231+octocat@users.noreply.github.com')).toBe('583231')
    expect(githubNoreplyId('octocat@users.noreply.github.com')).toBeNull()
    expect(avatarUrl('583231+octocat@users.noreply.github.com', 'github', sha)).toBe('https://avatars.githubusercontent.com/u/583231?s=64&v=4')
    expect(avatarUrl('ada@example.com', 'github', sha)).toBeNull()
  })

  it('hashes trimmed, lower-cased emails for Gravatar and asks for a 404 instead of a placeholder', () => {
    expect(avatarUrl(' Ada@Example.com ', 'gravatar', sha)).toBe(`https://gravatar.com/avatar/${sha('ada@example.com')}?s=64&d=404`)
  })

  it('initials means no network at all', () => {
    expect(avatarUrl('583231+octocat@users.noreply.github.com', 'initials', sha)).toBeNull()
  })
})
