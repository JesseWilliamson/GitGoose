import { initRepo } from '@gitsquid/fixtures'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Repo } from './repo'

// Local clones of submodules need protocol.file.allow (off by default since git 2.38.1).
const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' }
beforeAll(() => Object.assign(process.env, env))
afterAll(() => { for (const k of Object.keys(env)) delete process.env[k] })

function setup() {
  const lib = initRepo()
  const libHead = lib.commit('lib', { 'lib.txt': 'lib\n' })
  const app = initRepo()
  app.commit('root', { 'app.txt': 'app\n' })
  return { lib, libHead, app }
}

describe('submodules', () => {
  it('adds one (undo deletes it), reports its state, removes it (undo brings it back)', async () => {
    const { lib, libHead, app } = setup()
    const repo = await Repo.open(app.dir, {})
    expect(await repo.submodules()).toEqual([])

    const add = await repo.addSubmodule(lib.dir, 'vendor/lib')
    expect(await repo.submodules()).toEqual([{ name: 'vendor/lib', path: 'vendor/lib', url: lib.dir, recorded: libHead, checkedOut: libHead, dirty: false }])
    await repo.undo(add)
    expect(existsSync(join(app.dir, 'vendor/lib'))).toBe(false)
    expect(existsSync(join(app.dir, '.gitmodules'))).toBe(false)
    expect(app.git('status', '--porcelain')).toBe('')

    await repo.addSubmodule(lib.dir, 'vendor/lib')
    app.git('commit', '-q', '-m', 'add lib')
    writeFileSync(join(app.dir, 'vendor/lib/lib.txt'), 'edited\n')
    expect((await repo.submodules())[0]!.dirty).toBe(true)
    await expect(repo.removeSubmodule('vendor/lib')).rejects.toThrow()
    app.git('-C', 'vendor/lib', 'checkout', '--', 'lib.txt')

    const rm = await repo.removeSubmodule('vendor/lib')
    expect(await repo.submodules()).toEqual([])
    await repo.undo(rm)
    expect((await repo.submodules())[0]).toMatchObject({ checkedOut: libHead, dirty: false })
    // Inside first, so a failure names the file that differs.
    expect(app.git('-C', 'vendor/lib', 'status', '--porcelain', '--ignored')).toBe('')
    expect(app.git('status', '--porcelain')).toBe('')
    repo.dispose()
  })

  it('initializes submodules of a fresh clone; undo of add refuses once it has new commits', async () => {
    const { lib, libHead, app } = setup()
    const repo = await Repo.open(app.dir, {})
    const add = await repo.addSubmodule(lib.dir, 'lib')
    app.git('-C', 'lib', 'commit', '-q', '--allow-empty', '-m', 'work inside')
    await expect(repo.undo(add)).rejects.toThrow(/new commits or changes/)
    app.git('-C', 'lib', 'reset', '-q', '--hard', libHead)
    app.git('commit', '-q', '-m', 'add lib')

    const clone = initRepo()
    clone.git('fetch', '-q', app.dir, 'main')
    clone.git('reset', '-q', '--hard', 'FETCH_HEAD')
    const c = await Repo.open(clone.dir, {})
    expect((await c.submodules())[0]!.checkedOut).toBeUndefined()
    await c.updateSubmodules()
    expect((await c.submodules())[0]!.checkedOut).toBe(libHead)
    c.dispose()
    repo.dispose()
  })
})
