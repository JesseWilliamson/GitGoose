# Releasing

1. Bump `version` in `apps/desktop/package.json` (say `1.0.0-alpha.4`) and commit it.
2. Release that commit, either way (the tag may be `v1.0.0-alpha.4` or `1.0.0-alpha.4`):
   - **Tag from the command line:** `git tag 1.0.0-alpha.4 && git push origin 1.0.0-alpha.4`. The
     Release workflow creates a **draft** release and builds the installers into it; review it
     and publish.
   - **Publish from the GitHub UI** (Releases → Draft a new release, new tag on that commit). The
     Release workflow starts when you publish and attaches the installers about 10 minutes later.
   Either way it first checks the tag matches the version, and fails the run when it does not.
3. Installed copies check for updates about 10 seconds after launch and download the new version
   in the background; it installs when the app quits.

| OS | installers | updates itself |
|---|---|---|
| macOS (Apple silicon) | `.dmg`, `.zip` | signed builds only |
| Windows (x64) | `.exe` (NSIS installer) | yes |
| Linux (x64) | `.AppImage` ([ADR-007](adr/007-linux-packaging.md)) | yes |

To try the installers without releasing, run the workflow by hand (Actions → Release → Run
workflow) and download them from the run's artifacts. Pull requests that change packaging do the
same automatically.

## Signing (optional, but users will see warnings without it)

Add these repository secrets; leave them unset for unsigned builds.

| secret | what |
|---|---|
| `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD` | Developer ID Application certificate, base64 .p12 |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | for notarization; also set `mac.notarize: true` in `apps/desktop/electron-builder.yml` |
| `WIN_CERT_P12_BASE64`, `WIN_CERT_PASSWORD` | Windows code-signing certificate |

Without a Mac certificate the app is signed ad-hoc. macOS then refuses to open a downloaded copy
until you allow it in System Settings → Privacy & Security (or run
`xattr -dr com.apple.quarantine /Applications/GitGoose.app`), and it cannot update itself.
Windows shows a SmartScreen warning for unsigned installers ("More info" → "Run anyway").

## Running your own build

`pnpm install:local` builds your working tree and installs it like a release:

| OS | where |
|---|---|
| macOS | `/Applications/GitGoose.app` (or `~/Applications` if that is not writable); quit GitGoose first |
| Windows | per-user install, silently, into `%LOCALAPPDATA%\Programs\GitGoose` |
| Linux | `~/.local/share/gitgoose/GitGoose.AppImage`, a `gitgoose` command in `~/.local/bin` and a launcher entry |

Run it again to update. The build's version is the release version plus the commit, like
`0.2.0-dev.1a2b3c4` (`.dirty` with uncommitted changes), and such builds do not update from GitHub
releases, which would replace your work with the last release. To go back to releases, install
one over it. `pnpm install:local -- --build-only` stops after building into
`apps/desktop/release/local/`.

## Other local builds

`pnpm dist` builds every installer for your current OS into `apps/desktop/release/`, the same set
the Release workflow publishes. `pnpm --filter @gitgoose/desktop exec electron-builder --dir`
builds an unpacked app (fastest) for testing.

The app icon is `apps/desktop/build/icon.svg`; `icon.png` next to it is what electron-builder
reads (and derives the .icns and .ico from), regenerated with
`rsvg-convert -w 1024 -h 1024 build/icon.svg -o build/icon.png`. On Linux and Windows the window
carries the same file (copied to `resources/` by `extraResources`).

On Linux that is a single AppImage — see [ADR-007](adr/007-linux-packaging.md) for why there is no
deb, rpm or flatpak. It is also the only Linux format electron-updater can update in place, so the
update check described above applies to it and not to anything a distribution might package.
