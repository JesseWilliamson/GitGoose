import { describe, expect, it } from 'vitest'
import { CodeParser } from './extract'
import { grammarFiles, grammarOf, nodeLocator } from './grammars'

const parser = new CodeParser()
const symbols = async (path: string, text: string) => (await parser.parse(path, text))!.symbols.map((s) => `${s.kind} ${s.name} ${s.line}-${s.endLine}${s.parent ? ` in ${s.parent}` : ''}`)
const refs = async (path: string, text: string) => (await parser.parse(path, text))!.refs.map((r) => `${r.kind} ${r.name} ${r.line}:${r.column}${r.within ? ` within ${r.within}` : ''}`)

describe('grammars', () => {
  it('every grammar file resolves on disk', () => {
    const locate = nodeLocator()
    for (const f of grammarFiles()) expect(() => locate(f)).not.toThrow()
    expect(grammarFiles().length).toBeGreaterThan(13)
  })

  it('picks a grammar by extension', () => {
    expect(grammarOf('a/b.ts')).toBe('typescript')
    expect(grammarOf('a/b.tsx')).toBe('tsx')
    expect(grammarOf('a/b.jsx')).toBe('tsx')
    expect(grammarOf('x.swift')).toBeNull()
    expect(grammarOf('Makefile')).toBeNull()
  })
})

describe('extract', () => {
  it('TypeScript: functions, classes with methods, interfaces; calls, types, imports', async () => {
    const src = [
      "import { total, type Cart } from './price'", // 1
      'export async function load(id: string): Promise<Cart> {', // 2
      '  return total(id)',
      '}',
      'export const add = (a: number, b: number) => a + b', // 5
      'export class Store {', // 6
      '  get(key: string): string {', // 7
      '    return load(key)',
      '  }',
      '}', // 10
      'export interface Item { id: string }', // 11
      'new Store().get("a")', // 12
    ].join('\n')
    expect(await symbols('a.ts', src)).toEqual([
      'function load 2-4', 'function add 5-5', 'class Store 6-10', 'method get 7-9 in Store', 'interface Item 11-11',
    ])
    expect(await refs('a.ts', src)).toEqual([
      'import total 1:10', 'import Cart 1:22', 'type Cart 2:49 within function load', 'call total 3:10 within function load',
      'call load 8:12 within method get', 'class Store 12:5', 'call get 12:13',
    ])
  })

  it('a function inside a class is a method; nesting resolves to the innermost definition', async () => {
    const out = await parser.parse('m.py', 'class A:\n    def run(self):\n        helper()\n\ndef helper():\n    pass\n')
    expect(out!.symbols.map((s) => `${s.kind} ${s.name}`)).toEqual(['class A', 'method run', 'function helper'])
    expect(out!.refs).toEqual([{ name: 'helper', kind: 'call', line: 3, column: 9, within: 'method run' }])
  })

  it('parses a snippet in every other grammar', async () => {
    const cases: [string, string, string[]][] = [
      ['m.js', 'function f() { g() }\nclass K { m() {} }\n', ['function f', 'class K', 'method m']],
      ['m.go', 'type S struct{}\nfunc (s *S) Start() error { return run() }\nfunc run() error { return nil }\n', ['type S', 'method Start', 'function run']],
      ['m.rs', 'pub struct P { x: i32 }\nimpl P {\n    pub fn new() -> Self { P { x: 0 } }\n}\nfn main() { P::new(); }\n', ['class P', 'method new', 'function main']],
      ['M.java', 'public class M {\n  void run() { helper(); }\n  void helper() {}\n}\n', ['class M', 'method run', 'method helper']],
      ['m.kt', 'class Store {\n  fun get(k: String) = load(k)\n}\nfun load(id: String) = id\n', ['class Store', 'method get', 'function load']],
      ['M.cs', 'class M {\n  void Run() { Helper(); }\n  void Helper() {}\n}\n', ['class M', 'method Run', 'method Helper']],
      ['m.c', 'struct P { int x; };\nint run(void) { return helper(); }\nint helper(void) { return 1; }\n', ['class P', 'function run', 'function helper']],
      ['m.cpp', 'class P {\n public:\n  int run() { return helper(); }\n};\nint helper() { return 1; }\n', ['class P', 'method run', 'function helper']],
      ['m.rb', 'class Store\n  def get(k)\n    load(k)\n  end\nend\ndef load(id)\n  id\nend\n', ['class Store', 'method get', 'method load']],
      ['m.php', '<?php\nclass Store {\n  function get($k) { return load($k); }\n}\nfunction load($id) { return $id; }\n', ['class Store', 'method get', 'function load']],
    ]
    for (const [path, src, want] of cases) {
      const out = await parser.parse(path, src)
      expect(out, path).not.toBeNull()
      expect(out!.symbols.map((s) => `${s.kind} ${s.name}`), path).toEqual(want)
      expect(out!.refs.some((r) => r.kind === 'call'), `${path} finds a call`).toBe(true)
    }
  })

  it('returns null for files without a grammar or too big to be code', async () => {
    expect(await parser.parse('a.swift', 'func f() {}')).toBeNull()
    expect(await parser.parse('big.ts', 'x'.repeat(1_000_001))).toBeNull()
  })
})
