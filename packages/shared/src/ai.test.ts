import { describe, expect, it } from 'vitest'
import { agentCommandLine, agentLabel } from './ai'

describe('agent presets', () => {
  it('names custom agents by their program, or their script when run through an interpreter', () => {
    expect(agentLabel('custom', '"/opt/node22/bin/node" "/home/me/my agent/fake-agent.mjs"')).toBe('fake-agent')
    expect(agentLabel('custom', 'npx -y @acme/agent-acp')).toBe('@acme/agent-acp'.split('/').pop())
    expect(agentLabel('custom', '/usr/local/bin/goose acp')).toBe('goose')
    expect(agentLabel('custom', '')).toBe('Custom agent')
    expect(agentLabel('claude', '')).toBe('Claude')
  })

  it('uses the preset command unless custom', () => {
    expect(agentCommandLine('claude', 'ignored')).toBe('npx -y @agentclientprotocol/claude-agent-acp')
    expect(agentCommandLine('custom', '  my-agent --acp ')).toBe('my-agent --acp')
  })
})
