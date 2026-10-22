import {
  AGENT_PRESETS, agentLabel, defaultTarget, targetKey, targetLabel,
  type AgentPreset, type AiArea, type AiModel, type AiModelList, type AiTarget,
} from '@gitgoose/shared'
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { setAreaTarget } from '../lib/ai'
import { api, toUiError } from '../lib/api'
import { reportError, saveSettings, setSettingEntry, useStore } from '../lib/store'

/**
 * Who answers, and with which model: two small selects. In an AI area (`area`) it edits that
 * area's remembered pick, and "Default" follows Settings → AI. With `defaults` it is Settings →
 * AI's own default model for the configured provider.
 *
 * Model lists. An ACP agent only lists its models inside a session (config option "model"), so
 * main keeps the list from the agent's last session; until there is one, "Load models…" starts
 * the agent to ask (the user clicked, as with Settings → Test). The API's list is a network call,
 * so it too waits for "Load models…", and is then kept while the app runs.
 */
export function ModelPicker({ area, defaults, className, onPicked }: {
  area?: AiArea
  defaults?: boolean
  className?: string
  /** After a pick is saved (Recompose restarts its request on the new pick). */
  onPicked?: () => void
}) {
  const settings = useStore((s) => s.settings)
  const picked = area ? settings?.aiAreaTargets[area] : undefined
  const base = settings ? defaultTarget(settings) : null
  const target = picked ?? base
  const list = useModels(target)
  const [hasKey, setHasKey] = useState(false)
  useEffect(() => void api.aiStatus({ provider: 'anthropic' }).then((s) => setHasKey(s.hasApiKey), () => {}), [])

  if (!settings || !target || !base) return null

  const setModel = (model: string) => {
    if (defaults) {
      // Settings → AI: the API's model setting, or this agent's default (blank: its own).
      if (target.provider === 'anthropic') return void saveSettings({ anthropicModel: model || 'claude-opus-5-5' })
      return void setSettingEntry('aiAgentModel', targetKey(target), model || null)
    }
    const { model: _m, ...who } = target
    void setAreaTarget(area!, model ? { ...who, model } : who).then(onPicked)
  }

  const who = picked ? whoValue(picked) : 'default'
  const setWho = (v: string) => {
    if (v === 'default') return void setAreaTarget(area!, null).then(onPicked)
    const [provider, agent] = v.split(':') as ['agent' | 'anthropic', AgentPreset | undefined]
    void setAreaTarget(area!, provider === 'anthropic' ? { provider } : { provider, agent, ...(agent === 'custom' ? { agentCommand: settings.aiAgentCommand } : {}) }).then(onPicked)
  }

  const offered = list.list?.models ?? []
  // A model that is set but not (or no longer) listed still shows, so the select never lies.
  const models: AiModel[] = target.model && !offered.some((m) => m.id === target.model) ? [{ id: target.model, name: target.model }, ...offered] : offered
  // What blank means here: in an area, Settings → AI's default model for this agent (or the
  // API's model setting); otherwise, or with none set, the agent's own default.
  const settingsDefault = area ? (target.provider === 'anthropic' ? settings.anthropicModel : settings.aiAgentModel[targetKey(target)]) : undefined
  const blankId = settingsDefault || list.list?.defaultModel
  const defaultName = blankId ? offered.find((m) => m.id === blankId)?.name ?? blankId : null
  // Settings → AI's default for the API is a model, not "whatever": no blank entry there.
  const blank = !(defaults && target.provider === 'anthropic')
  const select = 'h-6 max-w-44 truncate rounded-md border border-line bg-bg px-1.5 text-xs text-fg outline-none focus:border-accent disabled:opacity-50'

  return (
    <span className={clsx('inline-flex items-center gap-1', className)} data-testid={area ? `model-picker-${area}` : 'model-picker-default'}>
      {area && (
        <select value={who} onChange={(e) => setWho(e.target.value)} className={select} aria-label="Who answers" data-testid="model-picker-who">
          <option value="default">Default ({targetLabel({ ...base, model: undefined })})</option>
          {(Object.keys(AGENT_PRESETS) as Exclude<AgentPreset, 'custom'>[]).map((p) => <option key={p} value={`agent:${p}`}>{AGENT_PRESETS[p].label}</option>)}
          {settings.aiAgentCommand.trim() && <option value="agent:custom">{agentLabel('custom', settings.aiAgentCommand)}</option>}
          {(hasKey || picked?.provider === 'anthropic') && <option value="anthropic">Anthropic API</option>}
        </select>
      )}
      <select
        value={target.model ?? ''}
        disabled={list.loading || (list.list?.fixed && !target.model)}
        onChange={(e) => (e.target.value === LOAD ? void list.load() : setModel(e.target.value))}
        className={select}
        aria-label="Model"
        title={list.error ?? undefined}
        data-testid="model-picker-model"
      >
        {list.list?.fixed ? <option value="">Chosen by the agent</option> : blank && <option value="">{defaultName ? `Default (${defaultName})` : 'Default model'}</option>}
        {models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.name}</option>)}
        {!list.list?.known && <option value={LOAD}>{list.loading ? 'Loading…' : 'Load models…'}</option>}
      </select>
    </span>
  )
}

