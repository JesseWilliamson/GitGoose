import { describe, expect, it } from 'vitest'
import { githubNoreplyId, noreplyAvatarUrl } from './avatars'

describe('noreply avatars', () => {
  it('maps GitHub noreply addresses to avatar ids without any API call', () => {
    expect(githubNoreplyId('583231+octocat@users.noreply.github.com')).toBe('583231')
    expect(githubNoreplyId('octocat@users.noreply.github.com')).toBeNull()
    expect(noreplyAvatarUrl(' 583231+OctoCat@Users.Noreply.GitHub.com ')).toBe('https://avatars.githubusercontent.com/u/583231?s=64&v=4')
    expect(noreplyAvatarUrl('583231+octocat@users.noreply.github.com', 'http://127.0.0.1:9')).toBe('http://127.0.0.1:9/u/583231?s=64&v=4')
  })

  it('has no URL for other addresses', () => {
    expect(noreplyAvatarUrl('ada@example.com')).toBeNull()
    expect(noreplyAvatarUrl('583231+octocat@users.noreply.github.com.evil.example')).toBeNull()
  })
})
