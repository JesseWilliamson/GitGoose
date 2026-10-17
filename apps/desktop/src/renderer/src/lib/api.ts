/** The preload bridge (see src/preload/index.ts). Every call is async and goes to the main process. */
export const api = window.gitsquid

export interface UiError {
  message: string
  stderr?: string
  command?: string
}

export function toUiError(e: unknown): UiError {
  if (e && typeof e === 'object' && 'message' in e) {
    const x = e as { message: string; stderr?: string; command?: string }
    // Electron prefixes errors that cross IPC; strip it if present.
    return { message: x.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), stderr: x.stderr, command: x.command }
  }
  return { message: String(e) }
}
