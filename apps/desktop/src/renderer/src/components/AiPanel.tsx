import type { AgentInfo, AiStatus } from '@gitgoose/shared'
import { CheckCircle2, CircleAlert, KeyRound, PlugZap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, toUiError } from '../lib/api'
import { useSetting } from '../lib/store'
import { ModelPicker } from './ModelPicker'
import { PromptSettings } from './PromptPanel'
import { Button, Spinner } from './ui'

/**
 * Settings → AI, above the generated rows: test the agent, or store an API key. Testing starts
 * the agent (the user clicked, so that is fine); nothing else here talks to anything.
 */
export function AiPanel() {
  const provider = useSetting('aiProvider')
  const agent = useSetting('aiAgent')
  const command = useSetting('aiAgentCommand')
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [test, setTest] = useState<{ busy: boolean; info?: AgentInfo; error?: string } | null>(null)
  const [key, setKey] = useState('')

  useEffect(() => {
    void api.aiStatus().then(setStatus)
    setTest(null)
  }, [provider, agent, command])

  if (provider === 'off' || !status) return null

  const runTest = async () => {
    setTest({ busy: true })
    try {
      setTest({ busy: false, info: await api.aiAgentInfo() })
    } catch (e) {
      setTest({ busy: false, error: toUiError(e).message })
    }
  }

  return (
    <div className="mb-3 rounded-md border border-line p-3 text-[13px]" data-testid="ai-panel">
      {provider === 'agent' ? (
        <>
          <div className="flex items-center gap-2">
            <PlugZap size={16} className="text-muted" />
            <span className="flex-1">
              GitGoose talks to <b>{status.label}</b> over the Agent Client Protocol. The agent keeps its own login.
            </span>
            <Button size="sm" onClick={() => void runTest()} disabled={test?.busy || !status.ready} data-testid="ai-test">
              {test?.busy ? <Spinner /> : null} Test
            </Button>
          </div>
          {test?.info && (
            <div className="mt-2 flex items-start gap-1.5 text-xs text-add" data-testid="ai-test-result">
              <CheckCircle2 size={13} className="mt-px shrink-0" />
              <span>
                {test.info.name}{test.info.version ? ` ${test.info.version}` : ''} answered (protocol v{test.info.protocolVersion}).
                {test.info.authMethods.length ? ` Login methods: ${test.info.authMethods.map((m) => m.name).join(', ')}.` : ''}
              </span>
            </div>
          )}
          {test?.error && (
            <pre className="selectable mt-2 max-h-32 overflow-auto rounded bg-bg p-2 text-[11px] whitespace-pre-wrap text-del" data-testid="ai-test-error">{test.error}</pre>
          )}
          <DefaultModel />
          <PromptSettings />
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <KeyRound size={16} className="text-muted" />
            <span className="flex-1">
              {status.hasApiKey ? 'An Anthropic API key is saved.' : 'Paste an Anthropic API key (console.anthropic.com → API keys).'}
            </span>
            {status.hasApiKey && <Button size="sm" onClick={() => void api.aiSetApiKey(null).then(setStatus)}>Remove</Button>}
          </div>
          {!status.hasApiKey && (
            <form className="mt-2 flex gap-2" onSubmit={(e) => {
              e.preventDefault()
              void api.aiSetApiKey(key).then((s) => {
                setStatus(s)
                setKey('')
              })
            }}>
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" autoComplete="off" spellCheck={false}
                data-testid="ai-api-key" className="h-7 flex-1 rounded-md border border-line bg-bg px-2 font-mono text-[12px] outline-none focus:border-accent" />
              <Button size="sm" variant="primary" type="submit" disabled={!key.trim()}>Save</Button>
            </form>
          )}
          {status.keyInMemoryOnly && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-warn">
              <CircleAlert size={13} className="mt-px shrink-0" /> No system keychain was found: the key is kept until GitGoose quits.
            </p>
          )}
          <p className="mt-2 text-xs text-faint">Text features only: resolving conflicts needs an agent, because it edits a file.</p>
          {status.hasApiKey && <DefaultModel />}
          <PromptSettings />
        </>
      )}
    </div>
  )
}

/** The default model; each AI area has the same picker and can choose differently. */
function DefaultModel() {
  return (
    <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
      <span className="flex-1">
        Default model
        <span className="block text-xs text-faint">Every AI area (Recompose, Review, chats, …) starts with this, and has its own picker to use another agent or model.</span>
      </span>
      <ModelPicker defaults />
    </div>
  )
}
