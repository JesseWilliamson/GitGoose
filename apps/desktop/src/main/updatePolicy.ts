import { isLocalBuild } from '@gitgoose/shared'

/**
 * Whether to ask GitHub for a newer release. Dev runs (`pnpm dev`) are not packaged, and a local
 * build would be replaced by the latest release, which is usually behind your working tree.
 */
export function shouldCheckForUpdates(o: { packaged: boolean; version: string; disabledByEnv: boolean; enabled: boolean }): boolean {
  return o.packaged && o.enabled && !o.disabledByEnv && !isLocalBuild(o.version)
}
