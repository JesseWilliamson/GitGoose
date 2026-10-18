import type { AiActivity } from '@gitsquid/shared'

/** Thinking can run to many thousands of characters; the card only shows the end of it. */
const THOUGHT_MAX = 2000
/** Tool calls kept for the card (the latest ones). */
const TOOLS_MAX = 12

export type ToolStatus = AiActivity['tools'][number]['status']

/**
 * One AI request's progress, for the card in the renderer. Every change schedules an emit; at
 * most one goes out per `interval`, carrying the whole (small) state, so a fast agent streaming
 * its thinking a few characters at a time costs a handful of IPC messages a second, not hundreds.
 */
export class ActivityTracker {
  private a: AiActivity = { step: '', thought: '', tools: [], plan: [], chars: 0 }
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(private emit: (a: AiActivity) => void, private interval = 100) {}

  /** GitSquid's own steps go out at once: they are few, and the first one should show quickly. */
  step(step: string): void {
    this.a.step = step
    this.flush()
  }

  thought(text: string): void {
    this.a.step = 'Thinking'
    this.a.thought = text.length > THOUGHT_MAX ? '…' + text.slice(-THOUGHT_MAX) : text
    this.schedule()
  }

  /** A tool call started or changed (fields left out keep their value). */
  tool(id: string, title?: string | null, status?: ToolStatus | null): void {
    let t = this.a.tools.find((x) => x.id === id)
    if (!t) {
      t = { id, title: title || 'Using a tool', status: status ?? 'pending' }
      this.a.tools = [...this.a.tools, t].slice(-TOOLS_MAX)
    } else {
      if (title) t.title = title
      if (status) t.status = status
    }
    // The step follows the tool that is working; a finished one hands back to "Thinking".
    this.a.step = t.status === 'completed' || t.status === 'failed' ? 'Thinking' : t.title
    this.schedule()
  }

  plan(entries: AiActivity['plan']): void {
    this.a.plan = entries
    this.schedule()
  }

  writing(chars: number): void {
    this.a.step = 'Writing the answer'
    this.a.chars = chars
    this.schedule()
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => this.flush(), this.interval)
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.closed) return
    // A copy: the receiver may keep it, and we keep changing ours.
    this.emit({ ...this.a, tools: this.a.tools.map((t) => ({ ...t })), plan: [...this.a.plan] })
  }
}
