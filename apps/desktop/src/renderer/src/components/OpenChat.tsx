import { MessagesSquare } from 'lucide-react'
import { openInPanel } from '../lib/ai'
import { Button } from './ui'

/**
 * Take the conversation a result came from to the AI pane.
 *
 * Results used to carry a chat of their own in a rail beside them, which meant two places to
 * talk to the AI and two histories to keep straight. There is one chat now, it is the AI pane,
 * and every result is already a turn in it: this button only moves the pane to the
 * right conversation. Nothing is shown when the result has no conversation — an impact nobody
 * has asked the model about yet.
 */
export function OpenChatButton({ repoId, threadId }: { repoId: string; threadId: string | null | undefined }) {
  if (!threadId) return null
  return (
    <Button onClick={() => openInPanel(repoId, threadId)} data-testid="open-chat" title="Show this conversation in the AI pane">
      <MessagesSquare size={13} /> Chat
    </Button>
  )
}
