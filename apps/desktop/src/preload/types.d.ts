import type { GitSquidApi, GitSquidEvent } from '@gitsquid/shared'

declare global {
  interface Window {
    gitsquid: GitSquidApi & {
      platform: string
      onEvent(listener: (event: GitSquidEvent) => void): () => void
    }
  }
}

export {}
