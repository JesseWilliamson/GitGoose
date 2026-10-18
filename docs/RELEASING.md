# Releasing

1. Bump `version` in `apps/desktop/package.json`.
2. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The Release workflow builds installers on macOS, Windows and Linux and attaches them to a
   **draft** GitHub release. Review it and publish.
4. Installed copies check for updates about 10 seconds after launch (packaged builds only) and
   offer the new version when it is downloaded.

## Signing (optional, but users will see warnings without it)

Add these repository secrets; leave them unset for unsigned builds.

| secret | what |
|---|---|
| `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD` | Developer ID Application certificate, base64 .p12 |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | for notarization; also set `mac.notarize: true` in `apps/desktop/electron-builder.yml` |
| `WIN_CERT_P12_BASE64`, `WIN_CERT_PASSWORD` | Windows code-signing certificate |

macOS auto-update only works for signed builds.

## Local builds

`pnpm dist` builds every installer for your current OS into `apps/desktop/release/`, the same
set the Release workflow publishes. `pnpm dist:appimage` builds only the AppImage, and
`pnpm --filter @gitsquid/desktop exec electron-builder --dir` an unpacked app (fastest) for testing.

### The deb target does not build on Arch

The `deb` target shells out to fpm, a Ruby tool electron-builder downloads, and that prebuilt Ruby
is linked against `libcrypt.so.1`. Arch has moved to libxcrypt (`libcrypt.so.2`), so `pnpm dist`
fails there with `ruby: error while loading shared libraries`. Nothing is wrong with the project
config, and a symlink does not help — the old glibc symbol versions are genuinely absent.

Use `pnpm dist:appimage` for local Linux builds and let the Release workflow produce the deb; it
runs on `ubuntu-latest`, which has the library. To build a deb on Arch anyway, install the
compatibility package (`sudo pacman -S libxcrypt-compat`) or point electron-builder at your own
fpm (`gem install --user-install fpm`, then `USE_SYSTEM_FPM=true pnpm dist`).
