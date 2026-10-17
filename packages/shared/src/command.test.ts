import { describe, expect, it } from 'vitest'
import { commandArgv } from './command'

describe('commandArgv', () => {
  it('fills placeholders without splitting values that contain spaces', () => {
    expect(commandArgv('code --goto {file}:{line}', { file: '/a b/c.ts', line: '12' }, 'file'))
      .toEqual(['code', '--goto', '/a b/c.ts:12'])
  })
  it('respects quotes in the template and appends the file when there is no placeholder', () => {
    expect(commandArgv('"/Applications/My Editor.app/bin/ed" -w', { file: '/x.ts' }, 'file'))
      .toEqual(['/Applications/My Editor.app/bin/ed', '-w', '/x.ts'])
  })
  it('keeps unknown placeholders as written', () => {
    expect(commandArgv('term --dir {dir} {other}', { dir: '/r' })).toEqual(['term', '--dir', '/r', '{other}'])
  })
})
