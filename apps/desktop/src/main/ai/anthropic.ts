import Anthropic from '@anthropic-ai/sdk'

/**
 * The fallback for people with no ACP agent: the Anthropic Messages API with their own key.
 * Text in, text out; no tools, so the conflict feature (which edits a file) needs an agent, and
 * a thread in this mode never shows tool cards. The API keeps no session: a thread resends its
 * whole conversation each turn (see AiService.outgoing).
 */
export interface ChatOptions {
  apiKey: string
  model: string
  system: string
  /** The conversation, oldest first, ending with the new user message. */
  messages: { role: 'user' | 'assistant'; content: string }[]
  /** The reply's length limit (Settings → AI → Longest answer). */
  maxTokens?: number
  baseURL?: string
  /** The reply so far, after each streamed chunk, and the chunk itself. */
  onText?: (snapshot: string, delta: string) => void
  signal?: AbortSignal
  fetch?: typeof fetch
}

export async function anthropicChat(o: ChatOptions): Promise<string> {
  const client = new Anthropic({ apiKey: o.apiKey, baseURL: o.baseURL, maxRetries: 1, fetch: o.fetch })
  const stream = client.messages.stream(
    { model: o.model, max_tokens: o.maxTokens ?? 8192, system: o.system, messages: o.messages },
    { signal: o.signal },
  )
  stream.on('text', (delta, snapshot) => o.onText?.(snapshot, delta))
  const message = await stream.finalMessage()
  return message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

/**
 * The models this key can use (GET /v1/models), newest first as the API returns them. Only
 * called when the user opens a model picker for the API: it sends nothing but the key.
 */
export async function anthropicModels(o: { apiKey: string; baseURL?: string; fetch?: typeof fetch; signal?: AbortSignal }): Promise<{ id: string; name: string }[]> {
  const client = new Anthropic({ apiKey: o.apiKey, baseURL: o.baseURL, maxRetries: 1, fetch: o.fetch })
  const out: { id: string; name: string }[] = []
  // The list pages itself; 100 is far more than one key has today, so this stops at the first page or two.
  for await (const m of client.models.list({ limit: 100 }, { signal: o.signal })) {
    out.push({ id: m.id, name: m.display_name || m.id })
    if (out.length >= 200) break
  }
  return out
}
