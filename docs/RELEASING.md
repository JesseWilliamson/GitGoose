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

`pnpm dist` builds installers for your current OS into `apps/desktop/release/`.
`pnpm --filter @gitsquid/desktop exec electron-builder --dir` builds an unpacked app (fast) for testing.
