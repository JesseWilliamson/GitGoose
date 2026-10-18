import { describe, expect, it } from 'vitest'
import { enclosingDefinition, findDefinitions } from './definitions'
import { identifierAt, parseGrep } from './grep'

const names = (path: string, text: string) => findDefinitions(path, text).map((d) => `${d.kind} ${d.name} ${d.line}-${d.endLine}`)

describe('definitions', () => {
  it('TypeScript: functions, arrows, classes with methods, types; braces in strings do not count', () => {
    const src = [
      'export async function load(id: string): Promise<void> {', // 1
      '  const s = "{ not a block"',
      '}',
      'export const add = (a: number, b: number) => a + b', // 4
      'export class Store {', // 5
      '  private items: string[] = []',
      '  get(key: string): string {', // 7
      '    if (key) {',
      '      return key',
      '    }',
      '    return ""',
      '  }',
      '}', // 13
      'export interface Item { id: string }', // 14
      'type Id = string', // 15
      'const LIMIT = 10', // 16
    ].join('\n')
    expect(names('a.ts', src)).toEqual([
      'function load 1-3', 'function add 4-4', 'class Store 5-13', 'method get 7-12',
      'interface Item 14-14', 'type Id 15-15', 'const LIMIT 16-16',
    ])
  })

  it('Python by indentation; Go and Rust; Ruby with end', () => {
    expect(names('m.py', 'class A:\n    def run(self):\n        pass\n\n    x = 1\n\ndef top():\n    return 1\nLIMIT = 3\n')).toEqual([
      'class A 1-5', 'method run 2-3', 'function top 7-8', 'const LIMIT 9-9',
    ])
    expect(names('m.go', 'type Server struct {\n\tport int\n}\n\nfunc (s *Server) Start() error {\n\treturn nil\n}\nfunc main() {}\n')).toEqual([
      'class Server 1-3', 'method Start 5-7', 'function main 8-8',
    ])
    expect(names('lib.rs', 'pub struct Point { x: i32 }\nimpl Point {\n    pub fn new() -> Self {\n        Point { x: 0 }\n    }\n}\n')).toEqual([
      'class Point 1-1', 'function new 3-5',
    ])
    expect(names('a.rb', 'class Dog\n  def bark\n    "woof"\n  end\nend\n')).toEqual(['class Dog 1-5', 'method bark 2-4'])
  })

  it('Java, C and unknown files', () => {
    expect(names('A.java', 'public class A {\n  private static int count(List<String> xs) {\n    return xs.size();\n  }\n}\n')).toEqual([
      'class A 1-5', 'method count 2-4',
    ])
    expect(names('a.c', '#define MAX 10\nstatic int add(int a, int b)\n{\n  return a + b;\n}\nint x = add(1, 2);\n')).toEqual([
      'const MAX 1-1', 'function add 2-5',
    ])
    expect(names('notes.txt', 'function looksLikeCode() {}')).toEqual([])
  })

  it('finds the innermost definition around a line', () => {
    const defs = findDefinitions('a.ts', 'class A {\n  m() {\n    x()\n  }\n}\n')
    expect(enclosingDefinition(defs, 3)?.name).toBe('m')
    expect(enclosingDefinition(defs, 5)?.name).toBe('A')
    expect(enclosingDefinition(defs, 9)).toBeNull()
  })
})

describe('grep and identifiers', () => {
  it('parses git grep -z output, with and without a revision', () => {
    expect(parseGrep('src/a.ts\x0012\x005\x00  load(id)\nb.ts\x001\x001\x00load\n')).toEqual([
      { path: 'src/a.ts', line: 12, column: 5, text: '  load(id)' },
      { path: 'b.ts', line: 1, column: 1, text: 'load' },
    ])
    expect(parseGrep('HEAD:src/a.ts\x003\x001\x00x\n', 'HEAD')[0]!.path).toBe('src/a.ts')
  })

  it('finds the identifier under a position', () => {
    const t = 'const total = price * count'
    expect(identifierAt(t, 15)).toBe('price')
    expect(identifierAt(t, 19)).toBe('price') // just after the word
    expect(identifierAt(t, 21)).toBeNull()
    expect(identifierAt('x = 42', 4)).toBeNull()
  })
})
