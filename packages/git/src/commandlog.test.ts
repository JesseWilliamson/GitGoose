import { initRepo } from '@gitgoose/fixtures'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'
import { maskCredentials } from './runner'

describe('command log', () => {
  it('masks credentials in URLs', () => {
    expect(maskCredentials('https://ada:ghp_secret@github.com/o/r.git')).toBe('https://***@github.com/o/r.git')
    expect(maskCredentials('git@github.com:o/r.git')).toBe('git@github.com:o/r.git')
  })

  it('records every git command with its result, newest first, failures with stderr', async () => {
    const r = initRepo()
    r.commit('root', { 'a.txt': 'a\n' })
    const repo = await Repo.open(r.dir, {})
    await repo.snapshot()
    await repo.createBranch('topic', {})
    await expect(repo.createBranch('topic', {})).rejects.toThrow()
    await repo.addRemote('origin', 'https://ada:secret@example.com/r.git')
    const log = repo.commandLog()
    const add = log.find((c) => c.args[0] === 'remote')!
    expect(add.args).toEqual(['remote', 'add', 'origin', 'https://***@example.com/r.git'])
    const failed = log.find((c) => c.args[0] === 'branch' && c.code !== 0)!
    expect(failed.stderr).toContain('already exists')
    expect(failed.durationMs).toBeGreaterThanOrEqual(0)
    expect(log.some((c) => c.args[0] === 'status' && c.readOnly)).toBe(true)
    // Newest first, and asking for what is newer than an id gives only that.
    expect(log[0]!.id).toBeGreaterThan(log[log.length - 1]!.id)
    await repo.snapshot()
    expect(repo.commandLog(log[0]!.id).every((c) => c.id > log[0]!.id)).toBe(true)
    repo.dispose()
  })
})
