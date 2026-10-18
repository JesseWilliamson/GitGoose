# Releasing

1. Bump `version` in `apps/desktop/package.json`.
2. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The Release workflow checks the tag matches the version, creates a **draft** GitHub release,
   and builds installers on macOS, Windows and Linux into it. Review it and publish.
4. Installed copies check for updates about 10 seconds after launch and download the new version
   in the background; it installs when the app quits.

| OS | installers | updates itself |
|---|---|---|
| macOS (Apple silicon) | `.dmg`, `.zip` | signed builds only |
| Windows (x64) | `.exe` (NSIS installer) | yes |
| Linux (x64) | `.AppImage`, `.deb` | yes (the deb asks for your password) |

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
`xattr -dr com.apple.quarantine /Applications/GitSquid.app`), and it cannot update itself.
Windows shows a SmartScreen warning for unsigned installers ("More info" → "Run anyway").

## Running your own build

`pnpm install:local` builds your working tree and installs it like a release:

| OS | where |
|---|---|
| macOS | `/Applications/GitSquid.app` (or `~/Applications` if that is not writable); quit GitSquid first |
| Windows | per-user install, silently, into `%LOCALAPPDATA%\Programs\GitSquid` |
| Linux | `~/.local/share/gitsquid/GitSquid.AppImage`, a `gitsquid` command in `~/.local/bin` and a launcher entry |

Run it again to update. The build's version is the release version plus the commit, like
`0.2.0-dev.1a2b3c4` (`.dirty` with uncommitted changes), and such builds do not update from GitHub
releases, which would replace your work with the last release. To go back to releases, install
one over it. `pnpm install:local -- --build-only` stops after building into
`apps/desktop/release/local/`.

## Other local builds

`pnpm dist` builds this OS's release installers into `apps/desktop/release/`.
`pnpm --filter @gitsquid/desktop exec electron-builder --dir` builds an unpacked app (fast) for testing.
