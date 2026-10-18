import { API_METHODS, IPC_EVENT, IPC_INVOKE, type GitGooseApi, type GitGooseEvent, type IpcResult, type SerializedError } from '@gitgoose/shared'
import { contextBridge, ipcRenderer } from 'electron'

/**
 * The only bridge between the web page and Node. Nothing from Node leaks through: the page gets
 * plain async functions that send (method, args) over one channel, plus an event subscription.
 *
 * The client is built from API_METHODS, so it always matches the GitGooseApi interface.
 */

const api = {} as Record<string, (...args: unknown[]) => Promise<unknown>>
for (const method of API_METHODS) {
  api[method] = async (...args: unknown[]) => {
    const res = (await ipcRenderer.invoke(IPC_INVOKE, method, args)) as IpcResult<unknown>
    if (res.ok) return res.value
    // Reject with a plain object, not an Error: contextBridge copies only `message` from Error
    // instances, which would drop git's stderr. Plain objects are copied whole.
    const error: SerializedError & { name: string } = { name: 'GitGooseError', ...res.error }
    throw error
  }
}

const bridge = {
  ...(api as unknown as GitGooseApi),
  platform: process.platform,
  onEvent(listener: (event: GitGooseEvent) => void): () => void {
    const wrapped = (_: unknown, event: GitGooseEvent) => listener(event)
    ipcRenderer.on(IPC_EVENT, wrapped)
    return () => ipcRenderer.removeListener(IPC_EVENT, wrapped)
  },
}

export type Bridge = typeof bridge

contextBridge.exposeInMainWorld('gitgoose', bridge)
