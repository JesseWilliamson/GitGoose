import type { GitGooseApi, GitGooseEvent } from '@gitgoose/shared'

declare global {
  interface Window {
    gitgoose: GitGooseApi & {
      platform: string
      onEvent(listener: (event: GitGooseEvent) => void): () => void
    }
  }
}

export {}
