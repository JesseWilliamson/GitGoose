import { API_METHODS, IPC_EVENT, IPC_INVOKE, type GitSquidApi, type GitSquidEvent, type IpcResult, type SerializedError } from '@gitsquid/shared'
import { contextBridge, ipcRenderer } from 'electron'

/**
 * The only bridge between the web page and Node. Nothing from Node leaks through: the page gets
 * plain async functions that send (method, args) over one channel, plus an event subscription.
 *
 * The client is built from API_METHODS, so it always matches the GitSquidApi interface.
 */
class GitSquidError extends Error {
  stderr?: string
  command?: string
  constructor(e: SerializedError) {
    super(e.message)
    this.stderr = e.stderr
    this.command = e.command
  }
}

const api = {} as Record<string, (...args: unknown[]) => Promise<unknown>>
for (const method of API_METHODS) {
  api[method] = async (...args: unknown[]) => {
    const res = (await ipcRenderer.invoke(IPC_INVOKE, method, args)) as IpcResult<unknown>
    if (res.ok) return res.value
    // contextBridge copies errors as plain objects; keep the fields the UI shows.
    throw new GitSquidError(res.error)
  }
}

const bridge = {
  ...(api as unknown as GitSquidApi),
  platform: process.platform,
  onEvent(listener: (event: GitSquidEvent) => void): () => void {
    const wrapped = (_: unknown, event: GitSquidEvent) => listener(event)
    ipcRenderer.on(IPC_EVENT, wrapped)
    return () => ipcRenderer.removeListener(IPC_EVENT, wrapped)
  },
}

export type Bridge = typeof bridge

contextBridge.exposeInMainWorld('gitsquid', bridge)
