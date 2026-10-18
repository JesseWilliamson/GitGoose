import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * electron-builder decides what goes into the asar by walking `dependencies`, and a peer
 * dependency is not a dependency: nothing declares it, so nothing copies it. The app still runs
 * in development, because pnpm links peers into the virtual store, and then dies on its first
 * import once packaged — which is how `zod`, a peer of @agentclientprotocol/sdk, shipped missing
 * from the AppImage.
 *
 * So: every required peer of a runtime dependency is declared here too.
 */
const appDir = join(import.meta.dirname, '../..')
const modules = join(appDir, 'node_modules')

interface Manifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

function manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
}

const runtime = Object.keys(manifest(appDir).dependencies ?? {})

describe('what the packaged app can resolve', () => {
  it('has every runtime dependency installed where electron-builder looks', () => {
    expect(runtime.length).toBeGreaterThan(0)
    for (const dep of runtime) {
      expect(existsSync(join(modules, dep, 'package.json')), dep).toBe(true)
    }
  })

  it('declares every required peer of every runtime dependency', () => {
    const declared = new Set(runtime)
    const missing: string[] = []
    for (const dep of runtime) {
      const { peerDependencies = {}, peerDependenciesMeta = {} } = manifest(join(modules, dep))
      for (const peer of Object.keys(peerDependencies)) {
        if (peerDependenciesMeta[peer]?.optional) continue
        // Electron is the host the app runs inside, not something it bundles.
        if (peer === 'electron' || peer.startsWith('@types/')) continue
        if (!declared.has(peer)) missing.push(`${dep} needs ${peer}`)
      }
    }
    expect(missing).toEqual([])
  })
})
