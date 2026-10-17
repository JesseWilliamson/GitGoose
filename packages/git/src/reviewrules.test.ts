import { describe, expect, it } from 'vitest'
import { globToRegExp, parsePathInstructions, relevantGuidelines } from './reviewrules'

describe('review rules', () => {
  it('finds guideline files that cover the changed files, broadest first', () => {
    const all = ['CLAUDE.md', 'src/ui/AGENTS.md', 'docs/AGENTS.md', '.github/copilot-instructions.md', 'src/ui/Button.tsx', 'README.md']
    expect(relevantGuidelines(all, ['src/ui/Button.tsx'])).toEqual([
      { path: '.github/copilot-instructions.md', scope: '' },
      { path: 'CLAUDE.md', scope: '' },
      { path: 'src/ui/AGENTS.md', scope: 'src/ui' },
    ])
  })

  it('matches globs like CodeRabbit and .gitignore do', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('src/c.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('lib/c.ts')).toBe(false)
    expect(globToRegExp('*.md').test('docs/guide.md')).toBe(true)
    expect(globToRegExp('**/test/**').test('pkg/test/a.ts')).toBe(true)
  })

  it('reads path instructions from .coderabbit.yaml, and only those', () => {
    const yaml = [
      'language: en',
      'reviews:',
      '  profile: chill',
      '  path_instructions:',
      '    - path: "src/**/*.ts"',
      '      instructions: "Prefer early returns."',
      "    - path: '**/*.test.ts'",
      '      instructions: |',
      '        Tests must not hit the network.',
      '        Use the fixtures.',
      '    - path: docs/**',
      '      instructions: >',
      '        Plain words,',
      '        short sentences.',
      '  auto_review:',
      '    enabled: true',
    ].join('\n')
    expect(parsePathInstructions(yaml)).toEqual([
      { path: 'src/**/*.ts', instructions: 'Prefer early returns.' },
      { path: '**/*.test.ts', instructions: 'Tests must not hit the network.\nUse the fixtures.' },
      { path: 'docs/**', instructions: 'Plain words, short sentences.' },
    ])
    expect(parsePathInstructions('reviews:\n  profile: chill\n')).toEqual([])
  })
})
