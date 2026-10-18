/**
 * The version of a build made from a working tree by `pnpm install:local`: the release version plus
 * `-dev.<commit>`, and `.dirty` when there were uncommitted changes. Semver sorts it just below the
 * release of the same number, and the About box shows which commit you are running.
 */
export function localBuildVersion(version: string, commit: string, dirty: boolean): string {
  return `${version}-dev.${commit}${dirty ? '.dirty' : ''}`
}

/** Local builds update by running `pnpm install:local` again, not from GitHub releases. */
export function isLocalBuild(version: string): boolean {
  return /-dev\.[0-9a-f]+/.test(version)
}
