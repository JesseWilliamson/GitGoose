import { app } from 'electron'
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Local-only crash and error log. Nothing leaves the machine: the plan rules out network calls
 * we did not ask for, and a git client sees private code paths in every error message.
 */
export function logPath(): string {
  return join(app.getPath('logs'), 'gitsquid.log')
}

export function logError(source: string, message: string): void {
  try {
    const path = logPath()
    mkdirSync(app.getPath('logs'), { recursive: true })
    try {
      // Keep the log small: rotate at 1 MB.
      if (statSync(path).size > 1_000_000) renameSync(path, path + '.1')
    } catch {
      // No log yet.
    }
    appendFileSync(path, `${new Date().toISOString()} [${source}] ${message}\n`)
  } catch {
    // Logging must never crash the app.
  }
}

export function installCrashHandlers(): void {
  process.on('uncaughtException', (e) => logError('main', e.stack ?? String(e)))
  process.on('unhandledRejection', (e) => logError('main', e instanceof Error ? (e.stack ?? e.message) : String(e)))
  app.on('render-process-gone', (_e, _wc, details) => logError('renderer', `gone: ${details.reason} (exit ${details.exitCode})`))
  app.on('child-process-gone', (_e, details) => logError('child', `${details.type} gone: ${details.reason}`))
}
