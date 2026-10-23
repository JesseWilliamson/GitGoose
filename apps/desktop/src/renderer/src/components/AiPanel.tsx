import type { AgentInfo, AiStatus } from '@gitgoose/shared'
import { CheckCircle2, CircleAlert, KeyRound, PlugZap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, toUiError } from '../lib/api'
import { useSetting } from '../lib/store'
import { ModelPicker } from './ModelPicker'
import { PromptSettings } from './PromptPanel'
import { Input } from '@/components/ui/input'
import { SettingsRow } from './SettingsRow'
import { Button, Spinner } from './ui'

/**
 * Settings → AI, below the generated rows: test the agent, or store an API key. Testing starts
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
    <div data-testid="ai-panel">
      {provider === 'agent' ? (
        <>
          <SettingsRow label="Test" testid="setting-aiTest"
            description={
              <>
                GitGoose talks to <b>{status.label}</b> over the Agent Client Protocol. The agent keeps its own login.
                {test?.info && (
                  <span className="mt-1 flex items-start gap-1.5 text-add" data-testid="ai-test-result">
                    <CheckCircle2 size={13} className="mt-px shrink-0" />
                    <span>
                      {test.info.name}{test.info.version ? ` ${test.info.version}` : ''} answered (protocol v{test.info.protocolVersion}).
                      {test.info.authMethods.length ? ` Login methods: ${test.info.authMethods.map((m) => m.name).join(', ')}.` : ''}
                    </span>
                  </span>
                )}
                {test?.error && (
                  <pre className="selectable mt-1 max-h-32 overflow-auto rounded bg-bg p-2 text-[11px] whitespace-pre-wrap text-del" data-testid="ai-test-error">{test.error}</pre>
                )}
              </>
            }>
            <Button className="w-full" onClick={() => void runTest()} disabled={test?.busy || !status.ready} data-testid="ai-test">
              {test?.busy ? <Spinner /> : <PlugZap size={13} />} Test
            </Button>
          </SettingsRow>
          <DefaultModel />
          <PromptSettings />
        </>
      ) : (
        <>
          <SettingsRow label="API key" testid="setting-aiApiKey"
            description={
              <>
                {status.hasApiKey ? 'An Anthropic API key is saved.' : 'Paste an Anthropic API key (console.anthropic.com → API keys).'}
                <span className="mt-1 block text-faint">Text features only: resolving conflicts needs an agent, because it edits a file.</span>
                {status.keyInMemoryOnly && (
                  <span className="mt-1 flex items-start gap-1.5 text-warn">
                    <CircleAlert size={13} className="mt-px shrink-0" /> No system keychain was found: the key is kept until GitGoose quits.
                  </span>
                )}
              </>
            }>
            {status.hasApiKey ? (
              <Button className="w-full" onClick={() => void api.aiSetApiKey(null).then(setStatus)}><KeyRound size={13} /> Remove</Button>
            ) : (
              <form className="flex w-full gap-2" onSubmit={(e) => {
                e.preventDefault()
                void api.aiSetApiKey(key).then((s) => {
                  setStatus(s)
                  setKey('')
                })
              }}>
                <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" autoComplete="off" spellCheck={false}
                  aria-label="API key" data-testid="ai-api-key" className="h-8 flex-1 bg-bg font-mono text-xs md:text-xs dark:bg-bg" />
                <Button variant="primary" type="submit" disabled={!key.trim()}>Save</Button>
              </form>
            )}
          </SettingsRow>
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
    <SettingsRow label="Default model" description="Every AI area (Recompose, Review, chats, …) starts with this, and has its own picker to use another agent or model.">
      <ModelPicker defaults fill />
    </SettingsRow>
  )
}