const LOAD = '\u0000load'

function whoValue(t: AiTarget): string {
  return t.provider === 'anthropic' ? 'anthropic' : `agent:${t.agent ?? 'claude'}`
}

/** The API's list, once loaded, for the rest of the app's run (by key, so one fetch serves every picker). */
const apiLists = new Map<string, AiModelList>()

/** A target's models: the agent's cached list (main reads it from settings), or the API's once loaded. */
function useModels(target: AiTarget | null): { list: AiModelList | null; loading: boolean; error: string | null; load: () => Promise<void> } {
  const key = target ? targetKey(target) : ''
  const cache = useStore((s) => (target?.provider === 'agent' ? s.settings?.aiAgentModels[key] : undefined))
  // "Who answers" can change while a fetch is pending, and the old target's list must never stand
  // in for the new one's, so associate results with their target key and discard stale completions.
  const [held, setHeld] = useState<{ key: string; list: AiModelList | null }>({ key: '', list: null })
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The key on screen now, read by `load` when its request settles to discard stale completions.
  const current = useRef(key)

  useEffect(() => {
    current.current = key
    setError(null)
    if (!target) return setHeld({ key, list: null })
    // Nothing here starts an agent or calls the network: agents read the cache, the API waits for "Load models…".
    if (target.provider === 'anthropic') return setHeld({ key, list: apiLists.get(key) ?? null })
    let stale = false
    void api.aiModels(target).then(
      (next) => !stale && setHeld({ key, list: next }),
      () => !stale && setHeld({ key, list: null }),
    )
    // A newer run (another target, or a fresher cache entry) supersedes this fetch.
    return () => { stale = true }
    // The cache entry changes when any session reports new models.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cache?.at])

  const load = async () => {
    if (!target) return
    const forKey = key
    setLoadingKey(forKey)
    setError(null)
    try {
      const next = target.provider === 'anthropic' ? await api.aiModels(target) : await api.aiLoadModels(target)
      // The API's list is cached by its own key, so it serves that target later even if stale now.
      if (target.provider === 'anthropic' && next.known) apiLists.set(forKey, next)
      if (current.current !== forKey) return
      setHeld({ key: forKey, list: next })
      if (next.error) setError(next.error)
    } catch (e) {
      if (current.current !== forKey) return
      setError(toUiError(e).message)
      reportError('Could not list the models', e)
    } finally {
      setLoadingKey((k) => (k === forKey ? null : k))
    }
  }
  return { list: held.key === key ? held.list : null, loading: loadingKey === key, error, load }
}
