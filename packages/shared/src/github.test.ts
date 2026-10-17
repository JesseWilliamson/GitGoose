import { describe, expect, it } from 'vitest'
import { githubPromptKind, parseGitHubRemote } from './github'

describe('parseGitHubRemote', () => {
  it('reads the URL forms git accepts', () => {
    for (const url of [
      'https://github.com/acme/widgets.git',
      'https://github.com/acme/widgets',
      'https://user@github.com/acme/widgets.git',
      'git@github.com:acme/widgets.git',
      'git@github.com:acme/widgets',
      'ssh://git@github.com/acme/widgets.git',
      'ssh://git@github.com:22/acme/widgets',
      'git://github.com/acme/widgets.git',
    ]) expect(parseGitHubRemote(url), url).toEqual({ owner: 'acme', repo: 'widgets' })
    expect(parseGitHubRemote('https://github.com/acme/my.repo.git')).toEqual({ owner: 'acme', repo: 'my.repo' })
  })

  it('rejects other hosts and lookalikes', () => {
    for (const url of [
      'https://gitlab.com/acme/widgets.git',
      'https://github.com.evil.example/acme/widgets',
      'https://evilgithub.com/acme/widgets',
      'git@github.example.com:acme/widgets.git',
      'https://github.com/acme',
      '/home/me/widgets',
      'https://github.com/acme/widgets/tree/main',
    ]) expect(parseGitHubRemote(url), url).toBeNull()
  })
})

describe('githubPromptKind', () => {
  it('recognises git prompts for github.com only', () => {
    expect(githubPromptKind("Username for 'https://github.com': ")).toBe('username')
    expect(githubPromptKind("Password for 'https://octocat@github.com': ")).toBe('password')
    expect(githubPromptKind("Password for 'https://github.com.evil.example': ")).toBeNull()
    expect(githubPromptKind("Password for 'http://github.com': ")).toBeNull()
    expect(githubPromptKind("Password for 'https://gitlab.com': ")).toBeNull()
    expect(githubPromptKind("Enter passphrase for key '/home/me/.ssh/id_ed25519': ")).toBeNull()
    expect(githubPromptKind("Password for 'https://x@github.com@evil.example': ")).toBeNull()
  })
})
