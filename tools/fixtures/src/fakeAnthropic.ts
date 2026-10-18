import { createServer, type Server } from 'node:http'

/**
 * A local stand-in for the Anthropic Messages API: answers POST /v1/messages with a streamed
 * reply (server-sent events, the same event sequence the real API sends). Tests point the app
 * at it with GITGOOSE_ANTHROPIC_BASE_URL.
 */
export interface FakeAnthropic {
  url: string
  server: Server
  /** Request bodies received, parsed. */
  requests: { model: string; system?: string; messages: { role: string; content: string }[]; headers: Record<string, string | string[] | undefined> }[]
  close(): Promise<void>
}

export async function fakeAnthropic(reply: string[] = ['Fix: ', 'retry the push.'], status = 200): Promise<FakeAnthropic> {
  const requests: FakeAnthropic['requests'] = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.writeHead(404).end()
      return
    }
    requests.push({ ...JSON.parse(raw), headers: req.headers })
    if (status !== 200) {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    send('message_start', {
      type: 'message_start',
      message: { id: 'msg_fake', type: 'message', role: 'assistant', content: [], model: 'fake', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
    })
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (const text of reply) send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: reply.length } })
    send('message_stop', { type: 'message_stop' })
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    server,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
