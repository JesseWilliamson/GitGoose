// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { validateMermaid } from './mermaid'

describe('validateMermaid', () => {
  it('accepts diagrams Mermaid can parse, whatever the kind', async () => {
    expect(await validateMermaid('sequenceDiagram\n  Caller->>total: total(a, b)\n  total-->>Caller: a + b')).toEqual({ ok: true })
    expect(await validateMermaid('stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy: start')).toEqual({ ok: true })
    expect(await validateMermaid('flowchart LR\n  A[UI] --> B[(DB)]')).toEqual({ ok: true })
  })

  it('reports the parser\'s message instead of throwing', async () => {
    const bad = await validateMermaid('sequenceDiagram\n  A->>>B hi ???')
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.message).toContain('Parse error on line 2')
    const unknown = await validateMermaid('not a diagram')
    expect(!unknown.ok && unknown.message).toContain('No diagram type detected')
  })
})
