import Anthropic from '@anthropic-ai/sdk'

/**
 * The fallback for people with no ACP agent: the Anthropic Messages API with their own key.
 * Text in, text out; no tools, so the conflict feature (which edits a file) needs an agent.
 */
export interface CompleteOptions {
  apiKey: string
  model: string
  system: string
  prompt: string
  baseURL?: string
  onText?: (text: string) => void
  signal?: AbortSignal
  fetch?: typeof fetch
}

export async function anthropicComplete(o: CompleteOptions): Promise<string> {
  const client = new Anthropic({ apiKey: o.apiKey, baseURL: o.baseURL, maxRetries: 1, fetch: o.fetch })
  const stream = client.messages.stream(
    { model: o.model, max_tokens: 2048, system: o.system, messages: [{ role: 'user', content: o.prompt }] },
    { signal: o.signal },
  )
  stream.on('text', (_delta, snapshot) => o.onText?.(snapshot))
  const message = await stream.finalMessage()
  return message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
}
