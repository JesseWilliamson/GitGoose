import { initRepo, tempDir } from '@gitsquid/fixtures'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Repo } from './repo'

// Never touch the real ~/.gitconfig: global config goes to a throwaway file.
const globalFile = join(tempDir('gitsquid-global-'), 'gitconfig')
const saved = process.env.GIT_CONFIG_GLOBAL
beforeAll(() => {
  writeFileSync(globalFile, '[user]\n\tname = Global Person\n\temail = global@example.com\n')
  process.env.GIT_CONFIG_GLOBAL = globalFile
})
afterAll(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = saved
})

describe('identity, templates, co-authors, hooks', () => {
  it('reports where the identity comes from and changes it per repository or globally, undoably', async () => {
    const r = initRepo() // sets a local identity (Ada)
    r.commit('root')
    const repo = await Repo.open(r.dir, {})
    expect(await repo.identity()).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com', scope: 'local', global: { name: 'Global Person', email: 'global@example.com' } })

    const cleared = await repo.setIdentity('local', null, null)
    expect(await repo.identity()).toMatchObject({ name: 'Global Person', scope: 'global' })
    await repo.undo(cleared)
    expect((await repo.identity()).name).toBe('Ada Lovelace')

    const g = await repo.setIdentity('global', 'New Global', 'new@example.com')
    expect((await repo.identity()).global).toEqual({ name: 'New Global', email: 'new@example.com' })
    await repo.undo(g)
    expect((await repo.identity()).global.name).toBe('Global Person')
    repo.dispose()
  })

  it('reads the commit template and suggests recent authors, most active first', async () => {
    const r = initRepo()
    r.commit('one')
    r.git('commit', '-q', '--allow-empty', '-m', 'by grace', '--author=Grace Hopper <grace@example.com>')
    r.commit('two')
    writeFileSync(join(r.dir, '.gitmessage'), 'feat: \n\n# Why this change?\n')
    r.git('config', 'commit.template', '.gitmessage')
    const repo = await Repo.open(r.dir, {})
    expect(await repo.commitTemplate()).toBe('feat: \n\n# Why this change?\n')
    expect(await repo.recentAuthors()).toEqual([{ name: 'Ada Lovelace', email: 'ada@example.com' }, { name: 'Grace Hopper', email: 'grace@example.com' }])
    repo.dispose()
  })

  it('skips hooks only when asked', async () => {
    const r = initRepo()
    r.commit('root')
    writeFileSync(join(r.dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho "lint failed: a.txt" >&2\nexit 1\n', { mode: 0o755 })
    r.write('a.txt', 'a\n')
    r.git('add', 'a.txt')
    const repo = await Repo.open(r.dir, {})
    await expect(repo.commit('blocked\n')).rejects.toThrow(/lint failed/)
    await repo.commit('allowed\n', { noVerify: true })
    expect(r.git('log', '-1', '--format=%s').trim()).toBe('allowed')
    repo.dispose()
  })
})
